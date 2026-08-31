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

/** Igual que testAuthorization() pero para el scope de Google Docs
 *  (agregado para los informes PDF) — testAuthorization() no llama
 *  DocumentApp para nada, así que ejecutarla no dispara el consentimiento
 *  de este scope nuevo. Crea un Doc de prueba y lo manda a la papelera de
 *  inmediato. Selecciona "testDocumentAuthorization" en el selector de
 *  funciones del editor y dale a Ejecutar — debería pedir el permiso nuevo
 *  de Documents la primera vez. Se puede borrar después. */
function testDocumentAuthorization() {
  var doc = DocumentApp.create('tmp_test_auth_' + Date.now());
  doc.getBody().appendParagraph('test');
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).setTrashed(true);
  Logger.log('DocumentApp OK');
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
  PRUEBAS: 'Pruebas',
  DOCUMENTOS: 'Documentos',
  OFERTAS: 'Ofertas',
  CALIBRACIONES: 'Calibraciones'
};

var HEADERS = {
  /** Cliente + Proyecto (Fase 1 de la jerarquía obligatoria). No confundir con "Clientes" de Control de Acceso (esos son usuarios de M&A, esto es la empresa/proyecto del equipo que se prueba). */
  /* nit/ciudad se agregaron después del lanzamiento inicial — van al FINAL del arreglo,
     nunca insertados entre columnas existentes, para no correr el índice de columna
     de filas ya guardadas en Sheets (ver colIndex_/ensureAllSheets_). Lo mismo aplica
     a los 4 campos drive_*_folder_id, agregados para el módulo Documentos e Informes. */
  SITIOS: [
    'id', 'client_name', 'project_name', 'address', 'created_at', 'nit', 'ciudad',
    'drive_client_folder_id', 'drive_certificados_folder_id', 'drive_ofertas_folder_id', 'drive_documentos_folder_id'
  ],
  /* La columna 'status' se renombró a 'estado_equipo' (mismo índice, no se
     movió) para el semáforo del equipo (Activo/Fuera de servicio/Dado de
     baja) que consume Panel General — antes solo existía silenciosamente
     como 'ACTIVO' fijo, sin control de edición en la UI. Ver
     normalizeEstadoEquipo_/ESTADO_EQUIPO_VALUES. Efecto puramente cosmético:
     la celda de encabezado ya escrita en Sheets sigue diciendo "status"
     salvo que crezca el arreglo (ensureAllSheets_ solo reescribe el
     encabezado completo cuando el número de columnas aumenta). */
  TRANSFORMADORES: [
    'id', 'site_id', 'serial_number', 'manufacturer', 'manufacture_year',
    'phase_type', 'vector_group', 'rated_power_kva', 'hv_nominal_voltage', 'lv_nominal_voltage',
    'tap_config_json', 'is_special_design', 'custom_tap_ratio_matrix_json',
    'estado_equipo', 'plate_photo_file_id', 'created_at', 'updated_at',
    'cooling_type', 'impedance_percent', 'insulation_type',
    'numero_posiciones_tap', 'electrical_report_file_id', 'posicion_tap_nominal'
  ],
  PRUEBAS: [
    'id', 'transformer_id', 'test_type', 'raw_readings_json',
    'calculated_results_json', 'verdict', 'instrument_used', 'tested_by',
    'attachment_file_id', 'created_at', 'report_file_id'
  ],
  /** Índice de documentos subidos a Drive (certificados automáticos + subida manual) —
   *  existe porque "Documentos e Informes" necesita listar/filtrar por cliente, tipo y
   *  fecha sin tener que recorrer carpetas de Drive en cada consulta. */
  DOCUMENTOS: [
    'id', 'site_id', 'category', 'file_name', 'file_id', 'mime_type',
    'uploaded_by', 'created_at'
  ],
  /** Comercial — Ofertas y Licitaciones. `estado` guardado es siempre
   *  'Pendiente'/'Aprobada'/'Rechazada' — 'Cierre' NUNCA se escribe aquí, es
   *  un valor derivado que calcula listOfertas_ al leer (ver
   *  computeOfertaEstado_) cuando fecha_cierre ya pasó y sigue 'Pendiente'.
   *  `estado_changed_at` solo se actualiza en transiciones manuales
   *  (Aprobada/Rechazada) — se usa para el KPI de tiempo de respuesta. */
  OFERTAS: [
    'id', 'cliente_nombre', 'site_id', 'tipo', 'descripcion', 'valor_cotizado',
    'fecha_envio', 'fecha_cierre', 'estado', 'responsable',
    'adjunto_propuesta_file_id', 'adjunto_contrato_file_id', 'bitacora_json',
    'estado_changed_at', 'created_at', 'updated_at'
  ],
  /** Calibraciones — catálogo de instrumentos de medición PROPIOS de M&A
   *  (control de vigencia ante ente acreditado), no calibración de equipos
   *  del cliente. `estado` (Vigente/Por vencer/Vencido) NUNCA se guarda —
   *  es derivado de `fecha_proxima_calibracion` al leer, ver
   *  computeCalibracionEstado_ (mismo cuidado con Sheets Date que
   *  computeOfertaEstado_ en Comercial). */
  CALIBRACIONES: [
    'id', 'modelo', 'numero_serie', 'fabricante', 'fecha_ultima_calibracion',
    'fecha_proxima_calibracion', 'ente_acreditado', 'certificado_adjunto_file_id',
    'created_at', 'updated_at'
  ]
};

/** category en DOCUMENTOS: 'CERTIFICADOS' (solo lo escribe persistTest_, nunca subida
 *  manual), 'OFERTAS_CONTRATOS' y 'GENERALES' (solo subida manual, ver uploadDocument_). */

var ATTACHMENTS_FOLDER_NAME = 'TMS_Adjuntos';
var DRIVE_ROOT_FOLDER_NAME = 'M&A Ingeniería y Consultoría SAS';
var DRIVE_CALIBRACIONES_FOLDER_NAME = 'Calibraciones';
var DRIVE_PROSPECTOS_FOLDER_NAME = 'Comercial - Prospectos sin cliente';
var TOLERANCE_PERCENT = 0.5;
var UNBALANCE_THRESHOLD_PERCENT = 5.0;

/** Valores válidos de estado_equipo (Transformador). Cualquier valor legado
 *  ('ACTIVO' mayúsculas, de antes de este campo tenerse en cuenta) o vacío
 *  se trata como 'Activo' — migración perezosa, no hay backfill de filas. */
var ESTADO_EQUIPO_VALUES = ['Activo', 'Fuera de servicio', 'Dado de baja'];
function normalizeEstadoEquipo_(value) {
  return ESTADO_EQUIPO_VALUES.indexOf(value) !== -1 ? value : 'Activo';
}

/** Semáforo de vigencia de Calibraciones — Vigente (>30 días), Por vencer
 *  (0-30 días), Vencido (fecha ya pasada). Nunca se guarda, se calcula al
 *  leer. `fechaProxima` puede llegar como string ("YYYY-MM-DD", tal como la
 *  manda un <input type="date">) o como objeto Date real si Sheets ya
 *  autoconvirtió la celda al guardarla — mismo cuidado que
 *  computeOfertaEstado_ en Comercial: concatenar texto sobre un Date
 *  produce Invalid Date sin avisar. */
function computeCalibracionEstado_(fechaProxima) {
  if (!fechaProxima) return 'Vigente';
  var fecha = fechaProxima instanceof Date ? fechaProxima : new Date(fechaProxima + 'T23:59:59');
  var diffDays = (fecha - new Date()) / 86400000;
  if (diffDays < 0) return 'Vencido';
  if (diffDays <= 30) return 'Por vencer';
  return 'Vigente';
}

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
 *
 * Orden a propósito: los chequeos locales (action presente, acción
 * reconocida) van primero porque son gratis y no tocan red ni Sheets;
 * validateAuth_ (llamada real a Control de Acceso) va después de esos pero
 * ANTES de ensureAllSheets_ — así una petición anónima, con token inválido/
 * expirado, o con una acción que ni existe, nunca paga el costo de
 * recorrer las 6 hojas (ensureAllSheets_ solo corre para peticiones ya
 * autenticadas, justo antes de llegar al handler real).
 */
function routeRequest_(e, method) {
  try {
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

    ensureAllSheets_();
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
/** Cachea el handle en una variable de módulo — evita volver a llamar
 *  SpreadsheetApp.openById() en cada getSheet_() dentro de la misma
 *  ejecución (una petición puede llamar getSheet_() varias veces, p. ej.
 *  deleteSite_ lo hace 3 veces). Es solo un handle, no una foto de los
 *  datos — las lecturas posteriores (getDataRange(), etc.) siguen yendo
 *  contra Sheets en vivo, así que reusarlo no puede devolver datos viejos. */
var _spreadsheetCache_ = null;
function getSpreadsheet_() {
  if (_spreadsheetCache_) return _spreadsheetCache_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    _spreadsheetCache_ = SpreadsheetApp.openById(id);
    return _spreadsheetCache_;
  }
  var ss = SpreadsheetApp.create('TMS - Base de Datos (M&A Gestión de Pruebas)');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  _spreadsheetCache_ = ss;
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
    estado_equipo: normalizeEstadoEquipo_(row.estado_equipo),
    plate_photo_url: row.plate_photo_file_id ? driveFileUrl_(row.plate_photo_file_id) : null,
    cooling_type: row.cooling_type || '',
    impedance_percent: row.impedance_percent,
    insulation_type: row.insulation_type || '',
    numero_posiciones_tap: row.numero_posiciones_tap || null,
    posicion_tap_nominal: row.posicion_tap_nominal || null,
    electrical_report_url: row.electrical_report_file_id ? driveFileUrl_(row.electrical_report_file_id) : null,
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
      estado_equipo: 'Activo',
      plate_photo_file_id: attachmentId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cooling_type: params.cooling_type || '',
      impedance_percent: params.impedance_percent || '',
      insulation_type: params.insulation_type || '',
      numero_posiciones_tap: params.numero_posiciones_tap || '',
      posicion_tap_nominal: params.posicion_tap_nominal || ''
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
      'hv_nominal_voltage', 'lv_nominal_voltage', 'site_id',
      'cooling_type', 'impedance_percent', 'insulation_type', 'numero_posiciones_tap', 'posicion_tap_nominal'].forEach(function (field) {
      if (params[field] !== undefined) updates[field] = params[field];
    });
    if (params.estado_equipo !== undefined) {
      if (ESTADO_EQUIPO_VALUES.indexOf(params.estado_equipo) === -1) {
        return jsonResponse_({ status: 400, message: 'estado_equipo inválido: debe ser Activo, Fuera de servicio o Dado de baja' });
      }
      updates.estado_equipo = params.estado_equipo;
    }
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

    // Cascada sobre DOCUMENTOS — mismo criterio que deleteTransformer_ con
    // PRUEBAS: borra el índice (filas de la hoja), no los archivos reales en
    // Drive (igual que deleteTransformer_ tampoco borra los certificados en
    // Drive, solo las filas que apuntaban a ellos).
    var docsSheet = getSheet_('DOCUMENTOS');
    var docsData = docsSheet.getDataRange().getValues();
    var docsSiteCol = HEADERS.DOCUMENTOS.indexOf('site_id');
    for (var d = docsData.length - 1; d >= 1; d--) {
      if (docsData[d][docsSiteCol] === params.id) docsSheet.deleteRow(d + 1);
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

/** El certificado de una prueba se guarda en [Cliente]/Certificados de Pruebas/
 *  (carpeta persistida en el Sitio, ver ensureSiteFolders_) — no en la carpeta
 *  plana TMS_Adjuntos. También se indexa en DOCUMENTOS (category CERTIFICADOS)
 *  para que aparezca listado en el módulo Documentos e Informes junto con las
 *  subidas manuales. */
function persistTest_(transformer, testType, rawReadings, calculated, params, auth) {
  var site = findSiteRow_(transformer.site_id);
  var folders = ensureSiteFolders_(site);

  var attachmentId = '';
  var fileName = '';
  if (params.file_base64) {
    fileName = testType.toLowerCase() + '_' + transformer.serial_number + '_' + Date.now();
    var saved = saveFileToDriveIn_(
      folders.certificadosFolderId,
      stripBase64Prefix_(params.file_base64),
      fileName,
      params.file_mime_type || 'application/octet-stream'
    );
    attachmentId = saved.fileId;

    appendRow_('DOCUMENTOS', {
      id: generateId_(),
      site_id: transformer.site_id,
      category: 'CERTIFICADOS',
      file_name: fileName,
      file_id: attachmentId,
      mime_type: params.file_mime_type || '',
      uploaded_by: auth.username || 'desconocido',
      created_at: new Date().toISOString()
    });
  }

  var id = generateId_();
  var createdAt = new Date().toISOString();
  var testedBy = auth.username || params.instrument_used || 'desconocido';
  var reportFileId = '';

  if (testType === 'ACEITE_DIELECTRICO') {
    // Aceite: un informe por envío — no se consolida como las 3 pruebas
    // eléctricas (ver regenerateElectricalCombinedReport_ para el porqué),
    // porque conceptualmente es un análisis de una muestra puntual, no una
    // medición eléctrica repetible del mismo equipo. Nunca debe impedir que
    // la prueba se guarde: si falla, reportFileId queda vacío.
    try {
      var oilTestMeta = {
        created_at: createdAt,
        tested_by: testedBy,
        instrument_used: params.instrument_used || '',
        attachment_url: attachmentId ? driveFileUrl_(attachmentId) : null
      };
      var oilReport = generateOilTestReportPdf_(transformer, site, rawReadings, calculated, oilTestMeta, folders.certificadosFolderId);
      reportFileId = oilReport.fileId;
      appendRow_('DOCUMENTOS', {
        id: generateId_(),
        site_id: transformer.site_id,
        category: 'CERTIFICADOS',
        file_name: 'Informe_' + TEST_TYPE_LABELS_[testType] + '_' + transformer.serial_number,
        file_id: reportFileId,
        mime_type: 'application/pdf',
        uploaded_by: auth.username || 'desconocido',
        created_at: createdAt
      });
    } catch (reportErr) {
      // No relanzar.
    }
  }

  appendRow_('PRUEBAS', {
    id: id,
    transformer_id: transformer.id,
    test_type: testType,
    raw_readings_json: JSON.stringify(rawReadings),
    calculated_results_json: JSON.stringify(calculated),
    verdict: calculated.overallVerdict,
    instrument_used: params.instrument_used || '',
    tested_by: testedBy,
    attachment_file_id: attachmentId,
    created_at: createdAt,
    report_file_id: reportFileId
  });

  if (testType === 'TTR' || testType === 'RESISTENCIA_DEVANADOS' || testType === 'AISLAMIENTO') {
    // Combinado por transformador (2026-08-30, reemplazó un informe por
    // envío para estas 3 — ver regenerateElectricalCombinedReport_). La
    // fila de PRUEBAS ya se guardó arriba, así que la consulta de "más
    // reciente por tipo" adentro de esta función SÍ ve la que se acaba de
    // guardar. Nunca debe impedir que la prueba se guarde (ya se guardó).
    try {
      regenerateElectricalCombinedReport_(transformer, site, folders.certificadosFolderId, testedBy);
    } catch (combinedErr) {
      // No relanzar.
    }
  }

  return { id: id, calculated_results: calculated, report_url: reportFileId ? driveFileUrl_(reportFileId) : null };
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

/** `params.light` (opcional): si viene truthy, omite raw_readings/
 *  calculated_results — ni siquiera se hace el JSON.parse de esas columnas.
 *  Pensada para consumidores que solo necesitan contar/agrupar (Panel
 *  General: "Pruebas del mes" y "Pruebas por mes"), no mostrar el detalle
 *  de cada prueba. El historial de pruebas del detalle de un transformador
 *  sigue pidiendo la respuesta completa (sin `light`), porque sí necesita
 *  el veredicto detallado. */
function listTests_(params) {
  var sheet = getSheet_('PRUEBAS');
  var data = sheet.getDataRange().getValues();
  var transformerCol = HEADERS.PRUEBAS.indexOf('transformer_id');
  var light = isTruthy_(params.light);
  var result = [];
  for (var r = 1; r < data.length; r++) {
    if (params.transformer_id && data[r][transformerCol] !== params.transformer_id) continue;
    var obj = rowToObject_(data[r], 'PRUEBAS', r + 1);
    var item = {
      id: obj.id,
      transformer_id: obj.transformer_id,
      test_type: obj.test_type,
      verdict: obj.verdict,
      instrument_used: obj.instrument_used,
      tested_by: obj.tested_by,
      attachment_url: obj.attachment_file_id ? driveFileUrl_(obj.attachment_file_id) : null,
      report_url: obj.report_file_id ? driveFileUrl_(obj.report_file_id) : null,
      created_at: obj.created_at
    };
    if (!light) {
      item.raw_readings = safeParseJson_(obj.raw_readings_json);
      item.calculated_results = safeParseJson_(obj.calculated_results_json);
    }
    result.push(item);
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

  /** Mismo criterio que computeStandardTtrTheoretical_ en app.js (vista
   *  previa) — extendido aquí al backend/PDF a pedido del usuario, para que
   *  el informe generado no muestre un teórico silenciosamente dudoso o
   *  ausente sin ninguna marca. Solo aplica a la ruta estándar: con matriz
   *  personalizada los valores son explícitos, siempre confiables/
   *  disponibles. `theoreticalAvailable` se apaga si falta lv_nominal_voltage
   *  (chequeo aquí) o si algún TAP medido no tiene voltaje configurado
   *  (chequeo dentro del loop de abajo, típicamente por hv_nominal_voltage
   *  vacío al crear el equipo — ver buildDefaultTapPositions_ en app.js). */
  var theoreticalReliable = usesCustomMatrix || !!transformer.vector_group;
  var theoreticalAvailable = usesCustomMatrix || !!transformer.lv_nominal_voltage;

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
    if (!usesCustomMatrix && !tapCfg.voltage) theoreticalAvailable = false;

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
    theoreticalReliable: theoreticalReliable,
    theoreticalAvailable: theoreticalAvailable,
    tolerancePercent: TOLERANCE_PERCENT,
    taps: taps,
    overallVerdict: overallVerdict
  };
}

// ---------------------------------------------------------------------------
// Resistencia de devanados — multi-TAP (réplica de WindingResistanceCalculator.kt)
// ---------------------------------------------------------------------------

/** Desbalance entre fases a partir de un objeto {clave: {resistanceOhm}} —
 *  reusado tanto para cada TAP del primario como para el secundario (una
 *  sola medición, sin TAP), para no duplicar la fórmula. */
function computePhaseUnbalance_(phases) {
  var keys = Object.keys(phases || {});
  if (keys.length === 0) throw new Error('No hay lecturas de fase');

  var values = keys.map(function (k) { return phases[k].resistanceOhm; });
  var avg = values.reduce(function (a, b) { return a + b; }, 0) / values.length;

  var phaseResults = {};
  var maxUnbalance = 0;

  if (keys.length === 1) {
    phaseResults[keys[0]] = { resistanceOhm: values[0], deviationFromAvgPercent: 0, status: 'APROBADO' };
  } else {
    keys.forEach(function (k) {
      var v = phases[k].resistanceOhm;
      var deviation = ((v - avg) / avg) * 100;
      var status = Math.abs(deviation) <= UNBALANCE_THRESHOLD_PERCENT ? 'APROBADO' : 'RECHAZADO';
      phaseResults[k] = { resistanceOhm: v, deviationFromAvgPercent: deviation, status: status };
      if (Math.abs(deviation) > maxUnbalance) maxUnbalance = Math.abs(deviation);
    });
  }

  var verdict = maxUnbalance <= UNBALANCE_THRESHOLD_PERCENT ? 'APROBADO' : 'RECHAZADO';
  return { averageResistanceOhm: avg, phases: phaseResults, maxUnbalancePercent: maxUnbalance, verdict: verdict };
}

/**
 * Primario: multi-TAP, fase-fase (H1-H2/H2-H3/H3-H1), obligatorio.
 * Secundario: fase-fase (X1-X2/X2-X3/X3-X1), una sola medición sin TAP —
 * opcional en el payload por compatibilidad, pero el frontend siempre lo
 * envía. Si viene, su veredicto entra al overallVerdict igual que cualquier
 * TAP del primario (todos deben estar APROBADO para que el conjunto lo esté).
 */
function calculateWindingResistance_(readings) {
  var measurements = readings.measurements || [];
  if (measurements.length === 0) throw new Error('Debe incluir al menos un TAP con lecturas de resistencia de devanados');

  var tapResults = measurements.map(function (tap) {
    if (tap.windingTemperatureC === undefined || tap.windingTemperatureC === null) {
      throw new Error('El TAP ' + tap.tapPosition + ' no tiene windingTemperatureC (obligatorio)');
    }
    if (Object.keys(tap.phases || {}).length === 0) throw new Error('El TAP ' + tap.tapPosition + ' no tiene lecturas de fase');

    var result = computePhaseUnbalance_(tap.phases);
    return {
      tapPosition: tap.tapPosition,
      windingTemperatureC: tap.windingTemperatureC,
      averageResistanceOhm: result.averageResistanceOhm,
      phases: result.phases,
      maxUnbalancePercent: result.maxUnbalancePercent,
      tapVerdict: result.verdict
    };
  });

  var primaryVerdict = tapResults.every(function (t) { return t.tapVerdict === 'APROBADO'; }) ? 'APROBADO' : 'RECHAZADO';

  var secondaryResult = null;
  if (readings.secondary && Object.keys(readings.secondary.phases || {}).length) {
    if (readings.secondary.windingTemperatureC === undefined || readings.secondary.windingTemperatureC === null) {
      throw new Error('El devanado secundario no tiene windingTemperatureC (obligatorio)');
    }
    var secResult = computePhaseUnbalance_(readings.secondary.phases);
    secondaryResult = {
      windingTemperatureC: readings.secondary.windingTemperatureC,
      averageResistanceOhm: secResult.averageResistanceOhm,
      phases: secResult.phases,
      maxUnbalancePercent: secResult.maxUnbalancePercent,
      verdict: secResult.verdict
    };
  }

  var overallVerdict = (primaryVerdict === 'APROBADO' && (!secondaryResult || secondaryResult.verdict === 'APROBADO'))
    ? 'APROBADO' : 'RECHAZADO';

  return {
    unbalanceThresholdPercent: UNBALANCE_THRESHOLD_PERCENT,
    taps: tapResults,
    secondary: secondaryResult,
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
// Informes PDF de pruebas — generación programática con DocumentApp, NO
// plantilla de Google Docs con reemplazo de texto. Los dos requisitos que
// más importan (TTR con cualquier número de TAPs, Aceite con 1-3 secciones
// que pueden estar activas o no) son tamaño/estructura variable — una
// plantilla de texto fijo los maneja mal (tabla de filas fijas; soportar
// "cualquier cantidad de TAPs" igual requeriría manipular filas ya copiadas
// en código, tan frágil como construir desde cero pero con una capa extra
// de fragilidad para encontrar/borrar secciones por texto). Construir el
// documento completo por código evita eso: los bucles arman las tablas con
// cualquier cantidad de filas, y las secciones de Aceite simplemente no se
// agregan si no están activas. Se genera un Google Doc temporal, se exporta
// a PDF, y el Doc intermedio se manda a la papelera — solo el PDF queda en
// Drive, en la misma carpeta [Cliente]/Certificados de Pruebas/ que ya usa
// el adjunto crudo (si el técnico subió uno).
// ---------------------------------------------------------------------------

var TEST_TYPE_LABELS_ = {
  TTR: 'TTR',
  RESISTENCIA_DEVANADOS: 'Resistencia_Devanados',
  AISLAMIENTO: 'Resistencia_Aislamiento',
  ACEITE_DIELECTRICO: 'Aceite_Dielectrico'
};

var OIL_DGA_GASES_ = [
  { key: 'h2', label: 'Hidrógeno (H2)' },
  { key: 'o2', label: 'Oxígeno (O2)' },
  { key: 'n2', label: 'Nitrógeno (N2)' },
  { key: 'ch4', label: 'Metano (CH4)' },
  { key: 'co', label: 'Monóxido de carbono (CO)' },
  { key: 'co2', label: 'Dióxido de carbono (CO2)' },
  { key: 'c2h2', label: 'Acetileno (C2H2)' },
  { key: 'c2h4', label: 'Etileno (C2H4)' },
  { key: 'c2h6', label: 'Etano (C2H6)' }
];

/** Colores exactos del sistema de diseño de la app (ver comentario al
 *  inicio de styles.css) — duplicados a propósito porque un PDF no puede
 *  leer variables CSS. Si cambian los colores de la app, cambiar aquí
 *  también. */
var PDF_COLORS_ = {
  ACCENT: '#258fbf',
  ACCENT_SOFT: '#e9f4f9',
  TEXT: '#152618',
  TEXT_MUTED: '#5a6983',
  SUCCESS: '#3aaa35', SUCCESS_BG: '#ebf7eb',
  WARNING: '#f4c123', WARNING_BG: '#fdf6de',
  DANGER: '#8f2d2d', DANGER_BG: '#f4eaea',
  NEUTRAL_BG: '#f2f2f2',
  BORDER: '#b2b2b2'
};

/** Título de protocolo — barra prominente bajo el encabezado, formato
 *  "protocolo de pruebas" estándar de la industria (referencia visual dada
 *  por el usuario: dense datasheet grid + barras de sección + bloque de
 *  "área de control de calidad" al final). Las 3 pruebas eléctricas ya no
 *  tienen título propio: comparten uno solo en el informe combinado
 *  (regenerateElectricalCombinedReport_); solo Aceite sigue siendo un
 *  informe independiente por envío. */
var TEST_TYPE_PROTOCOL_TITLE_ = {
  ACEITE_DIELECTRICO: 'PROTOCOLO DE ANÁLISIS DE ACEITE DIELÉCTRICO'
};

/** Mismo criterio de severidad que ya usa la app para pintar pills
 *  (success/warning/danger) — mapea cualquier veredicto de los 4 módulos de
 *  prueba a un color. REGISTRADO (Aceite con solo DGA, sin veredicto
 *  propio) y cualquier valor no reconocido caen en neutro. */
function verdictColor_(verdict) {
  var v = String(verdict || '');
  if (v === 'APROBADO' || v === 'No contaminado') return { bg: PDF_COLORS_.SUCCESS_BG, text: PDF_COLORS_.SUCCESS };
  if (v === 'RECHAZADO' || v.indexOf('REQUIERE REGENERACIÓN') === 0 || v.indexOf('Contaminado') === 0) return { bg: PDF_COLORS_.DANGER_BG, text: PDF_COLORS_.DANGER };
  if (v === 'OBSERVADO' || v.indexOf('REQUIERE TERMOVACÍO') === 0) return { bg: PDF_COLORS_.WARNING_BG, text: PDF_COLORS_.WARNING };
  return { bg: PDF_COLORS_.NEUTRAL_BG, text: PDF_COLORS_.TEXT_MUTED };
}

/** Logo de M&A — subido una sola vez a la carpeta raíz vía uploadLogoAsset_
 *  (solo Administrador), ID persistido en Propiedades del script. Si nunca
 *  se subió, los informes se generan igual, solo sin logo — nunca debe
 *  bloquear la generación de un informe real. */
function getLogoBlob_() {
  var id = PropertiesService.getScriptProperties().getProperty('LOGO_FILE_ID');
  if (!id) return null;
  try { return DriveApp.getFileById(id).getBlob(); } catch (e) { return null; }
}

/** Solo Administrador. Sube el PNG del logo tal cual a la carpeta raíz del
 *  proyecto y persiste su fileId — mismo patrón que
 *  getRootFolder_/getCalibracionesFolder_. Un solo uso normalmente (o para
 *  reemplazar el logo si cambia). */
function uploadLogoAsset_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede subir el logo' });
  }
  if (!params.file_base64) return jsonResponse_({ status: 400, message: 'file_base64 es obligatorio' });
  var root = getRootFolder_();
  var decoded = Utilities.base64Decode(stripBase64Prefix_(params.file_base64));
  var blob = Utilities.newBlob(decoded, params.file_mime_type || 'image/png', 'logo-ma.png');
  var file = root.createFile(blob);
  PropertiesService.getScriptProperties().setProperty('LOGO_FILE_ID', file.getId());
  return jsonResponse_({ status: 200, message: 'Logo subido', data: { fileId: file.getId() } });
}

/** Minúsculas, sin acentos, solo alfanumérico — réplica exacta de
 *  normalizeInstrumentText_ en app.js (mismo algoritmo, dos runtimes
 *  distintos, no se puede compartir código entre backend y frontend). */
function normalizeInstrumentTextServer_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Réplica server-side de findMatchingCalibracion_ en app.js — hace falta
 *  porque el informe PDF se genera en el backend, sin acceso al JS del
 *  frontend. Mismo algoritmo (contención de substring, mínimo 3
 *  caracteres); si no encuentra nada, el informe simplemente no muestra
 *  estado de vigencia — no bloquea la generación. */
function findMatchingCalibracionServer_(instrumentText) {
  var normalized = normalizeInstrumentTextServer_(instrumentText);
  if (normalized.length < 3) return null;
  var sheet = getSheet_('CALIBRACIONES');
  var data = sheet.getDataRange().getValues();
  for (var r = 1; r < data.length; r++) {
    var row = rowToObject_(data[r], 'CALIBRACIONES', r + 1);
    var modelo = normalizeInstrumentTextServer_(row.modelo);
    var serie = normalizeInstrumentTextServer_(row.numero_serie);
    var isMatch = (modelo.length >= 3 && (normalized.indexOf(modelo) !== -1 || modelo.indexOf(normalized) !== -1)) ||
                  (serie.length >= 3 && (normalized.indexOf(serie) !== -1 || serie.indexOf(normalized) !== -1));
    if (isMatch) {
      return { modelo: row.modelo, numero_serie: row.numero_serie, estado: computeCalibracionEstado_(row.fecha_proxima_calibracion) };
    }
  }
  return null;
}

function fmtDatePdf_(iso) {
  if (!iso) return '—';
  var d;
  if (iso instanceof Date) {
    d = iso;
  } else if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    // Fecha pura sin hora (p. ej. sample_date de un <input type="date">) —
    // se construye en el timezone del script (America/Bogota, ver
    // appsscript.json) en vez de new Date(iso), que interpreta
    // "2026-08-29" como medianoche UTC y al convertir a Bogotá (UTC-5) se
    // corre al día anterior (28/08). Mismo cuidado que el gotcha de fechas
    // ya documentado con Sheets-Date en Comercial/Calibraciones, pero de
    // timezone en vez de tipo de dato.
    var parts = iso.split('-');
    d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  } else {
    d = new Date(iso);
  }
  if (isNaN(d.getTime())) return String(iso);
  return Utilities.formatDate(d, 'America/Bogota', 'dd/MM/yyyy');
}

function numOrDash_(v) {
  return (typeof v === 'number' && !isNaN(v)) ? v : '—';
}

/** Barra de sección — fondo acento sólido, texto blanco en mayúsculas,
 *  ancho completo — mismo tratamiento que el protocolo de referencia dado
 *  por el usuario (secciones como "DATOS DEL TRANSFORMADOR" en barra de
 *  color, no solo texto resaltado). */
function appendSectionTitle_(body, text) {
  var table = body.appendTable([[text.toUpperCase()]]);
  table.setBorderWidth(0);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(PDF_COLORS_.ACCENT);
  cell.editAsText().setBold(true).setFontSize(10).setForegroundColor('#ffffff');
  return table;
}

/** Caja de título del protocolo — borde y fondo acento suave, texto acento
 *  en mayúsculas, centrado. Va justo bajo el encabezado (logo + nombre),
 *  antes de cualquier sección de datos. */
function appendProtocolTitle_(body, text) {
  var table = body.appendTable([[text]]);
  table.setBorderColor(PDF_COLORS_.ACCENT);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(PDF_COLORS_.ACCENT_SOFT);
  var par = cell.getChild(0).asParagraph();
  par.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  cell.editAsText().setBold(true).setFontSize(13).setForegroundColor(PDF_COLORS_.ACCENT);
  return table;
}

/** Grilla densa de 4 columnas (etiqueta/valor × 2 por fila) — mismo
 *  criterio de densidad que el protocolo de referencia (MARCA | valor |
 *  POTENCIA | valor, en vez de una etiqueta por fila). Etiquetas en
 *  mayúsculas con fondo gris claro. `rows` es un arreglo de arreglos de 4
 *  strings: [etiqueta, valor, etiqueta, valor]. */
function appendDenseInfoGrid_(body, rows) {
  var table = body.appendTable(rows);
  table.setBorderColor(PDF_COLORS_.BORDER);
  for (var r = 0; r < table.getNumRows(); r++) {
    var row = table.getRow(r);
    for (var c = 0; c < row.getNumCells(); c++) {
      var cell = row.getCell(c);
      if (c % 2 === 0) {
        cell.setBackgroundColor(PDF_COLORS_.NEUTRAL_BG);
        cell.setWidth(115);
        cell.editAsText().setBold(true).setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT);
      } else {
        cell.editAsText().setFontSize(9).setForegroundColor(PDF_COLORS_.TEXT);
      }
    }
  }
  return table;
}

/** Tabla de resultados con encabezado resaltado (fondo acento, texto
 *  blanco) — reusada por los 3 informes eléctricos y por cada sub-sección
 *  activa de Aceite. */
function appendResultsTable_(body, rows) {
  var table = body.appendTable(rows);
  table.setBorderColor(PDF_COLORS_.BORDER);
  var header = table.getRow(0);
  for (var c = 0; c < header.getNumCells(); c++) {
    header.getCell(c).setBackgroundColor(PDF_COLORS_.ACCENT);
    header.getCell(c).editAsText().setBold(true).setFontSize(9).setForegroundColor('#ffffff');
  }
  for (var r = 1; r < table.getNumRows(); r++) {
    for (var c2 = 0; c2 < table.getRow(r).getNumCells(); c2++) {
      table.getRow(r).getCell(c2).editAsText().setFontSize(9);
    }
  }
  return table;
}

/** Encabezado compartido por los 2 formatos: logo + nombre lado a lado
 *  (tabla sin bordes de 1x2, mismo truco que usa el protocolo de
 *  referencia con el logo junto al eslogan) + caja de título del
 *  protocolo + datos del cliente y del equipo en una grilla densa (mismo
 *  criterio del protocolo de referencia: MARCA | valor | POTENCIA | valor,
 *  no una etiqueta por fila). */
function appendReportHeader_(body, site, transformer, protocolTitle) {
  var logoBlob = getLogoBlob_();
  var headTable = body.appendTable([['', 'M&A Ingeniería y Consultoría SAS']]);
  headTable.setBorderWidth(0);
  var logoCell = headTable.getRow(0).getCell(0);
  logoCell.setWidth(75);
  if (logoBlob) {
    var img = logoCell.appendImage(logoBlob);
    var ratio = img.getHeight() / img.getWidth();
    img.setWidth(55);
    img.setHeight(Math.round(55 * ratio));
  }
  var nameCell = headTable.getRow(0).getCell(1);
  nameCell.editAsText().setBold(true).setFontSize(14).setForegroundColor(PDF_COLORS_.TEXT);

  body.appendParagraph('');
  appendProtocolTitle_(body, protocolTitle);
  body.appendParagraph('');

  appendSectionTitle_(body, 'Datos del cliente y del equipo');
  appendDenseInfoGrid_(body, [
    ['CLIENTE', site.client_name || '—', 'NIT', site.nit || '—'],
    ['CIUDAD', site.ciudad || '—', 'PROYECTO', site.project_name || '—'],
    ['FABRICANTE', transformer.manufacturer || '—', 'N° DE SERIE', transformer.serial_number || '—'],
    ['GRUPO DE CONEXIÓN', transformer.vector_group || '—', 'POTENCIA NOMINAL', transformer.rated_power_kva ? (String(transformer.rated_power_kva) + ' kVA') : '—'],
    ['TENSIÓN PRIMARIA', transformer.hv_nominal_voltage ? (String(transformer.hv_nominal_voltage) + ' V') : '—', 'TENSIÓN SECUNDARIA', transformer.lv_nominal_voltage ? (String(transformer.lv_nominal_voltage) + ' V') : '—'],
    ['REFRIGERACIÓN', transformer.cooling_type || '—', 'AÑO DE FABRICACIÓN', transformer.manufacture_year ? String(transformer.manufacture_year) : '—']
  ]);
}

/** Datos de la prueba (fecha, técnico, instrumento + vigencia según
 *  Calibraciones, norma de referencia) — compartido por los 3 informes
 *  eléctricos. Aceite usa su propia sección "Datos de la muestra" en su
 *  lugar (muestra, no instrumento de M&A). */
/** `typeLabel` opcional — se usa en el informe combinado de pruebas
 *  eléctricas, donde puede haber hasta 3 bloques "Datos de la prueba" (uno
 *  por tipo) en el mismo documento y hace falta distinguirlos. */
function appendTestMetaSection_(body, testMeta, typeLabel) {
  appendSectionTitle_(body, typeLabel ? ('Datos de la prueba — ' + typeLabel) : 'Datos de la prueba');
  var calMatch = findMatchingCalibracionServer_(testMeta.instrument_used);
  var instrumentoLine = testMeta.instrument_used || '—';
  if (calMatch) instrumentoLine += ' (' + calMatch.estado + ')';
  appendDenseInfoGrid_(body, [
    ['FECHA', fmtDatePdf_(testMeta.created_at), 'TÉCNICO RESPONSABLE', testMeta.tested_by || '—'],
    ['INSTRUMENTO UTILIZADO', instrumentoLine, 'NORMA DE REFERENCIA', 'IEEE C57.12.90']
  ]);
}

/** Banner de veredicto — el elemento más visible del informe, mismo color
 *  que ya usa la app en pantalla (verdictColor_). */
function appendVerdictBanner_(body, label, verdict) {
  var colors = verdictColor_(verdict);
  var table = body.appendTable([[label + ': ' + verdict]]);
  table.setBorderWidth(0);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(colors.bg);
  cell.editAsText().setBold(true).setFontSize(13).setForegroundColor(colors.text);
}

/** "Área de control de calidad" — mismo nombre y ubicación (al final, junto
 *  a las firmas) que el protocolo de referencia dado por el usuario. */
function appendSignatureSection_(body, testedBy) {
  body.appendParagraph('');
  appendSectionTitle_(body, 'Área de control de calidad');
  var table = body.appendTable([
    ['PROBADO POR', 'REVISIÓN'],
    ['\n\n_____________________________\n' + (testedBy || ''), '\n\n_____________________________\n']
  ]);
  table.setBorderColor(PDF_COLORS_.BORDER);
  for (var c = 0; c < 2; c++) {
    table.getRow(0).getCell(c).setBackgroundColor(PDF_COLORS_.NEUTRAL_BG);
    table.getRow(0).getCell(c).editAsText().setBold(true).setFontSize(8);
    table.getRow(1).getCell(c).editAsText().setFontSize(9);
  }
}

/** Mismo lenguaje que la vista previa del frontend (computeStandardTtrTheoretical_
 *  en app.js) — si calculateTtr_ marcó el teórico como no disponible o no
 *  confiable, el PDF lo advierte en vez de dejar un número (o su ausencia)
 *  sin explicación. `undefined` en cualquiera de los dos flags (informes
 *  generados antes de este cambio, calculated_results_json sin los campos
 *  nuevos) no dispara advertencia — solo `=== false` explícito. */
function appendTtrTheoreticalWarning_(body, calculated) {
  var text = null;
  if (calculated.theoreticalAvailable === false) {
    text = 'Teórico no disponible — falta voltaje nominal de placa.';
  } else if (calculated.theoreticalReliable === false) {
    text = '⚠ Grupo de conexión no registrado en placa — teórico sin factor de relación trifásica, puede ser impreciso.';
  }
  if (!text) return;
  var table = body.appendTable([[text]]);
  table.setBorderWidth(0);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(PDF_COLORS_.WARNING_BG);
  cell.editAsText().setBold(true).setFontSize(9).setForegroundColor(PDF_COLORS_.WARNING);
}

function appendTtrResultsTable_(body, calculated) {
  appendSectionTitle_(body, 'Resultados — TTR (Relación de Transformación)');
  appendTtrTheoreticalWarning_(body, calculated);
  var rows = [['TAP', 'FASE', 'RELACIÓN MEDIDA', 'RELACIÓN TEÓRICA', 'ERROR %', 'ESTADO']];
  var theoAvailable = calculated.theoreticalAvailable !== false;
  Object.keys(calculated.taps).map(Number).sort(function (a, b) { return a - b; }).forEach(function (tapNum) {
    var tap = calculated.taps[String(tapNum)];
    Object.keys(tap.phases).forEach(function (phaseKey) {
      var p = tap.phases[phaseKey];
      rows.push([
        String(tapNum),
        phaseKey,
        p.measuredRatio != null ? p.measuredRatio.toFixed(4) : '—',
        theoAvailable && p.appliedTheoreticalRatio != null ? p.appliedTheoreticalRatio.toFixed(4) : '—',
        theoAvailable && p.errorPercent != null ? p.errorPercent.toFixed(2) + ' %' : '—',
        theoAvailable ? p.status : 'PENDIENTE'
      ]);
    });
  });
  appendResultsTable_(body, rows);
  appendVerdictBanner_(body, 'Veredicto', calculated.overallVerdict);
}

function appendWindingResultsTable_(body, calculated) {
  appendSectionTitle_(body, 'Resultados — Resistencia de Devanados');
  var rows = [['TAP', 'FASE', 'RESISTENCIA (Ω)', 'DESVIACIÓN %', 'ESTADO']];
  calculated.taps.forEach(function (tap) {
    Object.keys(tap.phases).forEach(function (phaseKey) {
      var p = tap.phases[phaseKey];
      rows.push([String(tap.tapPosition), phaseKey, p.resistanceOhm.toFixed(4), p.deviationFromAvgPercent.toFixed(2) + ' %', p.status]);
    });
  });
  appendResultsTable_(body, rows);

  if (calculated.secondary) {
    var secTitle = body.appendParagraph('SECUNDARIO');
    secTitle.editAsText().setBold(true).setFontSize(10);
    var secRows = [['FASE', 'RESISTENCIA (Ω)', 'DESVIACIÓN %', 'ESTADO']];
    Object.keys(calculated.secondary.phases).forEach(function (phaseKey) {
      var p = calculated.secondary.phases[phaseKey];
      secRows.push([phaseKey, p.resistanceOhm.toFixed(4), p.deviationFromAvgPercent.toFixed(2) + ' %', p.status]);
    });
    appendResultsTable_(body, secRows);
  }

  appendVerdictBanner_(body, 'Veredicto', calculated.overallVerdict);
}

function appendInsulationResultsTable_(body, calculated) {
  appendSectionTitle_(body, 'Resultados — Resistencia de Aislamiento (DAR/IP)');
  var rows = [['COMBINACIÓN', 'DAR', 'CALIFICACIÓN DAR', 'IP', 'CALIFICACIÓN IP']];
  Object.keys(calculated.measurements).forEach(function (key) {
    var m = calculated.measurements[key];
    rows.push([key, m.dar.toFixed(2), m.darRating, m.ip.toFixed(2), m.ipRating]);
  });
  appendResultsTable_(body, rows);
  appendVerdictBanner_(body, 'Veredicto', calculated.overallVerdict);
}

var TEST_TYPE_DISPLAY_LABEL_ = {
  TTR: 'TTR',
  RESISTENCIA_DEVANADOS: 'Resistencia de Devanados',
  AISLAMIENTO: 'Resistencia de Aislamiento'
};

/** `iso` puede llegar como string o como Date real (autoconversión de
 *  Sheets) — normaliza a milisegundos para poder comparar cuál prueba es
 *  más reciente sin repetir el gotcha de Sheets-Date ya documentado. */
function toComparableDate_(iso) {
  if (iso instanceof Date) return iso.getTime();
  var t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

/** La prueba MÁS RECIENTE de cada uno de los 3 tipos eléctricos para un
 *  transformador — `null` si ese tipo nunca se probó. Aceite dieléctrico
 *  no entra aquí a propósito (no es parte del combinado). */
function findLatestElectricalTestsByType_(transformerId) {
  var sheet = getSheet_('PRUEBAS');
  var data = sheet.getDataRange().getValues();
  var transformerCol = HEADERS.PRUEBAS.indexOf('transformer_id');
  var typeCol = HEADERS.PRUEBAS.indexOf('test_type');
  var latest = { TTR: null, RESISTENCIA_DEVANADOS: null, AISLAMIENTO: null };
  for (var r = 1; r < data.length; r++) {
    if (data[r][transformerCol] !== transformerId) continue;
    var type = data[r][typeCol];
    if (!(type in latest)) continue;
    var obj = rowToObject_(data[r], 'PRUEBAS', r + 1);
    if (!latest[type] || toComparableDate_(obj.created_at) > toComparableDate_(latest[type].created_at)) {
      latest[type] = obj;
    }
  }
  return latest;
}

/** Timestamp seguro para nombre de archivo, en el timezone del script
 *  (America/Bogota, ver appsscript.json) — mismo cuidado de timezone que
 *  fmtDatePdf_, formateado con Utilities.formatDate en vez de toISOString()
 *  (que siempre da UTC) para que el nombre del archivo coincida con la
 *  hora local que ve el técnico. ':' no es válido en nombres de Drive en
 *  algunos clientes, por eso '-' en la hora. */
function fmtTimestampForFilename_(date) {
  return Utilities.formatDate(date, 'America/Bogota', "yyyy-MM-dd'T'HH-mm-ss");
}

/** Datos de la prueba (con el tipo en el título, para distinguir bloques
 *  cuando hay varios en el mismo documento) + tabla de resultados
 *  específica por tipo — una "sección" completa para un tipo eléctrico
 *  dentro del informe combinado. */
function appendElectricalTypeSection_(body, testType, testRow) {
  var calculated = safeParseJson_(testRow.calculated_results_json);
  var testMeta = {
    created_at: testRow.created_at,
    tested_by: testRow.tested_by,
    instrument_used: testRow.instrument_used
  };
  appendTestMetaSection_(body, testMeta, TEST_TYPE_DISPLAY_LABEL_[testType]);
  if (testType === 'TTR') appendTtrResultsTable_(body, calculated);
  else if (testType === 'RESISTENCIA_DEVANADOS') appendWindingResultsTable_(body, calculated);
  else if (testType === 'AISLAMIENTO') appendInsulationResultsTable_(body, calculated);
  body.appendParagraph('');
}

/**
 * Un PDF combinado (TTR/Devanados/Aislamiento en un solo documento) por
 * cada envío de una prueba eléctrica — decisión del usuario (2026-08-30)
 * tras ver que la primera versión (un PDF por CADA prueba individual, sin
 * agrupar) no coincidía con cómo se maneja un protocolo de pruebas en la
 * práctica. Corregido de nuevo el mismo día: la primera implementación de
 * "un solo documento" reemplazaba el PDF anterior en cada envío (borraba
 * el archivo viejo de Drive y su fila en DOCUMENTOS) — el usuario pidió
 * explícitamente **no perder histórico**: cada envío que dispara una
 * regeneración debe quedar como su propio PDF con timestamp, sin borrar
 * ni sobrescribir los anteriores. Si un tipo nunca se probó, su sección
 * simplemente no aparece en el PDF de ese envío.
 *
 * Aceite dieléctrico NO entra aquí — sigue con un informe por envío
 * (generateOilTestReportPdf_): es un análisis de una muestra puntual con
 * su propio laboratorio acreditado, conceptualmente distinto a una
 * medición eléctrica repetible del mismo equipo.
 *
 * Se llama desde persistTest_ cada vez que se guarda un TTR/Devanados/
 * Aislamiento — la fila de PRUEBAS de esa prueba ya está guardada para
 * ese momento, así que `findLatestElectricalTestsByType_` sí la ve como
 * candidata a "más reciente".
 *
 * Fuente de verdad del histórico completo: las filas de DOCUMENTOS
 * (categoría CERTIFICADOS, nombre con timestamp) — ya se listan sin
 * deduplicar en el módulo "Documentos e Informes"
 * (`applyDocumentFilters_` en app.js), así que cada versión queda
 * visible/descargable ahí automáticamente, sin UI nueva.
 * `TRANSFORMADORES.electrical_report_file_id` sigue existiendo, pero solo
 * como caché del más reciente para el pill de acceso rápido en el header
 * del equipo — nunca se lee como fuente de histórico.
 */
function regenerateElectricalCombinedReport_(transformer, site, folderId, uploadedBy) {
  var latest = findLatestElectricalTestsByType_(transformer.id);
  var order = ['TTR', 'RESISTENCIA_DEVANADOS', 'AISLAMIENTO'];
  var present = order.filter(function (t) { return latest[t]; });
  if (present.length === 0) return null;

  var doc = DocumentApp.create('tmp_informe_electrico_' + Date.now());
  var body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(50).setMarginRight(50);

  appendReportHeader_(body, site, transformer, 'PROTOCOLO DE PRUEBAS ELÉCTRICAS');
  present.forEach(function (type) {
    appendElectricalTypeSection_(body, type, latest[type]);
  });

  var mostRecentType = present.reduce(function (a, b) {
    return toComparableDate_(latest[a].created_at) >= toComparableDate_(latest[b].created_at) ? a : b;
  });
  appendSignatureSection_(body, latest[mostRecentType].tested_by);

  var fileName = 'Informe_Electrico_' + transformer.serial_number + '_' + fmtTimestampForFilename_(new Date());
  var saved = finalizeReportPdf_(doc, folderId, fileName);

  getSheet_('TRANSFORMADORES').getRange(transformer._row, colIndex_('TRANSFORMADORES', 'electrical_report_file_id')).setValue(saved.fileId);

  appendRow_('DOCUMENTOS', {
    id: generateId_(),
    site_id: transformer.site_id,
    category: 'CERTIFICADOS',
    file_name: fileName,
    file_id: saved.fileId,
    mime_type: 'application/pdf',
    uploaded_by: uploadedBy || 'desconocido',
    created_at: new Date().toISOString()
  });

  return saved;
}

/** Aceite dieléctrico — plantilla distinta: datos de muestra en vez de
 *  instrumento de M&A, solo las secciones activas
 *  (fisicoquimico_realizado/dga_realizado/pcb_realizado), cada valor junto
 *  a su método ASTM, referencia al certificado del laboratorio ya subido
 *  (no lo reemplaza, solo lo referencia). */
function generateOilTestReportPdf_(transformer, site, rawReadings, calculated, testMeta, folderId) {
  var doc = DocumentApp.create('tmp_informe_aceite_' + Date.now());
  var body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(50).setMarginRight(50);

  appendReportHeader_(body, site, transformer, TEST_TYPE_PROTOCOL_TITLE_.ACEITE_DIELECTRICO);

  appendSectionTitle_(body, 'Datos de la muestra');
  appendDenseInfoGrid_(body, [
    ['FECHA', fmtDatePdf_(testMeta.created_at), 'TÉCNICO RESPONSABLE', testMeta.tested_by || '—'],
    ['MUESTRA TOMADA POR', rawReadings.sample_taken_by || '—', 'FECHA DE MUESTREO', rawReadings.sample_date ? fmtDatePdf_(rawReadings.sample_date) : '—']
  ]);

  if (calculated.sections.fisicoquimico) {
    appendSectionTitle_(body, 'Fisicoquímico');
    appendResultsTable_(body, [
      ['ENSAYO', 'VALOR', 'MÉTODO ASTM'],
      ['Agua', numOrDash_(rawReadings.agua_ppm) + ' ppm', 'ASTM D1533-20'],
      ['Rigidez dieléctrica', numOrDash_(rawReadings.rigidez_dielectrica_kv) + ' kV', 'ASTM D1816-12(2019)'],
      ['Tensión interfacial', numOrDash_(rawReadings.tension_interfacial_dinas_cm) + ' dinas/cm', 'ASTM D971-20'],
      ['Número ácido', numOrDash_(rawReadings.numero_acido_mg_koh_g) + ' mg KOH/g', 'ASTM D974-22'],
      ['Densidad relativa', String(numOrDash_(rawReadings.densidad_relativa)), 'ASTM D1298-12b(2017)e1'],
      ['Color', rawReadings.color_astm || '—', 'ASTM D1500-24'],
      ['Examen visual', rawReadings.examen_visual || '—', 'ASTM D1524-15(2022)']
    ]);
    appendVerdictBanner_(body, 'Fisicoquímico', calculated.sections.fisicoquimico.verdict);
  }

  if (calculated.sections.dga) {
    appendSectionTitle_(body, 'Cromatografía de Gases Disueltos (DGA)');
    var dgaRows = [['GAS', 'VALOR (PPM)']];
    OIL_DGA_GASES_.forEach(function (g) {
      dgaRows.push([g.label, String(numOrDash_(rawReadings[g.key]))]);
    });
    appendResultsTable_(body, dgaRows);
    var note = body.appendParagraph('Método ASTM D3612-02(2017), Método C — solo captura de datos, sin matriz de interpretación automática todavía.');
    note.editAsText().setItalic(true).setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
  }

  if (calculated.sections.pcb) {
    appendSectionTitle_(body, 'Cromatografía de PCB');
    var pcbRows = [['AROCLOR', 'VALOR (PPM)']];
    OIL_PCB_AROCLORES.forEach(function (key) {
      pcbRows.push([key.replace('aroclor_', 'Aroclor '), String(numOrDash_(rawReadings[key]))]);
    });
    pcbRows.push(['Total PCB', calculated.sections.pcb.totalPcbPpm.toFixed(2) + ' ppm']);
    appendResultsTable_(body, pcbRows);
    var pcbNote = body.appendParagraph('Método ASTM D4059-00(2018) · ente acreditado IDEAM.');
    pcbNote.editAsText().setItalic(true).setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
    appendVerdictBanner_(body, 'PCB', calculated.sections.pcb.verdict);
  }

  if (testMeta.attachment_url) {
    body.appendParagraph('');
    var certPar = body.appendParagraph('Certificado del laboratorio acreditado: ' + testMeta.attachment_url);
    certPar.editAsText().setFontSize(9).setForegroundColor(PDF_COLORS_.ACCENT);
    var noteReplace = body.appendParagraph('Este informe es un resumen/interpretación de los resultados — no reemplaza el certificado del laboratorio acreditado.');
    noteReplace.editAsText().setItalic(true).setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
  }

  appendVerdictBanner_(body, 'Veredicto general', calculated.overallVerdict);
  appendSignatureSection_(body, testMeta.tested_by);
  return finalizeReportPdf_(doc, folderId, 'Informe_Aceite_' + transformer.serial_number);
}

/** Exporta el Doc a PDF, lo guarda en la carpeta destino, y manda el Doc
 *  intermedio a la papelera — solo el PDF queda como archivo real. */
function finalizeReportPdf_(doc, folderId, fileName) {
  doc.saveAndClose();
  var docFile = DriveApp.getFileById(doc.getId());
  var pdfBlob = docFile.getAs('application/pdf').setName(fileName + '.pdf');
  var folder = DriveApp.getFolderById(folderId);
  var pdfFile = folder.createFile(pdfBlob);
  docFile.setTrashed(true);
  return { fileId: pdfFile.getId(), url: pdfFile.getUrl() };
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
// Estructura de carpetas en Drive (módulo Documentos e Informes)
//
//   M&A Ingeniería y Consultoría SAS/     (raíz, ID persistido en Propiedades)
//   ├── Calibraciones/                     (nivel proyecto, no por cliente)
//   ├── [Cliente 1 · Proyecto 1]/          (ID persistido en el Sitio)
//   │   ├── Certificados de Pruebas/       (solo persistTest_ escribe aquí)
//   │   ├── Ofertas y Contratos/           (subida manual)
//   │   └── Documentos Generales/          (subida manual)
//   └── ...
//
// Los IDs se buscan por nombre SOLO la primera vez que hacen falta — después
// quedan guardados (Propiedades del script para la raíz/Calibraciones, columnas
// del Sitio para las 4 carpetas por cliente) y nunca se vuelve a buscar por
// nombre. Migración perezosa: un Sitio creado antes de este cambio no tiene
// esas columnas — se crean y persisten la primera vez que se necesitan, no con
// un script de migración masiva.
// ---------------------------------------------------------------------------

/** Busca una subcarpeta por nombre DENTRO de un padre específico (no en todo
 *  Drive) — más preciso que getOrCreateFolder_ y necesario para no confundir
 *  carpetas con el mismo nombre en clientes distintos. */
function getOrCreateFolderIn_(parentFolder, name) {
  var folders = parentFolder.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parentFolder.createFolder(name);
}

/** Carpeta raíz del proyecto — se crea una sola vez; el ID queda en las
 *  Propiedades del script para no buscarla por nombre en cada operación. */
function getRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DRIVE_ROOT_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* ID borrado/inválido: se recrea abajo */ }
  }
  var folder = getOrCreateFolder_(DRIVE_ROOT_FOLDER_NAME);
  props.setProperty('DRIVE_ROOT_FOLDER_ID', folder.getId());
  return folder;
}

/** Carpeta Calibraciones a nivel de proyecto (no por cliente — los
 *  instrumentos son de M&A, se usan en varios clientes). El módulo
 *  Calibraciones todavía no está construido (ver CLAUDE.md), así que hoy
 *  nada escribe aquí, pero la carpeta ya queda lista para cuando se construya. */
function getCalibracionesFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DRIVE_CALIBRACIONES_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* ID borrado/inválido: se recrea abajo */ }
  }
  var folder = getOrCreateFolderIn_(getRootFolder_(), DRIVE_CALIBRACIONES_FOLDER_NAME);
  props.setProperty('DRIVE_CALIBRACIONES_FOLDER_ID', folder.getId());
  return folder;
}

/** Carpeta a nivel de proyecto para adjuntos de Ofertas/Licitaciones que
 *  todavía no tienen un Sitio vinculado (`cliente_nombre` es texto libre,
 *  no requiere que el Sitio exista). Cuando la oferta se vincula a un Sitio
 *  real, el archivo se MUEVE de aquí a `[Cliente]/Ofertas y Contratos/`
 *  (ver moveOfertaAttachmentsToSite_) — nunca se duplica. */
function getProspectosSinClienteFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DRIVE_PROSPECTOS_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* ID borrado/inválido: se recrea abajo */ }
  }
  var folder = getOrCreateFolderIn_(getRootFolder_(), DRIVE_PROSPECTOS_FOLDER_NAME);
  props.setProperty('DRIVE_PROSPECTOS_FOLDER_ID', folder.getId());
  return folder;
}

/** Devuelve los 4 IDs de carpeta de un Sitio (cliente + sus 3 subcarpetas),
 *  usando los que ya estén guardados en la fila. Si al Sitio le falta
 *  cualquiera de los 4 (nunca se necesitaron, o es un Sitio anterior a este
 *  cambio), los crea ahora y los persiste en la misma fila — así la próxima
 *  llamada ya no vuelve a tocar Drive para buscarlos. */
function ensureSiteFolders_(site) {
  if (site.drive_client_folder_id && site.drive_certificados_folder_id &&
      site.drive_ofertas_folder_id && site.drive_documentos_folder_id) {
    return {
      clientFolderId: site.drive_client_folder_id,
      certificadosFolderId: site.drive_certificados_folder_id,
      ofertasFolderId: site.drive_ofertas_folder_id,
      documentosFolderId: site.drive_documentos_folder_id
    };
  }

  var root = getRootFolder_();
  var clientFolderName = site.client_name + ' · ' + site.project_name;
  var clientFolder = getOrCreateFolderIn_(root, clientFolderName);
  var certificados = getOrCreateFolderIn_(clientFolder, 'Certificados de Pruebas');
  var ofertas = getOrCreateFolderIn_(clientFolder, 'Ofertas y Contratos');
  var documentos = getOrCreateFolderIn_(clientFolder, 'Documentos Generales');

  var ids = {
    clientFolderId: clientFolder.getId(),
    certificadosFolderId: certificados.getId(),
    ofertasFolderId: ofertas.getId(),
    documentosFolderId: documentos.getId()
  };

  var sheet = getSheet_('SITIOS');
  sheet.getRange(site._row, colIndex_('SITIOS', 'drive_client_folder_id')).setValue(ids.clientFolderId);
  sheet.getRange(site._row, colIndex_('SITIOS', 'drive_certificados_folder_id')).setValue(ids.certificadosFolderId);
  sheet.getRange(site._row, colIndex_('SITIOS', 'drive_ofertas_folder_id')).setValue(ids.ofertasFolderId);
  sheet.getRange(site._row, colIndex_('SITIOS', 'drive_documentos_folder_id')).setValue(ids.documentosFolderId);

  return ids;
}

/** Como saveFileToDrive_, pero guarda dentro de una carpeta específica por ID
 *  en vez de siempre en la carpeta plana TMS_Adjuntos. */
function saveFileToDriveIn_(folderId, base64Data, fileNameNoExt, mimeType) {
  var folder = DriveApp.getFolderById(folderId);
  var decoded = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(decoded, mimeType || 'application/octet-stream', fileNameNoExt);
  var file = folder.createFile(blob);
  return { fileId: file.getId(), url: file.getUrl() };
}

// ---------------------------------------------------------------------------
// Documentos e Informes
// ---------------------------------------------------------------------------

/** Subida manual — Técnico SÍ puede subir (Full en la matriz RBAC para esto),
 *  por eso no hay chequeo de rol aquí. Lo que un Técnico no puede hacer es
 *  LISTAR (ver listDocuments_). category nunca puede ser CERTIFICADOS por
 *  esta vía — esa la llena solo persistTest_. */
function uploadDocument_(params, auth) {
  return withLock_(function () {
    if (!params.site_id) return jsonResponse_({ status: 400, message: 'site_id es obligatorio' });
    var site = findSiteRow_(params.site_id);
    if (!site) return jsonResponse_({ status: 404, message: 'Cliente/Proyecto no encontrado' });
    if (params.category !== 'OFERTAS_CONTRATOS' && params.category !== 'GENERALES') {
      return jsonResponse_({ status: 400, message: 'category debe ser OFERTAS_CONTRATOS o GENERALES — los certificados de prueba los sube el sistema, no la subida manual' });
    }
    if (!params.file_base64) return jsonResponse_({ status: 400, message: 'file_base64 es obligatorio' });

    var folders = ensureSiteFolders_(site);
    var targetFolderId = params.category === 'OFERTAS_CONTRATOS' ? folders.ofertasFolderId : folders.documentosFolderId;
    var fileName = params.file_name || ('documento_' + Date.now());
    var saved = saveFileToDriveIn_(targetFolderId, stripBase64Prefix_(params.file_base64), fileName, params.file_mime_type || 'application/octet-stream');

    var id = generateId_();
    appendRow_('DOCUMENTOS', {
      id: id,
      site_id: params.site_id,
      category: params.category,
      file_name: fileName,
      file_id: saved.fileId,
      mime_type: params.file_mime_type || '',
      uploaded_by: auth.username || 'desconocido',
      created_at: new Date().toISOString()
    });

    return jsonResponse_({ status: 201, message: 'Documento subido', data: { id: id, url: saved.url } });
  });
}

/** Listado + filtro (cliente/tipo — la fecha se filtra en el frontend sobre
 *  este mismo listado). Rechazo explícito por rol, mismo patrón que
 *  deleteTransformer_/deleteSite_: un Técnico solo puede subir, nunca listar
 *  ni descargar documentos de otros — no basta con ocultar el botón en la UI. */
function listDocuments_(params, auth) {
  if (auth.role === 'Tecnico') {
    return jsonResponse_({ status: 403, message: 'Los técnicos pueden subir documentos, pero no listarlos ni descargarlos' });
  }
  var sheet = getSheet_('DOCUMENTOS');
  var data = sheet.getDataRange().getValues();
  var result = [];
  for (var r = 1; r < data.length; r++) {
    var row = rowToObject_(data[r], 'DOCUMENTOS', r + 1);
    if (params.site_id && row.site_id !== params.site_id) continue;
    if (params.category && row.category !== params.category) continue;
    result.push({
      id: row.id,
      site_id: row.site_id,
      category: row.category,
      file_name: row.file_name,
      url: driveFileUrl_(row.file_id),
      uploaded_by: row.uploaded_by,
      created_at: row.created_at
    });
  }
  return jsonResponse_({ status: 200, data: result });
}

/** Solo Administrador, mismo patrón que deleteTransformer_/deleteSite_.
 *  Borra una fila del índice DOCUMENTOS — no borra el archivo real en Drive
 *  (mismo criterio que deleteTransformer_ con PRUEBAS: borra el índice, no
 *  los certificados ya subidos). Pensada para limpiar filas huérfanas (p.
 *  ej. de un Sitio borrado antes de que deleteSite_ hiciera cascada sobre
 *  DOCUMENTOS) o subidas manuales erróneas. */
function deleteDocument_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede eliminar documentos' });
  }
  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var sheet = getSheet_('DOCUMENTOS');
    var data = sheet.getDataRange().getValues();
    var idCol = HEADERS.DOCUMENTOS.indexOf('id');
    for (var r = 1; r < data.length; r++) {
      if (data[r][idCol] === params.id) {
        sheet.deleteRow(r + 1);
        return jsonResponse_({ status: 200, message: 'Documento eliminado' });
      }
    }
    return jsonResponse_({ status: 404, message: 'Documento no encontrado' });
  });
}

/** Solo Administrador. Crea (si hacen falta) la carpeta raíz del proyecto y
 *  Calibraciones/ a nivel de proyecto — nada en el flujo normal de la app
 *  las dispara todavía (Calibraciones no tiene módulo construido, y la
 *  carpeta raíz normalmente aparece sola la primera vez que se sube un
 *  certificado o documento). Útil para dejar la estructura de Drive lista
 *  de una vez al desplegar en una cuenta nueva, sin depender de que ocurra
 *  la primera subida. Idempotente — reintentarla no crea duplicados. */
function ensureDriveStructure_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede inicializar la estructura de Drive' });
  }
  return withLock_(function () {
    var root = getRootFolder_();
    var calibraciones = getCalibracionesFolder_();
    return jsonResponse_({
      status: 200,
      message: 'Estructura de Drive lista',
      data: { rootFolderId: root.getId(), calibracionesFolderId: calibraciones.getId() }
    });
  });
}

// ---------------------------------------------------------------------------
// Comercial — Ofertas y Licitaciones
//
// RBAC: "Sin acceso" para Técnico en TODAS las acciones de este módulo (no
// solo lectura como Documentos) — cada handler rechaza con 403 de entrada,
// antes de cualquier otra validación.
// ---------------------------------------------------------------------------

function checkComercialAccess_(auth) {
  if (auth.role === 'Tecnico') {
    return jsonResponse_({ status: 403, message: 'No tienes acceso al módulo Comercial' });
  }
  return null;
}

function findOfertaRow_(id) {
  var sheet = getSheet_('OFERTAS');
  var data = sheet.getDataRange().getValues();
  var idCol = HEADERS.OFERTAS.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (data[r][idCol] === id) return rowToObject_(data[r], 'OFERTAS', r + 1);
  }
  return null;
}

/** 'Cierre' nunca se guarda en la hoja — se deriva al leer: `fecha_cierre` ya
 *  pasó y el estado guardado sigue siendo 'Pendiente'. Una oferta ya resuelta
 *  (Aprobada/Rechazada) no cae en Cierre aunque la fecha haya pasado. */
function computeOfertaEstado_(row) {
  if (row.estado === 'Pendiente' && row.fecha_cierre) {
    // Sheets autoconvierte una celda que "parece fecha" (p. ej. "2026-08-15"
    // escrita por setValue/appendRow) a un objeto Date real al leerla — NO
    // sigue siendo el string original. Concatenar texto sobre un Date llama
    // a su toString() y produce basura que new Date() no puede parsear
    // (Invalid Date, sin lanzar error) — por eso hay que distinguir los dos
    // casos en vez de asumir que siempre es string.
    var cierre = (row.fecha_cierre instanceof Date) ? row.fecha_cierre : new Date(row.fecha_cierre + 'T23:59:59');
    if (!isNaN(cierre.getTime()) && cierre.getTime() < Date.now()) return 'Cierre';
  }
  return row.estado;
}

function ofertaRowToJson_(row) {
  return {
    id: row.id,
    cliente_nombre: row.cliente_nombre,
    site_id: row.site_id || null,
    tipo: row.tipo,
    descripcion: row.descripcion || '',
    valor_cotizado: row.valor_cotizado,
    fecha_envio: row.fecha_envio,
    fecha_cierre: row.fecha_cierre,
    estado: computeOfertaEstado_(row),
    estado_real: row.estado,
    responsable: row.responsable || '',
    adjunto_propuesta_url: row.adjunto_propuesta_file_id ? driveFileUrl_(row.adjunto_propuesta_file_id) : null,
    adjunto_contrato_url: row.adjunto_contrato_file_id ? driveFileUrl_(row.adjunto_contrato_file_id) : null,
    bitacora: safeParseJson_(row.bitacora_json) || [],
    estado_changed_at: row.estado_changed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** Mueve (no copia) los adjuntos existentes de una oferta a la carpeta
 *  "Ofertas y Contratos" del Sitio recién vinculado — el fileId no cambia,
 *  solo su carpeta contenedora. Se llama SOLO cuando site_id pasa de vacío
 *  a tener valor en updateOferta_. */
function moveOfertaAttachmentsToSite_(row, ofertasFolderId) {
  var targetFolder = DriveApp.getFolderById(ofertasFolderId);
  [row.adjunto_propuesta_file_id, row.adjunto_contrato_file_id].forEach(function (fileId) {
    if (!fileId) return;
    try {
      DriveApp.getFileById(fileId).moveTo(targetFolder);
    } catch (e) {
      // Archivo borrado/inaccesible: no se puede mover, pero no debe tumbar el resto de la actualización.
    }
  });
}

function createOferta_(params, auth) {
  var denied = checkComercialAccess_(auth);
  if (denied) return denied;

  return withLock_(function () {
    if (!params.cliente_nombre) return jsonResponse_({ status: 400, message: 'cliente_nombre es obligatorio' });
    if (params.tipo !== 'OFERTA_DIRECTA' && params.tipo !== 'LICITACION_PUBLICA') {
      return jsonResponse_({ status: 400, message: 'tipo debe ser OFERTA_DIRECTA o LICITACION_PUBLICA' });
    }

    var site = null;
    if (params.site_id) {
      site = findSiteRow_(params.site_id);
      if (!site) return jsonResponse_({ status: 404, message: 'El Sitio indicado no existe' });
    }

    var propuestaFileId = '';
    if (params.file_base64) {
      var targetFolderId = site ? ensureSiteFolders_(site).ofertasFolderId : getProspectosSinClienteFolder_().getId();
      var saved = saveFileToDriveIn_(targetFolderId, stripBase64Prefix_(params.file_base64), params.file_name || ('propuesta_' + Date.now()), params.file_mime_type || 'application/octet-stream');
      propuestaFileId = saved.fileId;
    }

    var id = generateId_();
    appendRow_('OFERTAS', {
      id: id,
      cliente_nombre: params.cliente_nombre,
      site_id: params.site_id || '',
      tipo: params.tipo,
      descripcion: params.descripcion || '',
      valor_cotizado: params.valor_cotizado || '',
      fecha_envio: params.fecha_envio || '',
      fecha_cierre: params.fecha_cierre || '',
      estado: 'Pendiente',
      responsable: params.responsable || '',
      adjunto_propuesta_file_id: propuestaFileId,
      adjunto_contrato_file_id: '',
      bitacora_json: JSON.stringify([]),
      estado_changed_at: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return jsonResponse_({ status: 201, message: 'Oferta creada', data: { id: id } });
  });
}

/**
 * Actualiza campos + adjuntos + estado. Reglas:
 * - `estado` en el payload solo puede ser 'Aprobada' o 'Rechazada' — 'Cierre'
 *   nunca se escribe (es derivado) y 'Pendiente' es el default de creación,
 *   no algo a lo que se pueda "volver" manualmente por esta vía.
 * - Si `site_id` llega y la fila no tenía uno todavía, se vinculan las 4
 *   carpetas del Sitio y se MUEVEN los adjuntos existentes hacia allá.
 * - Un archivo nuevo en este mismo request va directo a la carpeta correcta
 *   (la del Sitio si ya está vinculado — con el que acaba de llegar o el que
 *   ya tenía —, o prospectos si sigue sin cliente).
 */
function updateOferta_(params, auth) {
  var denied = checkComercialAccess_(auth);
  if (denied) return denied;

  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var row = findOfertaRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Oferta no encontrada' });

    var updates = {};
    ['cliente_nombre', 'tipo', 'descripcion', 'valor_cotizado', 'fecha_envio', 'fecha_cierre', 'responsable'].forEach(function (field) {
      if (params[field] !== undefined) updates[field] = params[field];
    });

    if (params.estado !== undefined) {
      if (params.estado !== 'Aprobada' && params.estado !== 'Rechazada') {
        return jsonResponse_({ status: 400, message: 'estado solo se puede cambiar manualmente a Aprobada o Rechazada' });
      }
      updates.estado = params.estado;
      updates.estado_changed_at = new Date().toISOString();
    }

    var linkingNewSite = params.site_id !== undefined && params.site_id && !row.site_id;
    var effectiveSiteId = params.site_id !== undefined ? params.site_id : row.site_id;
    var site = null;
    if (linkingNewSite || (params.file_base64 && effectiveSiteId)) {
      site = findSiteRow_(effectiveSiteId);
      if (!site) return jsonResponse_({ status: 404, message: 'El Sitio indicado no existe' });
    }
    if (linkingNewSite) {
      updates.site_id = params.site_id;
      var folders = ensureSiteFolders_(site);
      moveOfertaAttachmentsToSite_(row, folders.ofertasFolderId);
    }

    if (params.file_base64) {
      var targetFolderId = site ? ensureSiteFolders_(site).ofertasFolderId : getProspectosSinClienteFolder_().getId();
      var saved = saveFileToDriveIn_(targetFolderId, stripBase64Prefix_(params.file_base64), params.file_name || ('adjunto_' + Date.now()), params.file_mime_type || 'application/octet-stream');
      var slot = params.file_slot === 'contrato' ? 'adjunto_contrato_file_id' : 'adjunto_propuesta_file_id';
      updates[slot] = saved.fileId;
    }

    updates.updated_at = new Date().toISOString();

    var sheet = getSheet_('OFERTAS');
    Object.keys(updates).forEach(function (field) {
      sheet.getRange(row._row, colIndex_('OFERTAS', field)).setValue(updates[field]);
    });

    return jsonResponse_({ status: 200, message: 'Oferta actualizada' });
  });
}

/** Agrega una nota a la bitácora sin tener que reenviar el resto del formulario. */
function addOfertaNota_(params, auth) {
  var denied = checkComercialAccess_(auth);
  if (denied) return denied;

  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    if (!params.nota) return jsonResponse_({ status: 400, message: 'nota es obligatoria' });
    var row = findOfertaRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Oferta no encontrada' });

    var bitacora = safeParseJson_(row.bitacora_json) || [];
    bitacora.push({ fecha: new Date().toISOString(), autor: auth.username || 'desconocido', nota: params.nota });

    var sheet = getSheet_('OFERTAS');
    sheet.getRange(row._row, colIndex_('OFERTAS', 'bitacora_json')).setValue(JSON.stringify(bitacora));
    sheet.getRange(row._row, colIndex_('OFERTAS', 'updated_at')).setValue(new Date().toISOString());

    return jsonResponse_({ status: 200, message: 'Nota agregada' });
  });
}

/** Solo Administrador (más estricto que el resto de Comercial, que ya es
 *  Sin acceso para Técnico) — mismo criterio que deleteTransformer_/
 *  deleteSite_: borrar es más sensible que crear/editar, se reserva al rol
 *  más alto aunque Supervisor tenga Full en el resto del módulo. */
function deleteOferta_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede eliminar ofertas' });
  }
  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var row = findOfertaRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Oferta no encontrada' });
    getSheet_('OFERTAS').deleteRow(row._row);
    return jsonResponse_({ status: 200, message: 'Oferta eliminada' });
  });
}

function listOfertas_(params, auth) {
  var denied = checkComercialAccess_(auth);
  if (denied) return denied;

  var sheet = getSheet_('OFERTAS');
  var data = sheet.getDataRange().getValues();
  var result = [];
  for (var r = 1; r < data.length; r++) {
    var row = rowToObject_(data[r], 'OFERTAS', r + 1);
    if (params.site_id && row.site_id !== params.site_id) continue;
    result.push(ofertaRowToJson_(row));
  }
  return jsonResponse_({ status: 200, data: result });
}

// ---------------------------------------------------------------------------
// Calibraciones — catálogo de instrumentos propios de M&A
//
// RBAC: Técnico tiene SOLO LECTURA (ve catálogo y semáforo) — listCalibraciones_
// no rechaza a ningún rol. Crear/editar/borrar rechaza a Técnico con 403 vía
// checkCalibracionesWriteAccess_, mismo patrón que checkComercialAccess_.
// ---------------------------------------------------------------------------

function checkCalibracionesWriteAccess_(auth) {
  if (auth.role === 'Tecnico') {
    return jsonResponse_({ status: 403, message: 'Los técnicos pueden ver el catálogo de Calibraciones, pero no crear, editar ni eliminar instrumentos' });
  }
  return null;
}

function findCalibracionRow_(id) {
  var sheet = getSheet_('CALIBRACIONES');
  var data = sheet.getDataRange().getValues();
  var idCol = HEADERS.CALIBRACIONES.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (data[r][idCol] === id) return rowToObject_(data[r], 'CALIBRACIONES', r + 1);
  }
  return null;
}

function calibracionRowToJson_(row) {
  return {
    id: row.id,
    modelo: row.modelo,
    numero_serie: row.numero_serie,
    fabricante: row.fabricante || '',
    fecha_ultima_calibracion: row.fecha_ultima_calibracion || null,
    fecha_proxima_calibracion: row.fecha_proxima_calibracion || null,
    ente_acreditado: row.ente_acreditado || '',
    certificado_url: row.certificado_adjunto_file_id ? driveFileUrl_(row.certificado_adjunto_file_id) : null,
    estado: computeCalibracionEstado_(row.fecha_proxima_calibracion),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function createCalibracion_(params, auth) {
  var denied = checkCalibracionesWriteAccess_(auth);
  if (denied) return denied;

  return withLock_(function () {
    if (!params.modelo || !params.numero_serie || !params.fecha_proxima_calibracion) {
      return jsonResponse_({ status: 400, message: 'modelo, numero_serie y fecha_proxima_calibracion son obligatorios' });
    }

    var id = generateId_();
    var attachmentId = '';
    if (params.file_base64) {
      var saved = saveFileToDriveIn_(
        getCalibracionesFolder_().getId(),
        stripBase64Prefix_(params.file_base64),
        'calibracion_' + params.numero_serie + '_' + Date.now(),
        params.file_mime_type || 'application/octet-stream'
      );
      attachmentId = saved.fileId;
    }

    appendRow_('CALIBRACIONES', {
      id: id,
      modelo: params.modelo,
      numero_serie: params.numero_serie,
      fabricante: params.fabricante || '',
      fecha_ultima_calibracion: params.fecha_ultima_calibracion || '',
      fecha_proxima_calibracion: params.fecha_proxima_calibracion,
      ente_acreditado: params.ente_acreditado || '',
      certificado_adjunto_file_id: attachmentId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return jsonResponse_({ status: 201, message: 'Instrumento registrado', data: { id: id } });
  });
}

function updateCalibracion_(params, auth) {
  var denied = checkCalibracionesWriteAccess_(auth);
  if (denied) return denied;

  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var row = findCalibracionRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Instrumento no encontrado' });

    var updates = {};
    ['modelo', 'numero_serie', 'fabricante', 'fecha_ultima_calibracion',
      'fecha_proxima_calibracion', 'ente_acreditado'].forEach(function (field) {
      if (params[field] !== undefined) updates[field] = params[field];
    });

    if (params.file_base64) {
      var saved = saveFileToDriveIn_(
        getCalibracionesFolder_().getId(),
        stripBase64Prefix_(params.file_base64),
        'calibracion_' + (params.numero_serie || row.numero_serie) + '_' + Date.now(),
        params.file_mime_type || 'application/octet-stream'
      );
      updates.certificado_adjunto_file_id = saved.fileId;
    }

    updates.updated_at = new Date().toISOString();

    var sheet = getSheet_('CALIBRACIONES');
    Object.keys(updates).forEach(function (field) {
      sheet.getRange(row._row, colIndex_('CALIBRACIONES', field)).setValue(updates[field]);
    });

    return jsonResponse_({ status: 200, message: 'Instrumento actualizado' });
  });
}

function deleteCalibracion_(params, auth) {
  var denied = checkCalibracionesWriteAccess_(auth);
  if (denied) return denied;

  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var row = findCalibracionRow_(params.id);
    if (!row) return jsonResponse_({ status: 404, message: 'Instrumento no encontrado' });
    getSheet_('CALIBRACIONES').deleteRow(row._row);
    return jsonResponse_({ status: 200, message: 'Instrumento eliminado' });
  });
}

function listCalibraciones_(params) {
  var sheet = getSheet_('CALIBRACIONES');
  var data = sheet.getDataRange().getValues();
  var result = [];
  for (var r = 1; r < data.length; r++) {
    result.push(calibracionRowToJson_(rowToObject_(data[r], 'CALIBRACIONES', r + 1)));
  }
  return jsonResponse_({ status: 200, data: result });
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
  submitOilAnalysisTest: submitOilAnalysisTest_,
  uploadDocument: uploadDocument_,
  deleteDocument: deleteDocument_,
  ensureDriveStructure: ensureDriveStructure_,
  createOferta: createOferta_,
  updateOferta: updateOferta_,
  addOfertaNota: addOfertaNota_,
  deleteOferta: deleteOferta_,
  createCalibracion: createCalibracion_,
  updateCalibracion: updateCalibracion_,
  deleteCalibracion: deleteCalibracion_,
  uploadLogoAsset: uploadLogoAsset_
};

var GET_ACTIONS = {
  listSites: listSites_,
  listTransformers: listTransformers_,
  getTransformer: getTransformer_,
  listTests: listTests_,
  listDocuments: listDocuments_,
  listOfertas: listOfertas_,
  listCalibraciones: listCalibraciones_
};
