/**
 * ============================================================================
 * M&A INGENIERÍA Y CONSULTORÍA SAS — API de Gestión de Pruebas de Transformadores
 * Backend: Google Apps Script (router) + Google Sheets (base de datos)
 *          + Google Drive (almacenamiento de archivos)
 *
 * AUTENTICACIÓN: delegada al IdP central "Control de Acceso" (JL Bedoya Group).
 * Este script NO valida usuarios ni contraseñas — solo confía en tokens ya
 * emitidos por Control de Acceso para la app MYA_PRUEBAS. Login, cambio de
 * contraseña y creación de usuarios se hacen contra Control de Acceso
 * directamente desde el frontend, nunca a través de este backend.
 * ============================================================================
 *
 * DESPLIEGUE
 *  1. Pega este archivo como Código.gs en el proyecto de Apps Script "M&A APP".
 *  2. Ejecuta manualmente ensureAllSheets_() una vez desde el editor.
 *  3. Implementar > Administrar implementaciones > editar > Nueva versión > Implementar.
 *
 * NOTA SOBRE CÓDIGOS HTTP
 *  Apps Script (ContentService) no permite fijar el código de estado HTTP real
 *  de la respuesta: el transporte siempre entrega 200. El estado real va DENTRO
 *  del cuerpo JSON como "status" (402, 403, 404, 429, etc.) — el cliente debe
 *  leer body.status, nunca el código HTTP de fetch().
 * ============================================================================
 */

/**
 * Función pública (sin guion bajo) SOLO para forzar la ventana de autorización
 * de Google: las funciones que terminan en "_" son tratadas como privadas por
 * Apps Script y no aparecen en el selector de Ejecutar del editor. Selecciona
 * "testAuthorization" en ese menú y dale a Ejecutar. Se puede borrar después.
 */
function testAuthorization() {
  var ss = getSpreadsheet_();
  Logger.log('Sheets OK, hoja: ' + ss.getName());

  var folder = getOrCreateFolder_(ATTACHMENTS_FOLDER_NAME);
  Logger.log('Drive OK, carpeta: ' + folder.getName());

  var response = UrlFetchApp.fetch(CONTROL_ACCESO_URL + '?action=validateToken&token=test&app=' + APP_ID, { muteHttpExceptions: true });
  Logger.log('UrlFetchApp OK, respuesta: ' + response.getContentText());
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/** Deployment activo del IdP central "Control de Acceso" (proyecto compartido, JL Bedoya Group). */
var CONTROL_ACCESO_URL = 'https://script.google.com/macros/s/AKfycby4K-qxW87hfd9Fy1wKHeyF8bic_Qo8clKfJ-ZuPg9zElNuc7XOe8qTgW8sUmJ9mnKjDA/exec';

/** Identificador de esta app dentro de Control de Acceso (fila en la hoja Config). */
var APP_ID = 'MYA_PRUEBAS';

var SHEET_NAMES = {
  SITIOS: 'Sitios',
  TRANSFORMADORES: 'Transformadores',
  PRUEBAS: 'Pruebas'
};

var HEADERS = {
  /** Cliente + Proyecto (Fase 1 de la jerarquía obligatoria). No confundir con "Clientes" de Control de Acceso (esos son usuarios de M&A, esto es la empresa/proyecto del equipo que se prueba). */
  /* nit/ciudad se agregaron después del lanzamiento inicial — van al FINAL del arreglo,
     nunca insertados entre columnas existentes, para no correr el índice de columna
     de filas ya guardadas en Sheets (ver colIndex_/ensureAllSheets_). */
  SITIOS: [
    'id', 'client_name', 'project_name', 'address', 'created_at', 'nit', 'ciudad'
  ],
  TRANSFORMADORES: [
    'id', 'site_id', 'serial_number', 'manufacturer', 'manufacture_year',
    'phase_type', 'vector_group', 'rated_power_kva', 'hv_nominal_voltage', 'lv_nominal_voltage',
    'tap_config_json', 'is_special_design', 'custom_tap_ratio_matrix_json',
    'status', 'plate_photo_file_id', 'created_at', 'updated_at',
    'cooling_type', 'impedance_percent', 'insulation_type'
  ],
  PRUEBAS: [
    'id', 'transformer_id', 'test_type', 'raw_readings_json',
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
 * Router principal. Toda petición (lectura o escritura) pasa por validateAuth_
 * antes de llegar a cualquier función de negocio: exige un token vigente,
 * emitido para MYA_PRUEBAS, con el servicio activo en Control de Acceso.
 * Las funciones de escritura (POST_ACTIONS) además aplican LockService.
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

    var auth = validateAuth_(params.token);
    if (auth.errorStatus) {
      return jsonResponse_({ status: auth.errorStatus, message: auth.errorMessage });
    }

    return handler(params, auth);
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
// Autenticación / Kill Switch (delegado a Control de Acceso)
// ---------------------------------------------------------------------------

/**
 * Valida el token contra Control de Acceso (acción validateToken, app=MYA_PRUEBAS).
 * Devuelve { errorStatus, errorMessage } si debe abortarse la petición, o
 * { username, role, allowedApps } si el token es válido y el servicio está activo.
 *
 * Códigos: 403 = token ausente/inválido/expirado o sin permiso para esta app.
 *          402 = token válido pero el servicio está suspendido (Kill Switch).
 */
function validateAuth_(token) {
  if (!token) {
    return { errorStatus: 403, errorMessage: 'Token requerido' };
  }

  var url = CONTROL_ACCESO_URL + '?action=validateToken&token=' + encodeURIComponent(token) + '&app=' + encodeURIComponent(APP_ID);
  var response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (err) {
    return { errorStatus: 500, errorMessage: 'No se pudo validar la sesión con Control de Acceso: ' + err.message };
  }

  var result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (err) {
    return { errorStatus: 500, errorMessage: 'Respuesta inválida de Control de Acceso' };
  }

  if (!result.valid) {
    return { errorStatus: 403, errorMessage: 'Token inválido o expirado' };
  }
  if ((result.allowedApps || []).indexOf(APP_ID) === -1) {
    return { errorStatus: 403, errorMessage: 'Tu usuario no tiene permiso para Gestión de Pruebas' };
  }
  if (!result.active) {
    return { errorStatus: 402, errorMessage: 'Servicio suspendido' };
  }

  return { username: result.sub, role: result.role, allowedApps: result.allowedApps };
}

// ---------------------------------------------------------------------------
// Concurrencia (escrituras)
// ---------------------------------------------------------------------------

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
// Acceso a Sheets (mapeo de índices de columnas)
// ---------------------------------------------------------------------------

/**
 * SpreadsheetApp.getActiveSpreadsheet() siempre devuelve null en una petición
 * Web App (sin contexto de UI). Se abre por ID explícito, guardado en las
 * Propiedades del script; si es la primera ejecución, se crea automáticamente.
 */
function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    return SpreadsheetApp.openById(id);
  }
  var ss = SpreadsheetApp.create('TMS - Base de Datos (M&A Gestión de Pruebas)');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function ensureAllSheets_() {
  var ss = getSpreadsheet_();
  Object.keys(HEADERS).forEach(function (key) {
    var sheet = ss.getSheetByName(SHEET_NAMES[key]);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAMES[key]);
      sheet.appendRow(HEADERS[key]);
      sheet.setFrozenRows(1);
    } else {
      // El esquema puede crecer entre versiones (columnas siempre agregadas al final,
      // nunca insertadas en medio — ver comentario en HEADERS). Sincroniza la fila de
      // encabezado si el arreglo tiene más columnas de las que ya existen en la hoja.
      var expected = HEADERS[key];
      if (sheet.getLastColumn() < expected.length) {
        sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
      }
    }
  });
}

function getSheet_(entityKey) {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES[entityKey]);
  if (!sheet) {
    ensureAllSheets_();
    sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES[entityKey]);
  }
  return sheet;
}

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
// Sitios (Cliente + Proyecto) — Fase 1 de la jerarquía obligatoria
// ---------------------------------------------------------------------------

/** Algoritmo estándar DIAN de dígito de verificación (módulo 11, pesos fijos por posición). */
function calcularDigitoVerificacionNit_(nitBase) {
  var pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  var digits = String(nitBase).split('').reverse();
  var suma = 0;
  for (var i = 0; i < digits.length; i++) {
    suma += Number(digits[i]) * (pesos[i] || 0);
  }
  var residuo = suma % 11;
  return (residuo === 0 || residuo === 1) ? residuo : (11 - residuo);
}

/** Acepta el NIT con o sin el dígito de verificación ya incluido ("900123456" o
 *  "900.123.456-7"); si viene sin DV lo calcula y lo agrega, si viene con DV lo valida.
 *  NIT es opcional: una cadena vacía es válida (nada que guardar). */
function normalizeNit_(raw) {
  if (!raw) return { ok: true, value: '' };
  var cleaned = String(raw).replace(/[.\s]/g, '');
  var match = cleaned.match(/^(\d+)(?:-(\d))?$/);
  if (!match) {
    return { ok: false, message: 'NIT inválido: usa solo números (y opcionalmente "-" seguido del dígito de verificación)' };
  }
  var base = match[1];
  var providedDv = match[2];
  var computedDv = calcularDigitoVerificacionNit_(base);
  if (providedDv !== undefined && Number(providedDv) !== computedDv) {
    return { ok: false, message: 'El dígito de verificación no coincide: para NIT ' + base + ' debería ser -' + computedDv };
  }
  return { ok: true, value: base + '-' + computedDv };
}

function findSiteRow_(id) {
  var sheet = getSheet_('SITIOS');
  var data = sheet.getDataRange().getValues();
  var idCol = HEADERS.SITIOS.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (data[r][idCol] === id) return rowToObject_(data[r], 'SITIOS', r + 1);
  }
  return null;
}

function siteRowToJson_(row) {
  return {
    id: row.id,
    client_name: row.client_name,
    project_name: row.project_name,
    address: row.address,
    nit: row.nit || '',
    ciudad: row.ciudad || '',
    created_at: row.created_at
  };
}

function createSite_(params) {
  return withLock_(function () {
    if (!params.client_name || !params.project_name) {
      return jsonResponse_({ status: 400, message: 'client_name y project_name son obligatorios' });
    }
    var nitResult = normalizeNit_(params.nit);
    if (!nitResult.ok) return jsonResponse_({ status: 422, message: nitResult.message });

    var id = generateId_();
    appendRow_('SITIOS', {
      id: id,
      client_name: params.client_name,
      project_name: params.project_name,
      address: params.address || '',
      created_at: new Date().toISOString(),
      nit: nitResult.value,
      ciudad: params.ciudad || ''
    });
    return jsonResponse_({ status: 201, message: 'Cliente/Proyecto creado', data: { id: id, nit: nitResult.value } });
  });
}

/** POST de actualización — mismo patrón que updateTransformer_: solo escribe los campos presentes en el payload. */
function updateSite_(params) {
  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var row = findSiteRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Cliente/Proyecto no encontrado' });

    var updates = {};
    ['client_name', 'project_name', 'address', 'ciudad'].forEach(function (field) {
      if (params[field] !== undefined) updates[field] = params[field];
    });
    if (params.nit !== undefined) {
      var nitResult = normalizeNit_(params.nit);
      if (!nitResult.ok) return jsonResponse_({ status: 422, message: nitResult.message });
      updates.nit = nitResult.value;
    }

    var sheet = getSheet_('SITIOS');
    Object.keys(updates).forEach(function (field) {
      sheet.getRange(row._row, colIndex_('SITIOS', field)).setValue(updates[field]);
    });
    return jsonResponse_({ status: 200, message: 'Cliente/Proyecto actualizado' });
  });
}

function listSites_() {
  var sheet = getSheet_('SITIOS');
  var data = sheet.getDataRange().getValues();
  var result = [];
  for (var r = 1; r < data.length; r++) {
    result.push(siteRowToJson_(rowToObject_(data[r], 'SITIOS', r + 1)));
  }
  return jsonResponse_({ status: 200, data: result });
}

// ---------------------------------------------------------------------------
// Transformadores
// ---------------------------------------------------------------------------

function findTransformerRow_(id) {
  var sheet = getSheet_('TRANSFORMADORES');
  var data = sheet.getDataRange().getValues();
  var idCol = HEADERS.TRANSFORMADORES.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (data[r][idCol] === id) {
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
    rated_power_kva: row.rated_power_kva,
    hv_nominal_voltage: row.hv_nominal_voltage,
    lv_nominal_voltage: row.lv_nominal_voltage,
    tap_config: safeParseJson_(row.tap_config_json),
    is_special_design: isTruthy_(row.is_special_design),
    custom_tap_ratio_matrix: safeParseJson_(row.custom_tap_ratio_matrix_json),
    status: row.status,
    plate_photo_url: row.plate_photo_file_id ? driveFileUrl_(row.plate_photo_file_id) : null,
    cooling_type: row.cooling_type || '',
    impedance_percent: row.impedance_percent,
    insulation_type: row.insulation_type || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function createTransformer_(params) {
  return withLock_(function () {
    if (!params.site_id) {
      return jsonResponse_({ status: 400, message: 'site_id es obligatorio: selecciona primero un Cliente/Proyecto (Fase 1)' });
    }
    if (!findSiteRow_(params.site_id)) {
      return jsonResponse_({ status: 404, message: 'El Cliente/Proyecto indicado no existe' });
    }
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
      site_id: params.site_id || '',
      serial_number: params.serial_number,
      manufacturer: params.manufacturer || '',
      manufacture_year: params.manufacture_year || '',
      phase_type: params.phase_type,
      vector_group: params.vector_group || '',
      rated_power_kva: params.rated_power_kva || '',
      hv_nominal_voltage: params.hv_nominal_voltage || '',
      lv_nominal_voltage: params.lv_nominal_voltage || '',
      tap_config_json: JSON.stringify(params.tap_config || {}),
      is_special_design: !!params.is_special_design,
      custom_tap_ratio_matrix_json: params.custom_tap_ratio_matrix ? JSON.stringify(params.custom_tap_ratio_matrix) : '',
      status: 'ACTIVO',
      plate_photo_file_id: attachmentId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cooling_type: params.cooling_type || '',
      impedance_percent: params.impedance_percent || '',
      insulation_type: params.insulation_type || ''
    });

    return jsonResponse_({ status: 201, message: 'Transformador creado', data: { id: id } });
  });
}

/** POST de actualización (Apps Script Web Apps no tienen verbo PATCH nativo). Solo escribe los campos presentes en el payload. */
function updateTransformer_(params) {
  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });

    var row = findTransformerRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });

    var updates = {};
    ['serial_number', 'manufacturer', 'manufacture_year', 'phase_type', 'vector_group', 'rated_power_kva',
      'hv_nominal_voltage', 'lv_nominal_voltage', 'status', 'site_id',
      'cooling_type', 'impedance_percent', 'insulation_type'].forEach(function (field) {
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

/** Solo Administrador. Elimina el transformador y en cascada sus pruebas asociadas
 *  (evita filas de PRUEBAS huérfanas apuntando a un transformer_id inexistente). */
function deleteTransformer_(params, auth) {
  return withLock_(function () {
    if (auth.role !== 'Administrador') {
      return jsonResponse_({ status: 403, message: 'Solo un Administrador puede eliminar equipos' });
    }
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var row = findTransformerRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });

    var testsSheet = getSheet_('PRUEBAS');
    var testsData = testsSheet.getDataRange().getValues();
    var transformerCol = HEADERS.PRUEBAS.indexOf('transformer_id');
    for (var r = testsData.length - 1; r >= 1; r--) {
      if (testsData[r][transformerCol] === params.id) testsSheet.deleteRow(r + 1);
    }

    getSheet_('TRANSFORMADORES').deleteRow(row._row);
    return jsonResponse_({ status: 200, message: 'Transformador eliminado' });
  });
}

/** Solo Administrador. Elimina el Cliente/Proyecto — se rechaza si todavía tiene
 *  equipos registrados, para no dejar transformadores huérfanos sin site_id válido. */
function deleteSite_(params, auth) {
  return withLock_(function () {
    if (auth.role !== 'Administrador') {
      return jsonResponse_({ status: 403, message: 'Solo un Administrador puede eliminar clientes/proyectos' });
    }
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var row = findSiteRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Cliente/Proyecto no encontrado' });

    var trfSheet = getSheet_('TRANSFORMADORES');
    var trfData = trfSheet.getDataRange().getValues();
    var siteCol = HEADERS.TRANSFORMADORES.indexOf('site_id');
    var hasEquipment = trfData.some(function (r, i) { return i > 0 && r[siteCol] === params.id; });
    if (hasEquipment) {
      return jsonResponse_({ status: 409, message: 'Este cliente/proyecto todavía tiene equipos registrados; elimínalos primero' });
    }

    getSheet_('SITIOS').deleteRow(row._row);
    return jsonResponse_({ status: 200, message: 'Cliente/Proyecto eliminado' });
  });
}

/**
 * Sin site_id: lista global (usada para el buscador de duplicados por número de serie,
 * ya que un transformador es un activo físico único y no debería registrarse dos veces
 * aunque el técnico esté parado en un cliente/proyecto distinto al de su primer registro).
 * Con serial_number: coincidencia exacta, sin distinguir mayúsculas/minúsculas.
 */
function listTransformers_(params) {
  var sheet = getSheet_('TRANSFORMADORES');
  var data = sheet.getDataRange().getValues();
  var siteCol = HEADERS.TRANSFORMADORES.indexOf('site_id');
  var serialCol = HEADERS.TRANSFORMADORES.indexOf('serial_number');
  var wantedSerial = params.serial_number ? String(params.serial_number).trim().toLowerCase() : null;
  var result = [];
  for (var r = 1; r < data.length; r++) {
    if (params.site_id && data[r][siteCol] !== params.site_id) continue;
    if (wantedSerial && String(data[r][serialCol]).trim().toLowerCase() !== wantedSerial) continue;
    result.push(transformerRowToJson_(rowToObject_(data[r], 'TRANSFORMADORES', r + 1)));
  }
  return jsonResponse_({ status: 200, data: result });
}

function getTransformer_(params) {
  if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
  var row = findTransformerRow_(params.id);
  if (!row) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
  return jsonResponse_({ status: 200, data: transformerRowToJson_(row) });
}

// ---------------------------------------------------------------------------
// Pruebas (TTR / Resistencia de devanados / Aislamiento)
// ---------------------------------------------------------------------------

function persistTest_(transformer, testType, rawReadings, calculated, params, auth) {
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
    transformer_id: transformer.id,
    test_type: testType,
    raw_readings_json: JSON.stringify(rawReadings),
    calculated_results_json: JSON.stringify(calculated),
    verdict: calculated.overallVerdict,
    instrument_used: params.instrument_used || '',
    tested_by: auth.username || params.instrument_used || 'desconocido',
    attachment_file_id: attachmentId,
    created_at: new Date().toISOString()
  });

  return { id: id, calculated_results: calculated };
}

function submitTtrTest_(params, auth) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(params.transformer_id);
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

    var saved = persistTest_(transformer, 'TTR', params.readings, calculated, params, auth);
    return jsonResponse_({ status: 201, message: 'Prueba TTR registrada', data: saved });
  });
}

function submitWindingResistanceTest_(params, auth) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(params.transformer_id);
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

    var saved = persistTest_(transformer, 'RESISTENCIA_DEVANADOS', params.readings, calculated, params, auth);
    return jsonResponse_({ status: 201, message: 'Prueba de resistencia de devanados registrada', data: saved });
  });
}

function submitInsulationTest_(params, auth) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(params.transformer_id);
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

    var saved = persistTest_(transformer, 'AISLAMIENTO', params.readings, calculated, params, auth);
    return jsonResponse_({ status: 201, message: 'Prueba de aislamiento registrada', data: saved });
  });
}

function listTests_(params) {
  var sheet = getSheet_('PRUEBAS');
  var data = sheet.getDataRange().getValues();
  var transformerCol = HEADERS.PRUEBAS.indexOf('transformer_id');
  var result = [];
  for (var r = 1; r < data.length; r++) {
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
// Aceite dieléctrico — tres secciones independientes, activables por checkbox:
// Fisicoquímico, Cromatografía de Gases Disueltos (DGA), Cromatografía de PCB.
// El técnico marca solo las que aplican a esa visita; se exige al menos una.
// ---------------------------------------------------------------------------

/** Umbrales de la matriz de decisión del Fisicoquímico, en orden de prioridad. */
var OIL_ACIDEZ_MAX_MG_KOH_G = 0.15;
var OIL_TENSION_INTERFACIAL_MIN_MN_M = 24; // dinas/cm == mN/m, mismo valor numérico
var OIL_RIGIDEZ_MIN_KV = 30;
var OIL_HUMEDAD_MAX_PPM = 35;
var OIL_PCB_LIMITE_PPM = 50; // Res. 222 de 2011, MinAmbiente

var OIL_PCB_AROCLORES = ['aroclor_1016', 'aroclor_1221', 'aroclor_1232', 'aroclor_1242', 'aroclor_1248', 'aroclor_1254', 'aroclor_1260'];

/** Exige que el valor sea numérico; usado solo para campos de una sección que SÍ está activa. */
function requireNumber_(value, label) {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error(label + ' es obligatorio y debe ser numérico si activaste esta sección');
  }
  return value;
}

/**
 * Combina hasta tres veredictos independientes (Fisicoquímico, sin veredicto para DGA,
 * PCB) en un solo `overallVerdict` para el historial/pill de la prueba, priorizando el
 * más severo (severity 3 > 2 > 1). El detalle de CADA sección activa igual queda
 * completo en `sections` para la vista de detalle — el overallVerdict es solo un resumen.
 */
function calculateOilAnalysis_(readings) {
  var sections = {};
  var overallVerdict = null;
  var overallSeverity = 0; // 0 = nada activo con veredicto, 1 = ok, 2 = alerta, 3 = crítico

  function considerVerdict(verdict, severity) {
    if (severity > overallSeverity) { overallSeverity = severity; overallVerdict = verdict; }
  }

  if (readings.fisicoquimico_realizado) {
    var rigidez = requireNumber_(readings.rigidez_dielectrica_kv, 'Rigidez dieléctrica');
    var agua = requireNumber_(readings.agua_ppm, 'Agua (ppm)');
    var acidez = requireNumber_(readings.numero_acido_mg_koh_g, 'Número ácido');
    var tension = requireNumber_(readings.tension_interfacial_dinas_cm, 'Tensión interfacial');

    var fqVerdict, fqSeverity;
    if (acidez >= OIL_ACIDEZ_MAX_MG_KOH_G || tension <= OIL_TENSION_INTERFACIAL_MIN_MN_M) {
      fqVerdict = 'REQUIERE REGENERACIÓN / CAMBIO'; fqSeverity = 3;
    } else if (rigidez <= OIL_RIGIDEZ_MIN_KV || agua >= OIL_HUMEDAD_MAX_PPM) {
      fqVerdict = 'REQUIERE TERMOVACÍO'; fqSeverity = 2;
    } else {
      fqVerdict = 'APROBADO'; fqSeverity = 1;
    }

    sections.fisicoquimico = {
      verdict: fqVerdict,
      thresholds: {
        acidezMaxMgKohG: OIL_ACIDEZ_MAX_MG_KOH_G,
        tensionInterfacialMinDinasCm: OIL_TENSION_INTERFACIAL_MIN_MN_M,
        rigidezMinKv: OIL_RIGIDEZ_MIN_KV,
        aguaMaxPpm: OIL_HUMEDAD_MAX_PPM
      }
    };
    considerVerdict(fqVerdict, fqSeverity);
  }

  if (readings.dga_realizado) {
    // Solo captura de datos — sin matriz de interpretación automática todavía.
    sections.dga = { registrado: true };
  }

  if (readings.pcb_realizado) {
    var total = 0;
    OIL_PCB_AROCLORES.forEach(function (key) {
      var v = readings[key];
      if (typeof v === 'number' && !isNaN(v)) total += v;
    });
    var contaminado = total >= OIL_PCB_LIMITE_PPM;
    var pcbVerdict = contaminado
      ? 'Contaminado — requiere manejo especial (Res. 222 de 2011, MinAmbiente)'
      : 'No contaminado';
    sections.pcb = { totalPcbPpm: total, verdict: pcbVerdict, limitePpm: OIL_PCB_LIMITE_PPM };
    considerVerdict(pcbVerdict, contaminado ? 3 : 1);
  }

  if (!overallVerdict) overallVerdict = 'REGISTRADO'; // ninguna sección con veredicto propio (p. ej. solo DGA)

  return { sections: sections, overallVerdict: overallVerdict };
}

function submitOilAnalysisTest_(params, auth) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(params.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
    if (!params.readings) return jsonResponse_({ status: 400, message: 'readings es obligatorio' });

    var r = params.readings;
    if (!r.fisicoquimico_realizado && !r.dga_realizado && !r.pcb_realizado) {
      return jsonResponse_({ status: 400, message: 'Activa al menos una sección (Fisicoquímico, DGA o PCB) antes de enviar' });
    }

    var calculated;
    try {
      calculated = calculateOilAnalysis_(r);
    } catch (calcErr) {
      return jsonResponse_({ status: 422, message: calcErr.message });
    }

    var saved = persistTest_(transformer, 'ACEITE_DIELECTRICO', r, calculated, params, auth);
    return jsonResponse_({ status: 201, message: 'Prueba de aceite dieléctrico registrada', data: saved });
  });
}

// ---------------------------------------------------------------------------
// Almacenamiento de archivos en Drive
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
// Router: tabla de acciones
// ---------------------------------------------------------------------------

var POST_ACTIONS = {
  createSite: createSite_,
  updateSite: updateSite_,
  createTransformer: createTransformer_,
  updateTransformer: updateTransformer_,
  deleteTransformer: deleteTransformer_,
  deleteSite: deleteSite_,
  submitTtrTest: submitTtrTest_,
  submitWindingResistanceTest: submitWindingResistanceTest_,
  submitInsulationTest: submitInsulationTest_,
  submitOilAnalysisTest: submitOilAnalysisTest_
};

var GET_ACTIONS = {
  listSites: listSites_,
  listTransformers: listTransformers_,
  getTransformer: getTransformer_,
  listTests: listTests_
};
