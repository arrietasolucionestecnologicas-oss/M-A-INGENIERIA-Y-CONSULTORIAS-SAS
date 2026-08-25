/**
 * ============================================================================
 * M&A INGENIERÍA Y CONSULTORÍA SAS — API de Gestión de Pruebas de Transformadores
 * Backend: Google Apps Script (router) + Google Sheets (base de datos)
 *          + Google Drive (almacenamiento de archivos)
 * ============================================================================
 *
 * DESPLIEGUE
 *  1. Pega este archivo como Código.gs en un proyecto de Apps Script vinculado
 *     (contenedor) a la hoja de cálculo que hará de base de datos.
 *  2. Ejecuta manualmente ensureAllSheets_() una vez desde el editor para crear
 *     las pestañas con sus encabezados (también se auto-crean en cada petición
 *     por si acaso, pero así puedes revisarlas antes de exponer el Web App).
 *  3. En Configuración del proyecto > Propiedades del script, agrega la
 *     propiedad ADMIN_MASTER_TOKEN con un valor secreto (se usa para la única
 *     acción administrativa: createClient).
 *  4. Implementar > Nueva implementación > Aplicación web.
 *     Ejecutar como: Yo. Quién tiene acceso: Cualquier usuario.
 *
 * NOTA IMPORTANTE SOBRE CÓDIGOS HTTP
 *  Google Apps Script (ContentService) no permite fijar el código de estado
 *  HTTP real de la respuesta: el transporte siempre entrega 200. Por eso el
 *  contrato de esta API va el campo "status" DENTRO del cuerpo JSON (tal como
 *  pide la directriz 402/429): el cliente debe leer body.status, nunca confiar
 *  en el código HTTP de la respuesta.
 *
 * NOTA SOBRE CORS EN doPost
 *  Si el frontend llama con fetch() desde un navegador, para evitar el
 *  preflight de CORS conviene enviar el body con
 *  Content-Type: text/plain;charset=utf-8 (aunque el contenido sea JSON).
 *  Por eso parseParams_ intenta parsear e.postData.contents como JSON sin
 *  depender del content-type declarado.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Configuración y mapeo de encabezados (evita depender de letras de columna)
// ---------------------------------------------------------------------------

var SHEET_NAMES = {
  CLIENTES: 'Clientes',
  TRANSFORMADORES: 'Transformadores',
  PRUEBAS: 'Pruebas'
};

var HEADERS = {
  CLIENTES: ['tenant_slug', 'company_name', 'is_active', 'plan', 'created_at'],
  TRANSFORMADORES: [
    'id', 'tenant_slug', 'site_id', 'serial_number', 'manufacturer', 'manufacture_year',
    'phase_type', 'vector_group', 'hv_nominal_voltage', 'lv_nominal_voltage',
    'tap_config_json', 'is_special_design', 'custom_tap_ratio_matrix_json',
    'status', 'plate_photo_file_id', 'created_at', 'updated_at'
  ],
  PRUEBAS: [
    'id', 'tenant_slug', 'transformer_id', 'test_type', 'raw_readings_json',
    'calculated_results_json', 'verdict', 'instrument_used', 'tested_by',
    'attachment_file_id', 'created_at'
  ]
};

var ATTACHMENTS_FOLDER_NAME = 'TMS_Adjuntos';
var TOLERANCE_PERCENT = 0.5;
var UNBALANCE_THRESHOLD_PERCENT = 5.0;

/** Factor de relación línea-línea por grupo de conexión (ver TtrCalculator.kt en el backend Ktor). */
var VECTOR_GROUP_MULTIPLIERS = {
  Dyn11: Math.sqrt(3), Dyn5: Math.sqrt(3), Dyn1: Math.sqrt(3), Dyn7: Math.sqrt(3),
  Yyn0: 1, Yyn6: 1, Dd0: 1,
  Yd1: 1 / Math.sqrt(3), Yd11: 1 / Math.sqrt(3),
  Ynd1: 1 / Math.sqrt(3), Ynd11: 1 / Math.sqrt(3)
};

/** Acciones que NO pasan por el Kill Switch automático (ellas resuelven su propia autorización). */
var PUBLIC_ACTIONS = { createClient: true };

// ---------------------------------------------------------------------------
// Entradas HTTP
// ---------------------------------------------------------------------------

function doGet(e) {
  return routeRequest_(e, 'GET');
}

function doPost(e) {
  return routeRequest_(e, 'POST');
}

/**
 * Router principal. Orquesta: parseo de parámetros, Kill Switch (directriz 5)
 * y despacho a la función específica según ?action=. Las funciones de
 * escritura (POST_ACTIONS) aplican su propio LockService internamente
 * (directriz 1); las de lectura (GET_ACTIONS) no lo necesitan.
 */
function routeRequest_(e, method) {
  try {
    ensureAllSheets_();

    var params = parseParams_(e);
    var action = params.action;
    if (!action) {
      return jsonResponse_({ status: 400, message: 'Falta el parámetro action' });
    }

    var actionsMap = (method === 'GET') ? GET_ACTIONS : POST_ACTIONS;
    var handler = actionsMap[action];
    if (!handler) {
      return jsonResponse_({ status: 404, message: 'Acción no reconocida: ' + action });
    }

    var tenant = null;
    if (!PUBLIC_ACTIONS[action]) {
      // ---- Kill Switch SaaS (directriz 5): primera acción real del script ----
      if (!params.tenant_slug) {
        return jsonResponse_({ status: 400, message: 'tenant_slug es obligatorio en todo payload' });
      }
      tenant = findTenantBySlug_(params.tenant_slug);
      if (!tenant) {
        return jsonResponse_({ status: 404, message: 'Cliente no reconocido: ' + params.tenant_slug });
      }
      if (!isTruthy_(tenant.is_active)) {
        return jsonResponse_({ status: 402, message: 'Servicio suspendido' });
      }
    }

    return handler(params, tenant);
  } catch (err) {
    return jsonResponse_({ status: 500, message: 'Error interno: ' + (err && err.message ? err.message : err) });
  }
}

/** Une query string (e.parameter) y cuerpo JSON (e.postData.contents), sin depender del content-type declarado. */
function parseParams_(e) {
  var params = {};
  if (e && e.parameter) {
    for (var k in e.parameter) params[k] = e.parameter[k];
  }
  if (e && e.postData && e.postData.contents) {
    try {
      var body = JSON.parse(e.postData.contents);
      for (var k2 in body) params[k2] = body[k2];
    } catch (parseErr) {
      // El cuerpo no era JSON válido (o venía vacío): se continúa solo con la query string.
    }
  }
  return params;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Concurrencia (directriz 1)
// ---------------------------------------------------------------------------

/**
 * Envuelve toda función de escritura en LockService.getScriptLock().tryLock(10000).
 * Si no se obtiene el bloqueo en 10s, responde 429 en el cuerpo JSON.
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try {
    gotLock = lock.tryLock(10000);
    if (!gotLock) {
      return jsonResponse_({ status: 429, message: 'El sistema está ocupado escribiendo otro registro, intenta de nuevo en unos segundos' });
    }
    return fn();
  } catch (err) {
    return jsonResponse_({ status: 500, message: 'Error interno: ' + (err && err.message ? err.message : err) });
  } finally {
    if (gotLock) lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Acceso a Sheets (mapeo de índices de columnas — directriz 2)
// ---------------------------------------------------------------------------

function ensureAllSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (key) {
    var sheet = ss.getSheetByName(SHEET_NAMES[key]);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAMES[key]);
      sheet.appendRow(HEADERS[key]);
      sheet.setFrozenRows(1);
    }
  });
}

function getSheet_(entityKey) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES[entityKey]);
  if (!sheet) {
    ensureAllSheets_();
    sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES[entityKey]);
  }
  return sheet;
}

/** Índice de columna 1-based para usar con getRange(row, col) — nunca letras fijas. */
function colIndex_(entityKey, fieldName) {
  var idx = HEADERS[entityKey].indexOf(fieldName);
  if (idx === -1) throw new Error('Campo desconocido "' + fieldName + '" en ' + entityKey);
  return idx + 1;
}

function rowToObject_(rowArray, entityKey, rowNumber) {
  var headers = HEADERS[entityKey];
  var obj = { _row: rowNumber };
  headers.forEach(function (h, i) { obj[h] = rowArray[i]; });
  return obj;
}

function appendRow_(entityKey, rowObject) {
  var sheet = getSheet_(entityKey);
  var headers = HEADERS[entityKey];
  var row = headers.map(function (h) {
    var v = rowObject[h];
    return (v === undefined || v === null) ? '' : v;
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function generateId_() {
  return Utilities.getUuid();
}

function isTruthy_(v) {
  if (typeof v === 'boolean') return v;
  var s = String(v).trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'SI' || s === 'YES';
}

function safeParseJson_(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Clientes (tenants) — Kill Switch
// ---------------------------------------------------------------------------

function findTenantBySlug_(slug) {
  var sheet = getSheet_('CLIENTES');
  var data = sheet.getDataRange().getValues();
  var slugCol = HEADERS.CLIENTES.indexOf('tenant_slug');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][slugCol]).trim() === String(slug).trim()) {
      return rowToObject_(data[r], 'CLIENTES', r + 1);
    }
  }
  return null;
}

/** Única acción administrativa: crea un tenant. Gateada por ADMIN_MASTER_TOKEN (Propiedades del script), no por el Kill Switch. */
function createClient_(params) {
  return withLock_(function () {
    var masterToken = PropertiesService.getScriptProperties().getProperty('ADMIN_MASTER_TOKEN');
    if (!masterToken || params.admin_token !== masterToken) {
      return jsonResponse_({ status: 403, message: 'Token de administrador inválido' });
    }
    if (!params.tenant_slug || !params.company_name) {
      return jsonResponse_({ status: 400, message: 'tenant_slug y company_name son obligatorios' });
    }
    if (findTenantBySlug_(params.tenant_slug)) {
      return jsonResponse_({ status: 409, message: 'El tenant_slug ya existe: ' + params.tenant_slug });
    }

    appendRow_('CLIENTES', {
      tenant_slug: params.tenant_slug,
      company_name: params.company_name,
      is_active: true,
      plan: params.plan || 'BASIC',
      created_at: new Date().toISOString()
    });

    return jsonResponse_({ status: 201, message: 'Cliente creado', data: { tenant_slug: params.tenant_slug } });
  });
}

// ---------------------------------------------------------------------------
// Transformadores
// ---------------------------------------------------------------------------

function findTransformerRow_(tenantSlug, id) {
  var sheet = getSheet_('TRANSFORMADORES');
  var data = sheet.getDataRange().getValues();
  var tenantCol = HEADERS.TRANSFORMADORES.indexOf('tenant_slug');
  var idCol = HEADERS.TRANSFORMADORES.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (data[r][idCol] === id && data[r][tenantCol] === tenantSlug) {
      return rowToObject_(data[r], 'TRANSFORMADORES', r + 1);
    }
  }
  return null;
}

function transformerRowToJson_(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    serial_number: row.serial_number,
    manufacturer: row.manufacturer,
    manufacture_year: row.manufacture_year,
    phase_type: row.phase_type,
    vector_group: row.vector_group,
    hv_nominal_voltage: row.hv_nominal_voltage,
    lv_nominal_voltage: row.lv_nominal_voltage,
    tap_config: safeParseJson_(row.tap_config_json),
    is_special_design: isTruthy_(row.is_special_design),
    custom_tap_ratio_matrix: safeParseJson_(row.custom_tap_ratio_matrix_json),
    status: row.status,
    plate_photo_url: row.plate_photo_file_id ? driveFileUrl_(row.plate_photo_file_id) : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function createTransformer_(params, tenant) {
  return withLock_(function () {
    if (!params.serial_number || !params.phase_type) {
      return jsonResponse_({ status: 400, message: 'serial_number y phase_type son obligatorios' });
    }

    var id = generateId_();
    var attachmentId = '';
    if (params.file_base64) {
      var saved = saveFileToDrive_(
        stripBase64Prefix_(params.file_base64),
        'placa_' + params.serial_number + '_' + Date.now(),
        params.file_mime_type || 'image/jpeg'
      );
      attachmentId = saved.fileId;
    }

    appendRow_('TRANSFORMADORES', {
      id: id,
      tenant_slug: tenant.tenant_slug,
      site_id: params.site_id || '',
      serial_number: params.serial_number,
      manufacturer: params.manufacturer || '',
      manufacture_year: params.manufacture_year || '',
      phase_type: params.phase_type,
      vector_group: params.vector_group || '',
      hv_nominal_voltage: params.hv_nominal_voltage || '',
      lv_nominal_voltage: params.lv_nominal_voltage || '',
      tap_config_json: JSON.stringify(params.tap_config || {}),
      is_special_design: !!params.is_special_design,
      custom_tap_ratio_matrix_json: params.custom_tap_ratio_matrix ? JSON.stringify(params.custom_tap_ratio_matrix) : '',
      status: 'ACTIVO',
      plate_photo_file_id: attachmentId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return jsonResponse_({ status: 201, message: 'Transformador creado', data: { id: id } });
  });
}

/** POST de actualización (Apps Script Web Apps no tienen verbo PATCH nativo). Solo escribe los campos presentes en el payload. */
function updateTransformer_(params, tenant) {
  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });

    var row = findTransformerRow_(tenant.tenant_slug, params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });

    var updates = {};
    ['serial_number', 'manufacturer', 'manufacture_year', 'phase_type', 'vector_group',
      'hv_nominal_voltage', 'lv_nominal_voltage', 'status', 'site_id'].forEach(function (field) {
      if (params[field] !== undefined) updates[field] = params[field];
    });
    if (params.tap_config !== undefined) updates.tap_config_json = JSON.stringify(params.tap_config);
    if (params.custom_tap_ratio_matrix !== undefined) updates.custom_tap_ratio_matrix_json = JSON.stringify(params.custom_tap_ratio_matrix);
    if (params.is_special_design !== undefined) updates.is_special_design = !!params.is_special_design;

    if (params.file_base64) {
      var saved = saveFileToDrive_(
        stripBase64Prefix_(params.file_base64),
        'placa_' + row.serial_number + '_' + Date.now(),
        params.file_mime_type || 'image/jpeg'
      );
      updates.plate_photo_file_id = saved.fileId;
    }

    updates.updated_at = new Date().toISOString();

    var sheet = getSheet_('TRANSFORMADORES');
    Object.keys(updates).forEach(function (field) {
      sheet.getRange(row._row, colIndex_('TRANSFORMADORES', field)).setValue(updates[field]);
    });

    return jsonResponse_({ status: 200, message: 'Transformador actualizado' });
  });
}

function listTransformers_(params, tenant) {
  var sheet = getSheet_('TRANSFORMADORES');
  var data = sheet.getDataRange().getValues();
  var tenantCol = HEADERS.TRANSFORMADORES.indexOf('tenant_slug');
  var siteCol = HEADERS.TRANSFORMADORES.indexOf('site_id');
  var result = [];
  for (var r = 1; r < data.length; r++) {
    if (data[r][tenantCol] !== tenant.tenant_slug) continue;
    if (params.site_id && data[r][siteCol] !== params.site_id) continue;
    result.push(transformerRowToJson_(rowToObject_(data[r], 'TRANSFORMADORES', r + 1)));
  }
  return jsonResponse_({ status: 200, data: result });
}

function getTransformer_(params, tenant) {
  if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
  var row = findTransformerRow_(tenant.tenant_slug, params.id);
  if (!row) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
  return jsonResponse_({ status: 200, data: transformerRowToJson_(row) });
}

// ---------------------------------------------------------------------------
// Pruebas (TTR / Resistencia de devanados / Aislamiento)
// ---------------------------------------------------------------------------

function persistTest_(tenant, transformer, testType, rawReadings, calculated, params) {
  var attachmentId = '';
  if (params.file_base64) {
    var saved = saveFileToDrive_(
      stripBase64Prefix_(params.file_base64),
      testType.toLowerCase() + '_' + transformer.serial_number + '_' + Date.now(),
      params.file_mime_type || 'application/octet-stream'
    );
    attachmentId = saved.fileId;
  }

  var id = generateId_();
  appendRow_('PRUEBAS', {
    id: id,
    tenant_slug: tenant.tenant_slug,
    transformer_id: transformer.id,
    test_type: testType,
    raw_readings_json: JSON.stringify(rawReadings),
    calculated_results_json: JSON.stringify(calculated),
    verdict: calculated.overallVerdict,
    instrument_used: params.instrument_used || '',
    tested_by: params.tested_by || '',
    attachment_file_id: attachmentId,
    created_at: new Date().toISOString()
  });

  return { id: id, calculated_results: calculated };
}

function submitTtrTest_(params, tenant) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(tenant.tenant_slug, params.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
    if (!params.readings || !params.readings.measurements) {
      return jsonResponse_({ status: 400, message: 'readings.measurements es obligatorio' });
    }

    var calculated;
    try {
      calculated = calculateTtr_(transformer, params.readings);
    } catch (calcErr) {
      return jsonResponse_({ status: 422, message: calcErr.message });
    }

    var saved = persistTest_(tenant, transformer, 'TTR', params.readings, calculated, params);
    return jsonResponse_({ status: 201, message: 'Prueba TTR registrada', data: saved });
  });
}

function submitWindingResistanceTest_(params, tenant) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(tenant.tenant_slug, params.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
    if (!params.readings || !params.readings.measurements) {
      return jsonResponse_({ status: 400, message: 'readings.measurements es obligatorio' });
    }

    var calculated;
    try {
      calculated = calculateWindingResistance_(params.readings);
    } catch (calcErr) {
      return jsonResponse_({ status: 422, message: calcErr.message });
    }

    var saved = persistTest_(tenant, transformer, 'RESISTENCIA_DEVANADOS', params.readings, calculated, params);
    return jsonResponse_({ status: 201, message: 'Prueba de resistencia de devanados registrada', data: saved });
  });
}

function submitInsulationTest_(params, tenant) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(tenant.tenant_slug, params.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
    if (!params.readings || !params.readings.measurements) {
      return jsonResponse_({ status: 400, message: 'readings.measurements es obligatorio' });
    }

    var calculated;
    try {
      calculated = calculateInsulation_(params.readings);
    } catch (calcErr) {
      return jsonResponse_({ status: 422, message: calcErr.message });
    }

    var saved = persistTest_(tenant, transformer, 'AISLAMIENTO', params.readings, calculated, params);
    return jsonResponse_({ status: 201, message: 'Prueba de aislamiento registrada', data: saved });
  });
}

function listTests_(params, tenant) {
  var sheet = getSheet_('PRUEBAS');
  var data = sheet.getDataRange().getValues();
  var tenantCol = HEADERS.PRUEBAS.indexOf('tenant_slug');
  var transformerCol = HEADERS.PRUEBAS.indexOf('transformer_id');
  var result = [];
  for (var r = 1; r < data.length; r++) {
    if (data[r][tenantCol] !== tenant.tenant_slug) continue;
    if (params.transformer_id && data[r][transformerCol] !== params.transformer_id) continue;
    var obj = rowToObject_(data[r], 'PRUEBAS', r + 1);
    result.push({
      id: obj.id,
      transformer_id: obj.transformer_id,
      test_type: obj.test_type,
      raw_readings: safeParseJson_(obj.raw_readings_json),
      calculated_results: safeParseJson_(obj.calculated_results_json),
      verdict: obj.verdict,
      instrument_used: obj.instrument_used,
      tested_by: obj.tested_by,
      attachment_url: obj.attachment_file_id ? driveFileUrl_(obj.attachment_file_id) : null,
      created_at: obj.created_at
    });
  }
  return jsonResponse_({ status: 200, data: result });
}

// ---------------------------------------------------------------------------
// Cálculo híbrido de TTR (réplica de TtrCalculator.kt del backend Ktor)
// ---------------------------------------------------------------------------

function calculateTtr_(transformer, readings) {
  var tapConfig = safeParseJson_(transformer.tap_config_json) || {};
  var usesCustomMatrix = isTruthy_(transformer.is_special_design) || transformer.vector_group === 'CUSTOM';
  var customMatrix = safeParseJson_(transformer.custom_tap_ratio_matrix_json);

  if (usesCustomMatrix && !customMatrix) {
    throw new Error('El transformador está marcado como diseño especial o grupo CUSTOM pero no tiene custom_tap_ratio_matrix configurada');
  }

  var multiplier = 1;
  if (!usesCustomMatrix && transformer.vector_group) {
    multiplier = VECTOR_GROUP_MULTIPLIERS[transformer.vector_group];
    if (multiplier === undefined) throw new Error('Grupo de conexión desconocido: ' + transformer.vector_group);
  }

  var matrixByTap = {};
  if (customMatrix && customMatrix.taps) {
    customMatrix.taps.forEach(function (t) { matrixByTap[t.tapPosition] = t; });
  }

  var measurementKeys = Object.keys(readings.measurements || {});
  if (measurementKeys.length === 0) throw new Error('Debe incluir al menos una lectura de TAP para calcular el TTR');

  var taps = {};
  measurementKeys.forEach(function (tapPosStr) {
    var tapPosition = parseInt(tapPosStr, 10);
    var tapCfg = (tapConfig.positions || []).filter(function (p) { return p.position === tapPosition; })[0];
    if (!tapCfg) throw new Error('La posición de TAP ' + tapPosition + ' no existe en tap_config del transformador');

    var phaseReadings = readings.measurements[tapPosStr];
    var phaseKeys = Object.keys(phaseReadings);
    if (phaseKeys.length === 0) throw new Error('El TAP ' + tapPosition + ' no tiene lecturas de fase');

    var phaseResults = {};
    var tapOk = true;

    phaseKeys.forEach(function (phaseKey) {
      var measured = phaseReadings[phaseKey].measuredRatio;
      var theoretical;
      if (usesCustomMatrix) {
        var entry = matrixByTap[tapPosition];
        if (!entry || !entry.phases || !entry.phases[phaseKey]) {
          throw new Error('custom_tap_ratio_matrix no tiene datos para la fase ' + phaseKey + ' del TAP ' + tapPosition);
        }
        theoretical = entry.phases[phaseKey].theoreticalRatio;
      } else {
        theoretical = multiplier * (tapCfg.voltage / transformer.lv_nominal_voltage);
      }

      var errorPercent = ((measured - theoretical) / theoretical) * 100;
      var status = Math.abs(errorPercent) <= TOLERANCE_PERCENT ? 'APROBADO' : 'RECHAZADO';
      if (status !== 'APROBADO') tapOk = false;

      phaseResults[phaseKey] = {
        measuredRatio: measured,
        appliedTheoreticalRatio: theoretical,
        errorPercent: errorPercent,
        status: status
      };
    });

    taps[tapPosStr] = { tapVoltage: tapCfg.voltage, phases: phaseResults, tapVerdict: tapOk ? 'APROBADO' : 'RECHAZADO' };
  });

  var overallVerdict = Object.keys(taps).every(function (k) { return taps[k].tapVerdict === 'APROBADO'; }) ? 'APROBADO' : 'RECHAZADO';

  return {
    theoreticalSource: usesCustomMatrix ? 'CUSTOM_MATRIX' : 'VECTOR_GROUP_FORMULA',
    vectorGroupApplied: transformer.vector_group || null,
    tolerancePercent: TOLERANCE_PERCENT,
    taps: taps,
    overallVerdict: overallVerdict
  };
}

// ---------------------------------------------------------------------------
// Resistencia de devanados — multi-TAP (réplica de WindingResistanceCalculator.kt)
// ---------------------------------------------------------------------------

function calculateWindingResistance_(readings) {
  var measurements = readings.measurements || [];
  if (measurements.length === 0) throw new Error('Debe incluir al menos un TAP con lecturas de resistencia de devanados');

  var tapResults = measurements.map(function (tap) {
    if (tap.windingTemperatureC === undefined || tap.windingTemperatureC === null) {
      throw new Error('El TAP ' + tap.tapPosition + ' no tiene windingTemperatureC (obligatorio)');
    }
    var phaseKeys = Object.keys(tap.phases || {});
    if (phaseKeys.length === 0) throw new Error('El TAP ' + tap.tapPosition + ' no tiene lecturas de fase');

    var values = phaseKeys.map(function (k) { return tap.phases[k].resistanceOhm; });
    var avg = values.reduce(function (a, b) { return a + b; }, 0) / values.length;

    var phaseResults = {};
    var maxUnbalance = 0;

    if (phaseKeys.length === 1) {
      phaseResults[phaseKeys[0]] = { resistanceOhm: values[0], deviationFromAvgPercent: 0, status: 'APROBADO' };
    } else {
      phaseKeys.forEach(function (k) {
        var v = tap.phases[k].resistanceOhm;
        var deviation = ((v - avg) / avg) * 100;
        var status = Math.abs(deviation) <= UNBALANCE_THRESHOLD_PERCENT ? 'APROBADO' : 'RECHAZADO';
        phaseResults[k] = { resistanceOhm: v, deviationFromAvgPercent: deviation, status: status };
        if (Math.abs(deviation) > maxUnbalance) maxUnbalance = Math.abs(deviation);
      });
    }

    var tapVerdict = maxUnbalance <= UNBALANCE_THRESHOLD_PERCENT ? 'APROBADO' : 'RECHAZADO';

    return {
      tapPosition: tap.tapPosition,
      windingTemperatureC: tap.windingTemperatureC,
      averageResistanceOhm: avg,
      phases: phaseResults,
      maxUnbalancePercent: maxUnbalance,
      tapVerdict: tapVerdict
    };
  });

  var overallVerdict = tapResults.every(function (t) { return t.tapVerdict === 'APROBADO'; }) ? 'APROBADO' : 'RECHAZADO';

  return {
    unbalanceThresholdPercent: UNBALANCE_THRESHOLD_PERCENT,
    taps: tapResults,
    overallVerdict: overallVerdict
  };
}

// ---------------------------------------------------------------------------
// Aislamiento (Megger) — DAR / IP (réplica de InsulationCalculator.kt)
// ---------------------------------------------------------------------------

function darRating_(dar) {
  if (dar < 1.0) return 'MALO';
  if (dar < 1.25) return 'CUESTIONABLE';
  if (dar < 1.6) return 'BUENO';
  return 'EXCELENTE';
}

function ipRating_(ip) {
  if (ip < 1.0) return 'MALO';
  if (ip < 2.0) return 'CUESTIONABLE';
  if (ip < 4.0) return 'BUENO';
  return 'EXCELENTE';
}

function calculateInsulation_(readings) {
  var measurements = readings.measurements || {};
  var keys = Object.keys(measurements);
  if (keys.length === 0) throw new Error('Debe incluir al menos una lectura de aislamiento');

  var results = {};
  var hasMalo = false;
  var hasCuestionable = false;

  keys.forEach(function (k) {
    var r = measurements[k];
    if (!(r.r30sMegaohm > 0) || !(r.r60sMegaohm > 0)) {
      throw new Error('Las lecturas de resistencia de aislamiento deben ser mayores a cero');
    }
    var dar = r.r60sMegaohm / r.r30sMegaohm;
    var ip = r.r10minMegaohm / r.r60sMegaohm;
    var dRating = darRating_(dar);
    var iRating = ipRating_(ip);
    if (dRating === 'MALO' || iRating === 'MALO') hasMalo = true;
    if (dRating === 'CUESTIONABLE' || iRating === 'CUESTIONABLE') hasCuestionable = true;
    results[k] = { dar: dar, darRating: dRating, ip: ip, ipRating: iRating };
  });

  var overallVerdict = hasMalo ? 'RECHAZADO' : (hasCuestionable ? 'OBSERVADO' : 'APROBADO');
  return { measurements: results, overallVerdict: overallVerdict };
}

// ---------------------------------------------------------------------------
// Almacenamiento de archivos en Drive (directriz 4)
// ---------------------------------------------------------------------------

function getOrCreateFolder_(name) {
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

/** Acepta tanto base64 puro como data URI ("data:image/png;base64,...."). */
function stripBase64Prefix_(s) {
  var commaIdx = s.indexOf(',');
  return (s.indexOf('base64,') !== -1 && commaIdx !== -1) ? s.substring(commaIdx + 1) : s;
}

function saveFileToDrive_(base64Data, fileNameNoExt, mimeType) {
  var folder = getOrCreateFolder_(ATTACHMENTS_FOLDER_NAME);
  var decoded = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(decoded, mimeType || 'application/octet-stream', fileNameNoExt);
  var file = folder.createFile(blob);
  return { fileId: file.getId(), url: file.getUrl() };
}

function driveFileUrl_(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view';
}

// ---------------------------------------------------------------------------
// Router: tabla de acciones (patrón Router — directriz de entregables)
// ---------------------------------------------------------------------------

var POST_ACTIONS = {
  createClient: createClient_,
  createTransformer: createTransformer_,
  updateTransformer: updateTransformer_,
  submitTtrTest: submitTtrTest_,
  submitWindingResistanceTest: submitWindingResistanceTest_,
  submitInsulationTest: submitInsulationTest_
};

var GET_ACTIONS = {
  listTransformers: listTransformers_,
  getTransformer: getTransformer_,
  listTests: listTests_
};
