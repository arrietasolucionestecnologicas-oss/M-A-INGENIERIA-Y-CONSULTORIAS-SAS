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
  /* ttr_ofertado/resistencia_devanados_ofertado/aislamiento_ofertado
     (2026-09-12) — alcance de pruebas eléctricas ofertado para ESTE equipo,
     igual que las 3 secciones activables de Aceite: el técnico marca cuáles
     van. Van al final por la misma regla de "nunca insertar entre
     columnas existentes" de la nota de arriba. Ver normalizeOfertado_. */
  TRANSFORMADORES: [
    'id', 'site_id', 'serial_number', 'manufacturer', 'manufacture_year',
    'phase_type', 'vector_group', 'rated_power_kva', 'hv_nominal_voltage', 'lv_nominal_voltage',
    'tap_config_json', 'is_special_design', 'custom_tap_ratio_matrix_json',
    'estado_equipo', 'plate_photo_file_id', 'created_at', 'updated_at',
    'cooling_type', 'impedance_percent', 'insulation_type',
    'numero_posiciones_tap', 'electrical_report_file_id', 'posicion_tap_nominal',
    'ttr_ofertado', 'resistencia_devanados_ofertado', 'aislamiento_ofertado',
    'at_devanado_material', 'bt_devanado_material'
  ],
  PRUEBAS: [
    'id', 'transformer_id', 'test_type', 'raw_readings_json',
    'calculated_results_json', 'verdict', 'instrument_used', 'tested_by',
    'attachment_file_id', 'created_at', 'report_file_id',
    'estado_certificacion', 'revisado_por', 'revisado_at', 'operador_nombre',
    'temperatura_ambiente', 'humedad_relativa'
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

/** Flujo de certificación de pruebas (2026-09-05): toda prueba nace en
 *  'Borrador' — ver persistTest_ — y un Supervisor o Administrador la mueve
 *  a 'Certificada' (certifyTest_, dispara la generación del PDF/informe
 *  combinado en ese momento, nunca antes) o 'Rechazada' (rejectTest_,
 *  nunca genera nada, pero la fila nunca se borra — queda registrado que
 *  existió). Migración perezosa igual que estado_equipo: cualquier fila
 *  vieja (de antes de este cambio, sin esta columna) se trata como
 *  'Certificada' — ya tenían su informe generado y forman parte del
 *  historial oficial, no tiene sentido pedirles certificación retroactiva. */
var ESTADO_CERTIFICACION_VALUES = ['Borrador', 'Certificada', 'Rechazada'];
function normalizeEstadoCertificacion_(value) {
  return ESTADO_CERTIFICACION_VALUES.indexOf(value) !== -1 ? value : 'Certificada';
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

/** Alcance de pruebas eléctricas ofertadas por transformador (2026-09-12) —
 *  a diferencia de isTruthy_ (por defecto false), acá lo por-defecto-ausente
 *  es TRUE: un equipo creado antes de que este campo existiera se trata
 *  como "todas ofertadas" — el mismo comportamiento sin restricción que ya
 *  tenía en producción, nunca debe quedar bloqueado retroactivamente. Solo
 *  un false explícito (el técnico desmarcó el checkbox en un equipo nuevo)
 *  saca una prueba del alcance. */
function normalizeOfertado_(v) {
  if (typeof v === 'boolean') return v;
  var s = String(v).trim().toUpperCase();
  return s !== 'FALSE' && s !== '0' && s !== 'NO';
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
    ttr_ofertado: normalizeOfertado_(row.ttr_ofertado),
    resistencia_devanados_ofertado: normalizeOfertado_(row.resistencia_devanados_ofertado),
    aislamiento_ofertado: normalizeOfertado_(row.aislamiento_ofertado),
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
    if (params.posicion_tap_nominal) {
      var createTapCount = params.numero_posiciones_tap || 5;
      if (params.posicion_tap_nominal < 1 || params.posicion_tap_nominal > createTapCount) {
        return jsonResponse_({ status: 400, message: 'posicion_tap_nominal debe estar entre 1 y ' + createTapCount });
      }
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
      posicion_tap_nominal: params.posicion_tap_nominal || '',
      ttr_ofertado: !!params.ttr_ofertado,
      resistencia_devanados_ofertado: !!params.resistencia_devanados_ofertado,
      aislamiento_ofertado: !!params.aislamiento_ofertado,
      // Material del devanado AT/BT (2026-09-13) — dato de placa, usado en el
      // banner de la tabla unificada de resultados eléctricos (ver
      // buildWindingSideUnifiedRows_ en la sección de informes).
      at_devanado_material: params.at_devanado_material || '',
      bt_devanado_material: params.bt_devanado_material || ''
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

    if (params.posicion_tap_nominal) {
      var updateTapCount = params.numero_posiciones_tap || row.numero_posiciones_tap || 5;
      if (params.posicion_tap_nominal < 1 || params.posicion_tap_nominal > updateTapCount) {
        return jsonResponse_({ status: 400, message: 'posicion_tap_nominal debe estar entre 1 y ' + updateTapCount });
      }
    }

    var updates = {};
    ['serial_number', 'manufacturer', 'manufacture_year', 'phase_type', 'vector_group', 'rated_power_kva',
      'hv_nominal_voltage', 'lv_nominal_voltage', 'site_id',
      'cooling_type', 'impedance_percent', 'insulation_type', 'numero_posiciones_tap', 'posicion_tap_nominal',
      'at_devanado_material', 'bt_devanado_material'].forEach(function (field) {
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
    if (params.ttr_ofertado !== undefined) updates.ttr_ofertado = !!params.ttr_ofertado;
    if (params.resistencia_devanados_ofertado !== undefined) updates.resistencia_devanados_ofertado = !!params.resistencia_devanados_ofertado;
    if (params.aislamiento_ofertado !== undefined) updates.aislamiento_ofertado = !!params.aislamiento_ofertado;

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

/** Busca una fila de PRUEBAS por id — no existía antes porque nada necesitaba
 *  releer una prueba puntual (solo se insertaban o se listaban todas); hizo
 *  falta con el flujo de certificación (certifyTest_/rejectTest_). Mismo
 *  patrón que findTransformerRow_/findSiteRow_/etc. */
function findTestRow_(id) {
  var sheet = getSheet_('PRUEBAS');
  var data = sheet.getDataRange().getValues();
  var idCol = HEADERS.PRUEBAS.indexOf('id');
  for (var r = 1; r < data.length; r++) {
    if (data[r][idCol] === id) return rowToObject_(data[r], 'PRUEBAS', r + 1);
  }
  return null;
}

/**
 * Toda prueba nace en estado 'Borrador' — nunca genera ningún PDF ni
 * modifica el informe combinado del equipo en este momento. Antes
 * (2026-08-30 y anterior) esta función generaba el informe/certificado de
 * inmediato al guardar; el usuario reportó que eso es una falla real: una
 * prueba enviada por error (un ensayo del formulario, un dato mal digitado)
 * quedaba de inmediato como el informe oficial vigente del equipo, sin que
 * nadie la hubiera revisado. Ahora la generación del PDF se movió por
 * completo a certifyTest_ — ver ahí.
 *
 * El adjunto crudo que el técnico sube junto con la prueba (foto/PDF de
 * evidencia de campo) SÍ se sigue subiendo de inmediato, sin esperar
 * certificación — es evidencia de respaldo del técnico, no el informe
 * oficial generado por el sistema, así que no aplica la misma regla.
 */
function persistTest_(transformer, testType, rawReadings, calculated, params, auth) {
  var site = findSiteRow_(transformer.site_id);
  var folders = ensureSiteFolders_(site);

  var attachmentId = '';
  if (params.file_base64) {
    var fileName = testType.toLowerCase() + '_' + transformer.serial_number + '_' + Date.now();
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
    report_file_id: '',
    estado_certificacion: 'Borrador',
    revisado_por: '',
    revisado_at: '',
    operador_nombre: params.operador_nombre || '',
    temperatura_ambiente: params.temperatura_ambiente || '',
    humedad_relativa: params.humedad_relativa || ''
  });

  return { id: id, calculated_results: calculated, report_url: null, estado_certificacion: 'Borrador' };
}

/**
 * Solo Supervisor o Administrador (nunca el mismo Técnico que registró la
 * prueba, por diseño — es una revisión de un segundo par de ojos). Mueve
 * una prueba de 'Borrador' a 'Certificada'. Certificar una prueba ya
 * certificada o ya rechazada no está permitido.
 *
 * Para Aceite dieléctrico, certificar SÍ genera de una vez su propio
 * informe (un análisis de muestra puntual, un informe por envío, ver
 * generateOilTestReportPdf_ — esto no cambió).
 *
 * Para TTR/Devanados/Aislamiento, certificar una prueba individual NO
 * genera ningún PDF (cambio 2026-09-12, a pedido explícito del usuario):
 * el informe eléctrico consolidado de un equipo solo se genera con la
 * acción separada "Certificar Pruebas Eléctricas" (ver
 * certifyElectricalReport_ más abajo), que exige que TODAS las pruebas
 * ofertadas para ese equipo estén Certificada antes de generar un único
 * PDF con esas secciones — nunca uno parcial por cada prueba suelta.
 */
function certifyTest_(params, auth) {
  return withLock_(function () {
    if (auth.role === 'Tecnico') {
      return jsonResponse_({ status: 403, message: 'Solo un Supervisor o Administrador puede certificar una prueba' });
    }
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var testObj = findTestRow_(params.id);
    if (!testObj) return jsonResponse_({ status: 404, message: 'Prueba no encontrada' });

    var currentEstado = normalizeEstadoCertificacion_(testObj.estado_certificacion);
    if (currentEstado !== 'Borrador') {
      return jsonResponse_({ status: 400, message: 'Esta prueba ya fue ' + (currentEstado === 'Certificada' ? 'certificada' : 'rechazada') + ' — no se puede certificar de nuevo' });
    }

    var transformer = findTransformerRow_(testObj.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
    var site = findSiteRow_(transformer.site_id);
    var folders = ensureSiteFolders_(site);
    var calculated = safeParseJson_(testObj.calculated_results_json);
    var rawReadings = safeParseJson_(testObj.raw_readings_json);
    var reportFileId = '';
    var revisadoPor = auth.username || 'desconocido';
    var revisadoAt = new Date().toISOString();

    // Estado y revisor se escriben ANTES de generar cualquier informe —
    // corregido (2026-09-12): con el orden anterior (generar primero,
    // escribir después), findLatestElectricalTestsByType_ todavía veía esta
    // misma fila como 'Borrador' en el momento de armar el informe eléctrico
    // combinado (su filtro exige 'Certificada'), así que el combinado se
    // regeneraba sin la prueba que se acababa de certificar si era la más
    // reciente de su tipo — quedaba un paso atrás hasta la siguiente
    // certificación. Con el estado ya escrito, tanto el combinado como el
    // bloque de firmas (que necesita revisado_por/revisado_at reales) ven el
    // dato correcto.
    var sheet = getSheet_('PRUEBAS');
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'estado_certificacion')).setValue('Certificada');
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'revisado_por')).setValue(revisadoPor);
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'revisado_at')).setValue(revisadoAt);

    if (testObj.test_type === 'ACEITE_DIELECTRICO') {
      // Un informe por prueba — nunca debe impedir la certificación en sí:
      // si falla la generación, la prueba igual queda Certificada, solo sin PDF.
      try {
        var oilTestMeta = {
          created_at: testObj.created_at,
          tested_by: testObj.tested_by,
          operador_nombre: testObj.operador_nombre,
          revisado_por: revisadoPor,
          revisado_at: revisadoAt,
          instrument_used: testObj.instrument_used,
          attachment_url: testObj.attachment_file_id ? driveFileUrl_(testObj.attachment_file_id) : null
        };
        var oilReport = generateOilTestReportPdf_(transformer, site, rawReadings, calculated, oilTestMeta, folders.certificadosFolderId);
        reportFileId = oilReport.fileId;
        appendRow_('DOCUMENTOS', {
          id: generateId_(),
          site_id: transformer.site_id,
          category: 'CERTIFICADOS',
          file_name: 'Informe_' + TEST_TYPE_LABELS_[testObj.test_type] + '_' + transformer.serial_number,
          file_id: reportFileId,
          mime_type: 'application/pdf',
          uploaded_by: auth.username || 'desconocido',
          created_at: new Date().toISOString()
        });
      } catch (reportErr) {
        // No relanzar.
      }
    }
    // TTR/RESISTENCIA_DEVANADOS/AISLAMIENTO: certificar la prueba individual
    // ya no genera ningún PDF aquí — ver certifyElectricalReport_.

    if (reportFileId) sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'report_file_id')).setValue(reportFileId);

    return jsonResponse_({ status: 200, message: 'Prueba certificada', data: { id: params.id, report_url: reportFileId ? driveFileUrl_(reportFileId) : null } });
  });
}

/**
 * "Certificar Pruebas Eléctricas" — UNA sola certificación por trabajo
 * (transformador), no una por cada tipo de prueba (2026-09-12, a pedido
 * explícito del usuario). Fuente de verdad del alcance: los 3 checkboxes
 * ofertado del transformador (ttr_ofertado/resistencia_devanados_ofertado/
 * aislamiento_ofertado, ver normalizeOfertado_) — el mismo patrón que ya
 * usa Aceite para sus 3 secciones activables.
 *
 * Solo queda disponible cuando TODAS las pruebas ofertadas para este
 * equipo ya están Certificada (findLatestElectricalTestsByType_ ya
 * filtra por eso). Si falta alguna, no genera nada y devuelve 400 con el
 * detalle de qué falta. Si todas están completas, genera UN SOLO PDF
 * consolidado con únicamente esas secciones (regenerateElectricalCombinedReport_
 * ahora recibe el alcance explícito, no infiere "lo que exista").
 *
 * Los técnicos siguen registrando/guardando cada prueba individual sin
 * ningún bloqueo, en cualquier momento — esto no cambia; esta acción es
 * puramente la certificación consolidada del trabajo completo.
 */
function certifyElectricalReport_(params, auth) {
  return withLock_(function () {
    if (auth.role === 'Tecnico') {
      return jsonResponse_({ status: 403, message: 'Solo un Supervisor o Administrador puede certificar Pruebas Eléctricas' });
    }
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(params.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
    var site = findSiteRow_(transformer.site_id);
    if (!site) return jsonResponse_({ status: 404, message: 'Cliente/Proyecto no encontrado' });

    var scope = {
      TTR: normalizeOfertado_(transformer.ttr_ofertado),
      RESISTENCIA_DEVANADOS: normalizeOfertado_(transformer.resistencia_devanados_ofertado),
      AISLAMIENTO: normalizeOfertado_(transformer.aislamiento_ofertado)
    };
    var requiredTypes = Object.keys(scope).filter(function (t) { return scope[t]; });
    if (requiredTypes.length === 0) {
      return jsonResponse_({ status: 400, message: 'Este equipo no tiene ninguna prueba eléctrica marcada como ofertada — revisa el alcance en "Editar equipo".' });
    }

    var latest = findLatestElectricalTestsByType_(transformer.id);
    var missing = requiredTypes.filter(function (t) { return !latest[t]; });
    if (missing.length > 0) {
      var missingLabels = missing.map(function (t) { return TEST_TYPE_DISPLAY_LABEL_[t]; });
      return jsonResponse_({
        status: 400,
        message: 'Faltan por certificar: ' + missingLabels.join(', ') + '. Certifica esas pruebas individuales primero.',
        data: { missing: missing }
      });
    }

    var folders = ensureSiteFolders_(site);
    var report = regenerateElectricalCombinedReport_(transformer, site, folders.certificadosFolderId, auth.username, requiredTypes);
    if (!report) {
      return jsonResponse_({ status: 500, message: 'No se pudo generar el informe — inténtalo de nuevo.' });
    }

    return jsonResponse_({ status: 200, message: 'Pruebas Eléctricas certificadas', data: { report_url: driveFileUrl_(report.fileId) } });
  });
}

/**
 * Solo Supervisor o Administrador. Mueve una prueba de 'Borrador' a
 * 'Rechazada' — nunca genera ni modifica ningún PDF, y la fila NUNCA se
 * borra (a pedido explícito del usuario: "debe quedar registrado que
 * existió"). Una prueba rechazada nunca participa en
 * findLatestElectricalTestsByType_ (que solo considera Certificadas), así
 * que no puede terminar apareciendo en el informe combinado por error.
 */
function rejectTest_(params, auth) {
  return withLock_(function () {
    if (auth.role === 'Tecnico') {
      return jsonResponse_({ status: 403, message: 'Solo un Supervisor o Administrador puede rechazar una prueba' });
    }
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var testObj = findTestRow_(params.id);
    if (!testObj) return jsonResponse_({ status: 404, message: 'Prueba no encontrada' });

    var currentEstado = normalizeEstadoCertificacion_(testObj.estado_certificacion);
    if (currentEstado !== 'Borrador') {
      return jsonResponse_({ status: 400, message: 'Esta prueba ya fue ' + (currentEstado === 'Certificada' ? 'certificada' : 'rechazada') + ' — no se puede rechazar' });
    }

    var sheet = getSheet_('PRUEBAS');
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'estado_certificacion')).setValue('Rechazada');
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'revisado_por')).setValue(auth.username || 'desconocido');
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'revisado_at')).setValue(new Date().toISOString());

    return jsonResponse_({ status: 200, message: 'Prueba rechazada' });
  });
}

/**
 * Actualiza las lecturas de una prueba que sigue en 'Borrador' — pensada
 * para el caso real de un técnico que va midiendo por partes (p. ej. TAPs de
 * TTR a lo largo de varias horas o días) y necesita seguir sumando datos al
 * mismo registro en vez de crear una prueba duplicada por cada sesión de
 * medición. Recalcula con el mismo motor que el registro original
 * (calculateTtr_/calculateWindingResistance_/calculateInsulation_/
 * calculateOilAnalysis_) y sobrescribe raw_readings_json/
 * calculated_results_json/verdict en la misma fila. NUNCA permitido si la
 * prueba ya fue Certificada o Rechazada — en ese caso el registro es
 * definitivo (o terminal) y no se toca.
 * No genera ni regenera ningún PDF/informe — eso solo ocurre en
 * certifyTest_. Sin restricción de rol (los mismos roles que pueden
 * registrar una prueba pueden seguir editándola mientras sea Borrador).
 */
function updateTestDraft_(params, auth) {
  return withLock_(function () {
    if (!params.id) return jsonResponse_({ status: 400, message: 'id es obligatorio' });
    var testObj = findTestRow_(params.id);
    if (!testObj) return jsonResponse_({ status: 404, message: 'Prueba no encontrada' });

    var currentEstado = normalizeEstadoCertificacion_(testObj.estado_certificacion);
    if (currentEstado !== 'Borrador') {
      return jsonResponse_({ status: 400, message: 'Esta prueba ya fue ' + (currentEstado === 'Certificada' ? 'certificada' : 'rechazada') + ' — ya no se puede editar' });
    }
    if (!params.readings) return jsonResponse_({ status: 400, message: 'readings es obligatorio' });

    var transformer = findTransformerRow_(testObj.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });

    var calculated;
    try {
      if (testObj.test_type === 'TTR') {
        if (!params.readings.measurements) return jsonResponse_({ status: 400, message: 'readings.measurements es obligatorio' });
        calculated = calculateTtr_(transformer, params.readings);
      } else if (testObj.test_type === 'RESISTENCIA_DEVANADOS') {
        if (!params.readings.measurements) return jsonResponse_({ status: 400, message: 'readings.measurements es obligatorio' });
        calculated = calculateWindingResistance_(params.readings);
      } else if (testObj.test_type === 'AISLAMIENTO') {
        if (!params.readings.measurements) return jsonResponse_({ status: 400, message: 'readings.measurements es obligatorio' });
        calculated = calculateInsulation_(params.readings);
      } else if (testObj.test_type === 'ACEITE_DIELECTRICO') {
        var r = params.readings;
        if (!r.fisicoquimico_realizado && !r.dga_realizado && !r.pcb_realizado) {
          return jsonResponse_({ status: 400, message: 'Activa al menos una sección (Fisicoquímico, DGA o PCB) antes de guardar' });
        }
        calculated = calculateOilAnalysis_(r);
      } else {
        return jsonResponse_({ status: 400, message: 'Tipo de prueba no reconocido' });
      }
    } catch (calcErr) {
      return jsonResponse_({ status: 422, message: calcErr.message });
    }

    var attachmentId = testObj.attachment_file_id || '';
    if (params.file_base64) {
      var site = findSiteRow_(transformer.site_id);
      var folders = ensureSiteFolders_(site);
      var fileName = testObj.test_type.toLowerCase() + '_' + transformer.serial_number + '_' + Date.now();
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

    var sheet = getSheet_('PRUEBAS');
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'raw_readings_json')).setValue(JSON.stringify(params.readings));
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'calculated_results_json')).setValue(JSON.stringify(calculated));
    sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'verdict')).setValue(calculated.overallVerdict);
    if (params.instrument_used) sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'instrument_used')).setValue(params.instrument_used);
    if (attachmentId) sheet.getRange(testObj._row, colIndex_('PRUEBAS', 'attachment_file_id')).setValue(attachmentId);

    return jsonResponse_({ status: 200, message: 'Borrador actualizado', data: { id: params.id, calculated_results: calculated, estado_certificacion: 'Borrador' } });
  });
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
      operador_nombre: obj.operador_nombre || null,
      attachment_url: obj.attachment_file_id ? driveFileUrl_(obj.attachment_file_id) : null,
      report_url: obj.report_file_id ? driveFileUrl_(obj.report_file_id) : null,
      created_at: obj.created_at,
      estado_certificacion: normalizeEstadoCertificacion_(obj.estado_certificacion),
      revisado_por: obj.revisado_por || null,
      revisado_at: obj.revisado_at || null
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
        status: status,
        nota: phaseReadings[phaseKey].nota || null
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
    phaseResults[keys[0]] = { resistanceOhm: values[0], deviationFromAvgPercent: 0, status: 'APROBADO', nota: phases[keys[0]].nota || null };
  } else {
    keys.forEach(function (k) {
      var v = phases[k].resistanceOhm;
      var deviation = ((v - avg) / avg) * 100;
      var status = Math.abs(deviation) <= UNBALANCE_THRESHOLD_PERCENT ? 'APROBADO' : 'RECHAZADO';
      phaseResults[k] = { resistanceOhm: v, deviationFromAvgPercent: deviation, status: status, nota: phases[k].nota || null };
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
  var hasSecondaryInput = !!(readings.secondary && Object.keys(readings.secondary.phases || {}).length);
  if (measurements.length === 0 && !hasSecondaryInput) {
    throw new Error('Debe incluir al menos una lectura de resistencia de devanados (primario o secundario)');
  }

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

  // `null` (no "APROBADO" por vacuidad de .every() en un arreglo vacío) cuando
  // no se probó el primario — el punto 4 (2026-09-13) permite enviar solo
  // secundario, y un primario nunca probado no debe contar como "aprobado".
  var primaryVerdict = tapResults.length > 0
    ? (tapResults.every(function (t) { return t.tapVerdict === 'APROBADO'; }) ? 'APROBADO' : 'RECHAZADO')
    : null;

  var secondaryResult = null;
  if (hasSecondaryInput) {
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

  // Combina solo las partes realmente presentes — antes del punto 4 siempre
  // había primario, así que este `every` de facto solo miraba el secundario
  // opcional; ahora cualquiera de los dos puede faltar.
  var overallVerdict = ((primaryVerdict === null || primaryVerdict === 'APROBADO') &&
    (secondaryResult === null || secondaryResult.verdict === 'APROBADO'))
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

/** Tensiones de prueba estándar de un megóhmetro — independiente del
 *  método (Completo o Simple), se guarda junto a los resultados. */
var INSULATION_TENSION_PRUEBA_VALUES = [500, 1000, 2500, 5000];
var INSULATION_UNIDAD_VALUES = ['GΩ', 'MΩ', 'KΩ'];

/**
 * Punto 5 (2026-09-13), a pedido explícito del usuario: hasta ahora esta
 * función SIEMPRE exigía R30s/R60s/R10min (para poder armar DAR e IP) —
 * eso bloqueaba al técnico cuando en campo solo se tomó una lectura simple
 * de resistencia (ej. una sola medición al minuto, sin las lecturas de
 * tiempo adicionales). Ahora `readings.metodo` decide:
 * - `'completo'` (default, compatibilidad con datos ya guardados que nunca
 *   tuvieron este campo): comportamiento EXACTO de siempre — DAR/IP con
 *   calificación BUENO/MALO/etc., obligatorios.
 * - `'simple'`: un solo valor de resistencia + su unidad por combinación,
 *   sin DAR ni IP. Sin umbral de aprobado/rechazado — nadie definió uno
 *   para este modo, así que el veredicto queda `'REGISTRADO'` (mismo
 *   criterio que DGA en Aceite: solo captura de datos, sin interpretación
 *   automática inventada).
 */
function calculateInsulation_(readings) {
  var measurements = readings.measurements || {};
  var keys = Object.keys(measurements);
  if (keys.length === 0) throw new Error('Debe incluir al menos una lectura de aislamiento');

  var metodo = readings.metodo === 'simple' ? 'simple' : 'completo';

  if (metodo === 'simple') {
    var simpleResults = {};
    keys.forEach(function (k) {
      var r = measurements[k];
      if (!(typeof r.resistenciaValor === 'number' && r.resistenciaValor > 0)) {
        throw new Error('La combinación ' + k + ' no tiene un valor de resistencia válido');
      }
      if (INSULATION_UNIDAD_VALUES.indexOf(r.resistenciaUnidad) === -1) {
        throw new Error('La combinación ' + k + ' no tiene una unidad de resistencia válida (GΩ/MΩ/KΩ)');
      }
      simpleResults[k] = { resistenciaValor: r.resistenciaValor, resistenciaUnidad: r.resistenciaUnidad, nota: r.nota || null };
    });
    return { metodo: 'simple', measurements: simpleResults, overallVerdict: 'REGISTRADO' };
  }

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
    // r60sMegaohm (2026-09-13, a pedido del cliente) = la lectura de
    // resistencia AL MINUTO — se sigue calculando DAR/IP igual que
    // siempre, pero también se imprime este valor crudo en el PDF (ver
    // buildInsulationUnifiedRows_) porque es el dato convencional que un
    // protocolo real siempre muestra, no solo los índices derivados.
    results[k] = { dar: dar, darRating: dRating, ip: ip, ipRating: iRating, r60sMegaohm: r.r60sMegaohm, nota: r.nota || null };
  });

  var overallVerdict = hasMalo ? 'RECHAZADO' : (hasCuestionable ? 'OBSERVADO' : 'APROBADO');
  return { metodo: 'completo', measurements: results, overallVerdict: overallVerdict };
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

/** Devuelve el valor si es numérico, o undefined — nunca bloquea: un análisis
 *  fisicoquímico parcial (solo algunos de los 4 parámetros) es un caso real de
 *  campo, no un error de captura. */
function optionalNumber_(value) {
  return (typeof value === 'number' && !isNaN(value)) ? value : undefined;
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
    var rigidez = optionalNumber_(readings.rigidez_dielectrica_kv);
    var agua = optionalNumber_(readings.agua_ppm);
    var acidez = optionalNumber_(readings.numero_acido_mg_koh_g);
    var tension = optionalNumber_(readings.tension_interfacial_dinas_cm);
    var anyFqValue = rigidez !== undefined || agua !== undefined || acidez !== undefined || tension !== undefined;

    if (anyFqValue) {
      // Cada umbral solo se evalúa si su parámetro fue capturado — un análisis
      // parcial (p. ej. solo rigidez + acidez, sin agua ni tensión) igual debe
      // poder detectar un problema real con los datos que sí hay, en vez de
      // quedar bloqueado esperando los 4 parámetros completos.
      var isComplete = rigidez !== undefined && agua !== undefined && acidez !== undefined && tension !== undefined;
      var fqVerdict, fqSeverity;
      if ((acidez !== undefined && acidez >= OIL_ACIDEZ_MAX_MG_KOH_G) || (tension !== undefined && tension <= OIL_TENSION_INTERFACIAL_MIN_MN_M)) {
        fqVerdict = 'REQUIERE REGENERACIÓN / CAMBIO'; fqSeverity = 3;
      } else if ((rigidez !== undefined && rigidez <= OIL_RIGIDEZ_MIN_KV) || (agua !== undefined && agua >= OIL_HUMEDAD_MAX_PPM)) {
        fqVerdict = 'REQUIERE TERMOVACÍO'; fqSeverity = 2;
      } else {
        fqVerdict = isComplete ? 'APROBADO' : 'APROBADO (datos parciales)';
        fqSeverity = 1;
      }

      sections.fisicoquimico = {
        verdict: fqVerdict,
        complete: isComplete,
        thresholds: {
          acidezMaxMgKohG: OIL_ACIDEZ_MAX_MG_KOH_G,
          tensionInterfacialMinDinasCm: OIL_TENSION_INTERFACIAL_MIN_MN_M,
          rigidezMinKv: OIL_RIGIDEZ_MIN_KV,
          aguaMaxPpm: OIL_HUMEDAD_MAX_PPM
        }
      };
      considerVerdict(fqVerdict, fqSeverity);
    } else {
      sections.fisicoquimico = { verdict: 'Sin datos', complete: false };
    }
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

/** ACCENT/ACCENT_SOFT (2026-09-13, a pedido explícito del cliente): ya NO
 *  son el azul de `--accent` en `styles.css` — el documento oficial usa
 *  gris, independiente del azul de la app en pantalla. Antes de este
 *  cambio este bloque decía explícitamente "duplicados a propósito... si
 *  cambian los colores de la app, cambiar aquí también" — eso dejó de ser
 *  cierto a propósito: el pedido fue específicamente sobre las plantillas
 *  de informe, no sobre el tema visual de la app, así que `--accent` en
 *  `styles.css` NO se tocó. El resto de estos colores (`TEXT`/`SUCCESS`/
 *  `WARNING`/`DANGER`/etc.) sigue siendo el mismo que usa la app en
 *  pantalla. */
var PDF_COLORS_ = {
  ACCENT: '#585d63',
  ACCENT_SOFT: '#e4e6e8',
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
  if (v.indexOf('APROBADO') === 0 || v === 'No contaminado') return { bg: PDF_COLORS_.SUCCESS_BG, text: PDF_COLORS_.SUCCESS };
  if (v === 'RECHAZADO' || v.indexOf('REQUIERE REGENERACIÓN') === 0 || v.indexOf('Contaminado') === 0) return { bg: PDF_COLORS_.DANGER_BG, text: PDF_COLORS_.DANGER };
  if (v === 'OBSERVADO' || v.indexOf('REQUIERE TERMOVACÍO') === 0) return { bg: PDF_COLORS_.WARNING_BG, text: PDF_COLORS_.WARNING };
  return { bg: PDF_COLORS_.NEUTRAL_BG, text: PDF_COLORS_.TEXT_MUTED };
}

/** Comparte cualquier archivo/carpeta como "cualquiera con el enlace puede
 *  editar" (2026-09-12, a pedido explícito del usuario: "el cliente no debe
 *  necesitar entrar a Drive para nada... la idea es que todo se haga desde
 *  la app"). Los técnicos/supervisores se autentican con su propio login de
 *  la app (Control de Acceso), nunca con una cuenta de Google — sin este
 *  share, Drive les pediría "solicitar acceso" al abrir cualquier enlace
 *  que la app les muestre, en vez de abrirlo directo. Se eligió acceso de
 *  EDICIÓN (no solo lectura) también a pedido explícito: el usuario quiere
 *  poder corregir un dato (fecha, nombre) directo en el archivo antes de
 *  enviarlo, sin pasar por la app. Envuelto en try/catch — nunca debe
 *  bloquear la creación real del archivo/carpeta si el share falla por
 *  algún motivo. */
function shareForEditAnyone_(driveItem) {
  try {
    driveItem.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
  } catch (e) {
    // No relanzar — el archivo/carpeta ya existe, el share es best-effort.
  }
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
  shareForEditAnyone_(file);
  PropertiesService.getScriptProperties().setProperty('LOGO_FILE_ID', file.getId());
  return jsonResponse_({ status: 200, message: 'Logo subido', data: { fileId: file.getId() } });
}

/** Firma fija del ingeniero responsable — a diferencia de PROBADO POR/
 *  CERTIFICADO POR (que cambian según quién hizo/certificó cada prueba
 *  real), esta es siempre la misma persona en todo informe que la app
 *  genera, como un sello de aprobación técnica. Nombre y título quedan
 *  fijos en código (no hay más de un ingeniero responsable hoy) — si eso
 *  cambia, hace falta editar estas dos constantes y volver a desplegar. */
var ENGINEER_SIGNATURE_NAME_ = 'Michael Peña';
var ENGINEER_SIGNATURE_TITLE_ = 'Ingeniero Eléctrico';

/** Mismo patrón que getLogoBlob_ — si nunca se subió, el informe se genera
 *  igual, solo sin esa firma (nunca debe bloquear). */
function getEngineerSignatureBlob_() {
  var id = PropertiesService.getScriptProperties().getProperty('ENGINEER_SIGNATURE_FILE_ID');
  if (!id) return null;
  try { return DriveApp.getFileById(id).getBlob(); } catch (e) { return null; }
}

/** Solo Administrador. Mismo patrón que uploadLogoAsset_. */
function uploadEngineerSignatureAsset_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede subir la firma del ingeniero' });
  }
  if (!params.file_base64) return jsonResponse_({ status: 400, message: 'file_base64 es obligatorio' });
  var root = getRootFolder_();
  var decoded = Utilities.base64Decode(stripBase64Prefix_(params.file_base64));
  var blob = Utilities.newBlob(decoded, params.file_mime_type || 'image/jpeg', 'firma-ingeniero.jpg');
  var file = root.createFile(blob);
  shareForEditAnyone_(file);
  PropertiesService.getScriptProperties().setProperty('ENGINEER_SIGNATURE_FILE_ID', file.getId());
  return jsonResponse_({ status: 200, message: 'Firma subida', data: { fileId: file.getId() } });
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
      return {
        modelo: row.modelo, numero_serie: row.numero_serie,
        estado: computeCalibracionEstado_(row.fecha_proxima_calibracion),
        fecha_ultima_calibracion: row.fecha_ultima_calibracion
      };
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
 *  color, no solo texto resaltado). Usada solo al ARMAR LAS PLANTILLAS
 *  (ver buildElectricalTemplateDoc_/buildOilTemplateDoc_ más abajo) —
 *  desde el cambio de arquitectura de plantillas (2026-09-12) los informes
 *  reales ya no arman su documento desde cero, copian la plantilla. */
function appendSectionTitle_(body, text) {
  var table = body.appendTable([[text.toUpperCase()]]);
  table.setBorderWidth(0);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(PDF_COLORS_.ACCENT);
  cell.editAsText().setBold(true).setFontSize(9).setForegroundColor('#ffffff');
  return table;
}

/** Caja de título del protocolo — borde y fondo acento suave, texto acento
 *  en mayúsculas, centrado. Va justo bajo el encabezado (logo + nombre),
 *  antes de cualquier sección de datos. Solo usada al armar plantillas. */
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
 *  strings: [etiqueta, valor, etiqueta, valor]. Solo usada al armar
 *  plantillas — en el informe real, esos mismos valores ya quedan
 *  horneados como placeholders y se llenan con `body.replaceText()`. */
function appendDenseInfoGrid_(body, rows) {
  var table = body.appendTable(rows);
  table.setBorderColor(PDF_COLORS_.BORDER);
  for (var r = 0; r < table.getNumRows(); r++) {
    var row = table.getRow(r);
    // El ancho de la columna de etiqueta se reparte según cuántos pares
    // etiqueta/valor tiene ESTA fila (115 para 2 pares, como siempre;
    // menos para filas más anchas como la grilla compartida de "Datos
    // generales de la prueba", de 3 pares — si no, las 3 etiquetas se
    // comen casi todo el ancho de página y los valores quedan sin espacio).
    var pairsInRow = row.getNumCells() / 2;
    var labelWidth = pairsInRow > 2 ? 78 : 115;
    for (var c = 0; c < row.getNumCells(); c++) {
      var cell = row.getCell(c);
      if (c % 2 === 0) {
        cell.setBackgroundColor(PDF_COLORS_.NEUTRAL_BG);
        cell.setWidth(labelWidth);
        cell.editAsText().setBold(true).setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT);
      } else {
        cell.editAsText().setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT);
      }
    }
  }
  return table;
}

/** Tabla de resultados con encabezado resaltado (fondo acento, texto
 *  blanco). Desde la tabla única de resultados eléctricos (2026-09-13),
 *  solo la usa `buildOilTemplateDoc_` para las 3 tablas de Aceite
 *  (Fisicoquímico/DGA/PCB — filas fijas, con celdas de VALOR en
 *  placeholder); TTR/Devanados/Aislamiento ya no tienen ninguna tabla
 *  horneada en la plantilla, se insertan enteras en tiempo de generación
 *  real (ver insertOuterResultsTable_). Nunca se usa en el armado del
 *  informe REAL de Aceite tampoco, que solo copia la plantilla. */
function appendResultsTable_(body, rows) {
  var table = body.appendTable(rows);
  table.setBorderColor(PDF_COLORS_.BORDER);
  var header = table.getRow(0);
  for (var c = 0; c < header.getNumCells(); c++) {
    header.getCell(c).setBackgroundColor(PDF_COLORS_.ACCENT);
    header.getCell(c).editAsText().setBold(true).setFontSize(7).setForegroundColor('#ffffff');
  }
  for (var r = 1; r < table.getNumRows(); r++) {
    for (var c2 = 0; c2 < table.getRow(r).getNumCells(); c2++) {
      table.getRow(r).getCell(c2).editAsText().setFontSize(7);
    }
  }
  return table;
}

/** Banner con estilo de advertencia (fondo/texto amarillo) — usado al
 *  armar la plantilla para el aviso "teórico no disponible/no confiable"
 *  de TTR, con un placeholder de texto en vez del mensaje real (el
 *  mensaje exacto se decide en tiempo de generación, ver
 *  regenerateElectricalCombinedReport_). */
function appendPlaceholderWarningBanner_(body, placeholderText) {
  var table = body.appendTable([[placeholderText]]);
  table.setBorderWidth(0);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(PDF_COLORS_.WARNING_BG);
  cell.editAsText().setBold(true).setFontSize(9).setForegroundColor(PDF_COLORS_.WARNING);
}

/**
 * Encabezado de PÁGINA (2026-09-12) — logo + nombre repetido idéntico en
 * TODAS las páginas del PDF, no solo en la primera. `Document` (no `Body`)
 * sí tiene un encabezado de página real — `doc.addHeader()`, confirmado
 * contra la referencia oficial de DocumentApp (no hay `Body.addHeader()`,
 * el método vive en `Document`). También corrige el desalineado del logo:
 * las dos celdas (logo e imagen) fuerzan
 * `DocumentApp.VerticalAlignment.CENTER`.
 *
 * Desde el cambio de arquitectura de plantillas (2026-09-12), esto solo se
 * llama una vez por cada plantilla (`buildElectricalTemplateDoc_`/
 * `buildOilTemplateDoc_`) — el informe real ya no lo llama, hereda el
 * encabezado al copiar la plantilla (`makeCopy()` copia el documento
 * completo, encabezado/pie de página incluidos).
 */
function appendPageHeader_(doc) {
  var header = doc.addHeader();
  var logoBlob = getLogoBlob_();
  var headTable = header.appendTable([['', 'M&A Ingeniería y Consultoría SAS']]);
  headTable.setBorderWidth(0);
  var logoCell = headTable.getRow(0).getCell(0);
  logoCell.setWidth(75);
  logoCell.setVerticalAlignment(DocumentApp.VerticalAlignment.CENTER);
  if (logoBlob) {
    var img = logoCell.appendImage(logoBlob);
    var ratio = img.getHeight() / img.getWidth();
    img.setWidth(55);
    img.setHeight(Math.round(55 * ratio));
  }
  var nameCell = headTable.getRow(0).getCell(1);
  nameCell.setVerticalAlignment(DocumentApp.VerticalAlignment.CENTER);
  nameCell.editAsText().setBold(true).setFontSize(14).setForegroundColor(PDF_COLORS_.TEXT);
}

/** Caja de título del protocolo — solo usada al armar plantillas (ver
 *  appendPageHeader_ arriba para el mismo criterio). Hasta el 2026-09-13
 *  también armaba acá mismo la grilla "Datos del cliente y del equipo"
 *  (ver appendClientEquipoGrid_ más abajo); para el informe Eléctrico esa
 *  grilla se separó porque ahora vive DENTRO de la tabla única de
 *  resultados (ver "Tabla única de resultados eléctricos" — el cliente
 *  pidió que ni siquiera esa grilla tenga espacio antes de la tabla de
 *  resultados). Aceite sigue usando appendClientEquipoGrid_ tal cual,
 *  como una grilla aparte — no le pidieron ese cambio. */
function appendReportHeader_(body, site, transformer, protocolTitle) {
  appendProtocolTitle_(body, protocolTitle);
  body.appendParagraph('');
  appendClientEquipoGrid_(body, site, transformer);
}

/** La grilla "Datos del cliente y del equipo" en sí, separada de
 *  appendReportHeader_ (ver comentario ahí) para que el informe Eléctrico
 *  pueda omitirla como grilla aparte y construirla en cambio como más
 *  filas de la tabla única (ver buildClientEquipoUnifiedRows_). Solo
 *  usada tal cual por buildOilTemplateDoc_ (Aceite). */
function appendClientEquipoGrid_(body, site, transformer) {
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

/** Banner de veredicto — el elemento más visible del informe, mismo color
 *  que ya usa la app en pantalla (verdictColor_). Solo usada al armar
 *  plantillas, con un placeholder de texto en vez del veredicto real — el
 *  color real se fija en tiempo de generación (ver setVerdictBannerColor_,
 *  porque `body.replaceText()` cambia texto, nunca estilo de celda). */
function appendVerdictBanner_(body, label, verdict) {
  var colors = verdictColor_(verdict);
  var table = body.appendTable([[label + ': ' + verdict]]);
  table.setBorderWidth(0);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(colors.bg);
  cell.editAsText().setBold(true).setFontSize(13).setForegroundColor(colors.text);
}

/** "Área de control de calidad" — mismo nombre y ubicación (al final,
 *  junto a las firmas) que el protocolo de referencia original. La firma
 *  del ingeniero responsable (imagen + nombre + cargo, columna "APROBADO
 *  POR") queda horneada en la plantilla — nunca cambia entre informes, así
 *  que ya no se inserta en tiempo de generación (antes del cambio de
 *  arquitectura de plantillas se insertaba en cada PDF individualmente).
 *  `probadoPor`/`certificadoPor` son objetos `{ nombre, fecha }` — al
 *  armar la plantilla llevan placeholders de texto; en el informe real
 *  esos 4 valores se llenan con `body.replaceText()`.
 *
 *  **Salto de página forzado — QUITADO (2026-09-13)**: originalmente este
 *  bloque forzaba su propio salto de página porque, sin él, se veía
 *  partido entre dos páginas (`Paragraph`/`TableRow` no exponen ningún
 *  "mantener junto" en Apps Script, no existe equivalente a
 *  `page-break-inside: avoid` para tablas en este servicio). A pedido
 *  explícito del cliente (quiere el informe completo en una sola hoja,
 *  comparado contra un certificado real de otra empresa que sí lo logra)
 *  se quitó el salto forzado — junto con la compactación de fuente/
 *  espaciado de los puntos 7/8 y la fusión de las 3 grillas de "Datos de
 *  la prueba" en una sola (`appendSharedTestMetaSection_`), el bloque de
 *  firmas debería quedar en la misma página como el resto en el caso
 *  normal. Riesgo aceptado explícitamente: en un equipo con muchos TAPs
 *  las firmas podrían volver a partirse entre páginas — decisión del
 *  cliente, no un descuido. */
function appendSignatureSection_(body, probadoPor, certificadoPor) {
  appendSectionTitle_(body, 'Área de control de calidad');
  var table = body.appendTable([
    ['PROBADO POR', 'CERTIFICADO POR', 'APROBADO POR'],
    [
      (probadoPor.nombre || '—') + '\n' + fmtDatePdf_(probadoPor.fecha),
      (certificadoPor.nombre || '—') + '\n' + fmtDatePdf_(certificadoPor.fecha),
      ''
    ]
  ]);
  table.setBorderColor(PDF_COLORS_.BORDER);
  for (var c = 0; c < 3; c++) {
    table.getRow(0).getCell(c).setBackgroundColor(PDF_COLORS_.NEUTRAL_BG);
    table.getRow(0).getCell(c).editAsText().setBold(true).setFontSize(7);
  }
  table.getRow(1).getCell(0).editAsText().setFontSize(8);
  table.getRow(1).getCell(1).editAsText().setFontSize(8);

  var aprobadoCell = table.getRow(1).getCell(2);
  var engineerBlob = getEngineerSignatureBlob_();
  if (engineerBlob) {
    var img = aprobadoCell.appendImage(engineerBlob);
    var ratio = img.getHeight() / img.getWidth();
    img.setWidth(70);
    img.setHeight(Math.round(70 * ratio));
  }
  var nameLine = aprobadoCell.appendParagraph(ENGINEER_SIGNATURE_NAME_);
  nameLine.editAsText().setBold(true).setFontSize(8);
  var titleLine = aprobadoCell.appendParagraph(ENGINEER_SIGNATURE_TITLE_);
  titleLine.editAsText().setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
}

var TEST_TYPE_DISPLAY_LABEL_ = {
  TTR: 'TTR',
  RESISTENCIA_DEVANADOS: 'Resistencia de Devanados',
  AISLAMIENTO: 'Resistencia de Aislamiento'
};

/** Orden fijo U/V/W de TTR — coincide con getPhaseKeys() en app.js
 *  (H1H2-X1X2 / H2H3-X2X3 / H3H1-X3X1, siempre en ese orden para
 *  trifásico), y de Devanados (H1-H2/H2-H3/H3-H1 para AT, ya mapeadas por
 *  TTR_TO_WR_PHASE_MAP en app.js; X1-X2/X2-X3/X3-X1 para BT). */
var TTR_PHASE_ORDER_ = ['H1H2-X1X2', 'H2H3-X2X3', 'H3H1-X3X1'];
var WINDING_PHASE_ORDER_ = ['H1-H2', 'H2-H3', 'H3-H1'];
var WINDING_SECONDARY_PHASE_ORDER_ = ['X1-X2', 'X2-X3', 'X3-X1'];

// ---------------------------------------------------------------------------
// Tabla única de resultados eléctricos (2026-09-13, a pedido explícito del
// cliente tras comparar contra 2 certificados reales de otras empresas que
// caben en una sola hoja) — TTR + Devanados AT/BT + Aislamiento ya NO son 3
// tablas separadas con espacio entre ellas (esa separación repetida era la
// causa real de que el informe se fuera a 2-3 páginas): ahora son secciones
// dentro de UNA sola tabla de 7 columnas de ancho (la más ancha que se
// necesita). Cada sección aporta: 1 fila banner (fusionada en las 7
// columnas), 1 fila de encabezado, sus filas de datos, y 1 fila de
// veredicto (fusionada, con el mismo color que ya usaba appendVerdictBanner_)
// — sin párrafos ni espacio entre secciones, todo dentro de la misma tabla.
//
// DocumentApp no puede fusionar celdas (no existe tableCell.merge() ni
// similar). El flujo es: (1) construir la tabla COMPLETA con DocumentApp
// como una tabla normal de 7 columnas, con TODAS las celdas llenas (vacías
// donde luego se van a fusionar), (2) doc.saveAndClose() (ver
// finalizeReportPdf_), (3) reabrir con Docs.Documents.get para ubicar la
// tabla por el texto exacto de su primer banner (único por informe), (4)
// mandar TODAS las mergeTableCells en un solo batchUpdate — ver
// applyUnifiedTableMerges_, mismo patrón ya usado en pinResultsTableHeaders_
// para ubicar contenido por forma vía la Docs API avanzada.
// ---------------------------------------------------------------------------

var UNIFIED_TABLE_COLS_ = 7;
/** Tamaños de fuente al mínimo legible (2026-09-13, a pedido explícito
 *  del cliente comparando contra un protocolo real de otra empresa que
 *  cabe en 1 sola hoja con letra diminuta) — el banner/veredicto se dejan
 *  un poco más grandes que el resto porque son el único texto que debe
 *  notarse a simple vista; todo lo demás (encabezados, datos, grillas de
 *  etiqueta/valor) baja a 5pt, el mínimo que pidió el cliente. */
var UNIFIED_FONT_BANNER_ = 7;
var UNIFIED_FONT_VERDICT_ = 8;
var UNIFIED_FONT_DATA_ = 5;
/** Padding mínimo de celda (en puntos) — DocumentApp lo deja en ~5pt por
 *  defecto en cada lado; bajarlo a esto es lo que de verdad reduce la
 *  altura de cada fila (más que la fuente en sí), igual que pidió el
 *  cliente ("celdas y filas al mínimo"). */
var UNIFIED_CELL_PADDING_ = 1;

/** Una fila "lógica" de la tabla unificada. `cells` siempre tiene 7
 *  strings (relleno con '' donde una fusión posterior los va a tapar).
 *  `role` decide el estilo al insertar (banner/header/verdict/data).
 *  `merges` (opcional, arreglo de {startColumnIndex, columnSpan}) son las
 *  fusiones que necesita ESTA fila — casi siempre 0 o 1, pero Aislamiento
 *  Simple necesita 2 en la misma fila (COMBINACIÓN y RESISTENCIA). */
function unifiedRow_(cells, role, merges) {
  return { cells: cells, role: role, merges: merges || [] };
}
function unifiedBannerRow_(text) {
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = text;
  return unifiedRow_(cells, 'banner', [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }]);
}
/** Fila tipo "grilla densa" etiqueta/valor (fondo gris + negrita en la
 *  etiqueta, texto normal en el valor) DENTRO de la tabla única — usada
 *  por "Datos del cliente y del equipo" y "Datos generales de la prueba"
 *  (2026-09-13: antes eran 2 grillas aparte, con espacio antes de la
 *  tabla de resultados; el cliente pidió que no quede NINGÚN espacio en
 *  todo el informe, así que ahora son más filas de la misma tabla).
 *  `labelCols` son los índices de columna (0-6) que se ven como etiqueta;
 *  el resto de columnas de esa fila son valor. */
function unifiedLabelRow_(cells, labelCols, merges) {
  var row = unifiedRow_(cells, 'labelvalue', merges);
  row.labelCols = labelCols;
  return row;
}

/** Fila de veredicto — Punto 11, ronda 2 (2026-09-14): el cliente compartió
 *  una referencia real donde el veredicto de cada sección vive DENTRO de su
 *  propia tabla (justo debajo de sus datos), no en una fila aparte a lo
 *  ancho de las 2 columnas externas. Se agrega al FINAL del arreglo de filas
 *  de cada sección (`build*UnifiedSection_`/`build*UnifiedRows_`) antes de
 *  pasarlo como contenido de la tabla ANIDADA — mismo rol/color que ya
 *  usaba `appendVerdictBanner_`, solo que ahora fusionado dentro de las 7
 *  columnas lógicas de la tabla anidada, no de la tabla externa. */
function nestedVerdictRow_(label, verdict) {
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = label + ': ' + verdict;
  var row = unifiedRow_(cells, 'verdict', [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }]);
  row.verdictValue = verdict;
  return row;
}

/** Prefija el número de sección (1, 2, 3...) al banner de un bloque de filas
 *  — Punto 11, ronda 2: la referencia real del cliente numera cada sección
 *  (1-12), pero las secciones eléctricas son condicionales (TTR/Devanados/
 *  Aislamiento, cada uno puede faltar según lo ofertado), así que el número
 *  se calcula en tiempo de generación con un contador simple en vez de
 *  quedar fijo en cada build*_ — un informe con solo Aislamiento numera esa
 *  sección "3." en vez de dejar huecos "8."/"9." sin usar. */
function numberSection_(rows, num) {
  if (rows && rows.length) rows[0].cells[0] = num + '. ' + rows[0].cells[0];
  return rows;
}

/** "Datos del cliente y del equipo" como filas de la tabla única — mismos
 *  6 pares etiqueta/valor de siempre (ver appendClientEquipoGrid_, que
 *  sigue existiendo tal cual solo para Aceite), repartidos en las 7
 *  columnas físicas como etiqueta(1 col)+valor(2 cols)+etiqueta(1 col)+
 *  valor(3 cols) por fila — el valor se deja más ancho porque suele ser
 *  el dato más largo (nombre de cliente, número de serie, etc). */
function buildClientEquipoUnifiedRows_(site, transformer) {
  var rows = [unifiedBannerRow_('DATOS DEL CLIENTE Y DEL EQUIPO')];
  var pairMerges = [{ startColumnIndex: 1, columnSpan: 2 }, { startColumnIndex: 4, columnSpan: 3 }];
  var pairs = [
    ['CLIENTE', site.client_name || '—', 'NIT', site.nit || '—'],
    ['CIUDAD', site.ciudad || '—', 'PROYECTO', site.project_name || '—'],
    ['FABRICANTE', transformer.manufacturer || '—', 'N° DE SERIE', transformer.serial_number || '—'],
    ['GRUPO DE CONEXIÓN', transformer.vector_group || '—', 'POTENCIA NOMINAL', transformer.rated_power_kva ? (String(transformer.rated_power_kva) + ' kVA') : '—'],
    ['TENSIÓN PRIMARIA', transformer.hv_nominal_voltage ? (String(transformer.hv_nominal_voltage) + ' V') : '—', 'TENSIÓN SECUNDARIA', transformer.lv_nominal_voltage ? (String(transformer.lv_nominal_voltage) + ' V') : '—'],
    ['REFRIGERACIÓN', transformer.cooling_type || '—', 'AÑO DE FABRICACIÓN', transformer.manufacture_year ? String(transformer.manufacture_year) : '—']
  ];
  pairs.forEach(function (p) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = p[0]; cells[1] = p[1]; cells[3] = p[2]; cells[4] = p[3];
    rows.push(unifiedLabelRow_(cells, [0, 3], pairMerges));
  });
  return rows;
}

/** "Datos generales de la prueba" (FECHA/TÉCNICO/NORMA) como 1 sola fila
 *  de la tabla única — reemplaza a la vieja appendSharedTestMetaSection_
 *  (que armaba esto como grilla aparte en la plantilla, con placeholders
 *  <<FECHA_GENERAL>>/<<TECNICO_GENERAL>>). Ahora se construye con los
 *  valores YA REALES en tiempo de generación (regenerateElectricalCombinedReport_
 *  calcula `signedTest` — la prueba más reciente entre las presentes —
 *  ANTES de armar esta fila, no después como antes), así que no hace
 *  falta ningún placeholder ni body.replaceText() para esto. NORMA es
 *  literal, nunca cambia. */
/** "Datos generales de la prueba" — reescrita (Punto 11, ronda 2,
 *  2026-09-14) sobre la referencia real que compartió el cliente: columna
 *  izquierda siempre con 5 filas fijas (FECHA/TÉCNICO/TEMP/HUMEDAD/ESTADO
 *  DEL EQUIPO — este último es `transformer.estado_equipo`, dato que YA
 *  existía en el modelo, no hizo falta agregarlo); columna derecha con una
 *  línea POR CADA instrumento realmente usado (`instrumentLines`, ya
 *  filtrada por el llamador a solo los tipos de prueba presentes) más
 *  NORMAS DE REFERENCIA al final. N° de serie y fecha de última
 *  calibración se doblan en el mismo texto de cada línea de instrumento
 *  (`buildInstrumentLine_`) en vez de columnas propias — la referencia
 *  traía una fila "FECHA DE CALIBRACIÓN" separada, pero como cada
 *  instrumento puede tener la suya propia, una sola fila compartida sería
 *  ambigua con 2-3 instrumentos distintos. */
function buildDatosGeneralesUnifiedRows_(fechaText, tecnicoText, tempText, humedadText, estadoEquipoText, instrumentLines, normasText) {
  var leftLabels = [
    ['FECHA DE PRUEBA', fechaText],
    ['TÉCNICO RESPONSABLE', tecnicoText],
    ['TEMPERATURA AMBIENTE', tempText || '—'],
    ['HUMEDAD RELATIVA', humedadText || '—'],
    ['ESTADO DEL EQUIPO', estadoEquipoText]
  ];
  var rightLabels = instrumentLines.concat([['NORMAS DE REFERENCIA', normasText]]);
  var rowCount = Math.max(leftLabels.length, rightLabels.length);
  var pairMerges = [{ startColumnIndex: 1, columnSpan: 2 }, { startColumnIndex: 4, columnSpan: 3 }];
  var rows = [unifiedBannerRow_('DATOS GENERALES DE LA PRUEBA')];
  for (var i = 0; i < rowCount; i++) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    var l = leftLabels[i], rr = rightLabels[i];
    if (l) { cells[0] = l[0]; cells[1] = l[1]; }
    if (rr) { cells[3] = rr[0]; cells[4] = rr[1]; }
    rows.push(unifiedLabelRow_(cells, [0, 3], pairMerges));
  }
  return rows;
}

/** Una línea "INSTRUMENTO X: modelo · N° serie · Cal: fecha" — usada por
 *  las 3 filas condicionales de instrumento en Datos Generales. `cal` es
 *  el resultado de `findMatchingCalibracionServer_` (o `null` si el texto
 *  libre de `instrument_used` no cruzó con ningún instrumento del catálogo
 *  de Calibraciones — pasa igual, solo sin N° serie/fecha). */
function buildInstrumentLine_(instrumentText, cal) {
  var parts = [instrumentText || '—'];
  if (cal && cal.numero_serie) parts.push('N° ' + cal.numero_serie);
  if (cal && cal.fecha_ultima_calibracion) parts.push('Cal: ' + fmtDatePdf_(cal.fecha_ultima_calibracion));
  return parts.join(' · ');
}

/** TTR — banner + encabezado + 1 fila por TAP. Mismo criterio de
 *  peor-caso-entre-fases que ya existía (ERROR%/ESTADO); el marcador "†"
 *  de lectura repetida ahora vive en la celda ESTADO (antes vivía en la
 *  celda TAP, que ya no le pertenece solo a esta fila desde que todo es
 *  una tabla continua). El aviso de "teórico no disponible/no confiable"
 *  (antes un banner de advertencia aparte) se dobla dentro del texto del
 *  banner de esta sección — ya no hay espacio para un párrafo extra entre
 *  secciones. */
function buildTtrUnifiedSection_(calc, esMonofasico, instrumentoLine, warningText) {
  var theoAvailable = calc.theoreticalAvailable !== false;
  var bannerText = 'RESULTADOS — RELACIÓN DE TRANSFORMACIÓN (TTR)';
  if (instrumentoLine) bannerText += '   ·   ' + instrumentoLine;
  if (warningText) bannerText += '   ·   ' + warningText;

  var rows = [unifiedBannerRow_(bannerText)];

  var merges = esMonofasico ? [{ startColumnIndex: 1, columnSpan: 3 }] : [];
  var headerCells = esMonofasico
    ? ['TAP', 'VALOR', '', '', 'TEÓRICA', 'ERROR %', 'ESTADO']
    : ['TAP', 'U', 'V', 'W', 'TEÓRICA', 'ERROR %', 'ESTADO'];
  rows.push(unifiedRow_(headerCells, 'header', merges));

  Object.keys(calc.taps).map(Number).sort(function (a, b) { return a - b; }).forEach(function (tapNum) {
    var tap = calc.taps[String(tapNum)];
    var phaseKeys = Object.keys(tap.phases);
    var orderedKeys = phaseKeys.length > 1 ? TTR_PHASE_ORDER_.filter(function (k) { return tap.phases[k]; }) : phaseKeys;

    var teorica = null, worstErrorPercent = null, worstStatus = 'APROBADO', anyNota = false;
    orderedKeys.forEach(function (k) {
      var p = tap.phases[k];
      if (p.nota) anyNota = true;
      if (teorica === null && theoAvailable && p.appliedTheoreticalRatio != null) teorica = p.appliedTheoreticalRatio;
      if (theoAvailable && p.errorPercent != null && (worstErrorPercent === null || Math.abs(p.errorPercent) > Math.abs(worstErrorPercent))) {
        worstErrorPercent = p.errorPercent;
      }
      if (theoAvailable && p.status === 'RECHAZADO') worstStatus = 'RECHAZADO';
    });

    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = String(tapNum);
    if (esMonofasico) {
      var onlyPhase = tap.phases[orderedKeys[0]];
      cells[1] = onlyPhase && onlyPhase.measuredRatio != null ? onlyPhase.measuredRatio.toFixed(4) : '—';
    } else {
      orderedKeys.forEach(function (k, i) {
        var p = tap.phases[k];
        cells[1 + i] = p.measuredRatio != null ? p.measuredRatio.toFixed(4) : '—';
      });
    }
    cells[4] = teorica != null ? teorica.toFixed(4) : '—';
    cells[5] = worstErrorPercent != null ? worstErrorPercent.toFixed(2) + ' %' : '—';
    cells[6] = (theoAvailable ? worstStatus : 'PENDIENTE') + (anyNota ? ' †' : '');
    rows.push(unifiedRow_(cells, 'data', merges));
  });

  return rows;
}

function collectTtrUnifiedNotes_(calc) {
  var notes = [];
  Object.keys(calc.taps).map(Number).sort(function (a, b) { return a - b; }).forEach(function (tapNum) {
    var tap = calc.taps[String(tapNum)];
    Object.keys(tap.phases).forEach(function (phaseKey) {
      var p = tap.phases[phaseKey];
      if (p.nota) notes.push('TTR — TAP ' + tapNum + ' – Fase ' + phaseKey + ': ' + p.nota);
    });
  });
  return notes;
}

/** Devanados — banner + encabezado + 1 fila por TAP, para UN lado del
 *  devanado (AT=primario, BT=secundario; comparten exactamente la misma
 *  forma de fila, solo cambia de dónde sale `tapEntries` y `phaseOrder` —
 *  AT usa WINDING_PHASE_ORDER_ (H1-H2/H2-H3/H3-H1), BT usa
 *  WINDING_SECONDARY_PHASE_ORDER_ (X1-X2/X2-X3/X3-X1); pasar el orden
 *  equivocado deja `orderedKeys` vacío para el lado contrario y revienta
 *  en el `.toFixed()` de más abajo — bug real encontrado en la primera
 *  verificación en vivo de este cambio, 2026-09-13). `materialText`
 *  (Aluminio/Cobre, dato nuevo de placa — ver at_devanado_material/
 *  bt_devanado_material en TRANSFORMADORES) se dobla en el banner en vez
 *  de ocupar una columna, a pedido explícito del cliente.
 *
 *  DESVIACIÓN%/ESTADO son un cálculo real SOLO cuando hay 2+ fases contra
 *  las cuales promediar. Con 1 sola fase (transformador monofásico) no
 *  hay base de comparación — en vez de inventar un 0%/APROBADO (que sí
 *  calcula computePhaseUnbalance_ como placeholder, ver su comentario en
 *  calculateWindingResistance_ más arriba), esta función muestra '—'/
 *  'REGISTRADO', mismo criterio que Aislamiento Simple ya usa para "no
 *  hay verdicto automático posible" — decisión confirmada explícitamente
 *  con el cliente el 2026-09-13. Esto es solo de DISPLAY: el cálculo real
 *  (`calculateWindingResistance_`/`computePhaseUnbalance_`) no cambió, y
 *  el veredicto agregado del lado (tapVerdict/secondary.verdict) sigue
 *  siendo el mismo de siempre. */
function buildWindingSideUnifiedRows_(sideLabel, tapEntries, esMonofasico, materialText, instrumentoLine, phaseOrder) {
  var bannerText = 'RESULTADOS — RESISTENCIA DE DEVANADOS — ' + sideLabel;
  var extras = [];
  if (materialText) extras.push('Material: ' + materialText);
  if (instrumentoLine) extras.push(instrumentoLine);
  if (extras.length) bannerText += '   ·   ' + extras.join('   ·   ');

  var rows = [unifiedBannerRow_(bannerText)];

  var merges = esMonofasico ? [{ startColumnIndex: 1, columnSpan: 3 }] : [];
  var headerCells = esMonofasico
    ? ['TAP', 'VALOR', '', '', 'PROMEDIO', 'DESVIACIÓN %', 'ESTADO']
    : ['TAP', 'U', 'V', 'W', 'PROMEDIO', 'DESVIACIÓN %', 'ESTADO'];
  rows.push(unifiedRow_(headerCells, 'header', merges));

  tapEntries.forEach(function (tap) {
    var phaseKeys = Object.keys(tap.phases);
    var orderedKeys = phaseKeys.length > 1 ? phaseOrder.filter(function (k) { return tap.phases[k]; }) : phaseKeys;
    var esUnaFase = orderedKeys.length === 1;
    var anyNota = false;
    orderedKeys.forEach(function (k) { if (tap.phases[k].nota) anyNota = true; });

    var desviacion, estado;
    if (esUnaFase) {
      desviacion = '—';
      estado = 'REGISTRADO';
    } else {
      var worstDeviation = null, worstStatus = 'APROBADO';
      orderedKeys.forEach(function (k) {
        var p = tap.phases[k];
        if (worstDeviation === null || Math.abs(p.deviationFromAvgPercent) > Math.abs(worstDeviation)) worstDeviation = p.deviationFromAvgPercent;
        if (p.status === 'RECHAZADO') worstStatus = 'RECHAZADO';
      });
      desviacion = worstDeviation.toFixed(2) + ' %';
      estado = worstStatus;
    }
    if (anyNota) estado += ' †';

    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = tap.tapPosition != null ? String(tap.tapPosition) : '—';
    if (esMonofasico) {
      cells[1] = tap.phases[orderedKeys[0]].resistanceOhm.toFixed(4);
    } else {
      orderedKeys.forEach(function (k, i) { cells[1 + i] = tap.phases[k].resistanceOhm.toFixed(4); });
    }
    cells[4] = tap.averageResistanceOhm.toFixed(4);
    cells[5] = desviacion;
    cells[6] = estado;
    rows.push(unifiedRow_(cells, 'data', merges));
  });

  return rows;
}

function collectWindingSideUnifiedNotes_(sideLabel, tapEntries) {
  var notes = [];
  tapEntries.forEach(function (tap) {
    Object.keys(tap.phases).forEach(function (phaseKey) {
      var p = tap.phases[phaseKey];
      if (p.nota) notes.push(sideLabel + ' — TAP ' + (tap.tapPosition != null ? tap.tapPosition : '—') + ' – Fase ' + phaseKey + ': ' + p.nota);
    });
  });
  return notes;
}

/** Aislamiento — Completo (DAR/IP: 5 columnas lógicas repartidas en 7
 *  físicas, CALIF. IP fusionada sobre las últimas 3) o Simple
 *  (COMBINACIÓN/RESISTENCIA: 2 columnas lógicas, cada una fusionando
 *  varias físicas). No hay columna ESTADO aquí (nunca la hubo, es
 *  DAR/IP+calificación o solo un valor) — el marcador "†" de lectura
 *  repetida va en la última celda lógica de cada fila (CALIF. IP o
 *  RESISTENCIA según el método). */
function buildInsulationUnifiedRows_(calc, instrumentoLine, tensionPruebaText) {
  var esSimple = calc.metodo === 'simple';
  var bannerText = 'RESULTADOS — RESISTENCIA DE AISLAMIENTO' +
    (tensionPruebaText ? ' (Tensión de prueba: ' + tensionPruebaText + ')' : '');
  var extras = [];
  if (instrumentoLine) extras.push(instrumentoLine);
  extras.push('Método: ' + (esSimple ? 'Simple (lectura al minuto)' : 'Completo (DAR/IP)'));
  bannerText += '   ·   ' + extras.join('   ·   ');

  var rows = [unifiedBannerRow_(bannerText)];

  if (esSimple) {
    var simpleMerges = [{ startColumnIndex: 0, columnSpan: 2 }, { startColumnIndex: 2, columnSpan: 5 }];
    rows.push(unifiedRow_(['COMBINACIÓN', '', 'RESISTENCIA', '', '', '', ''], 'header', simpleMerges));
    Object.keys(calc.measurements).forEach(function (key) {
      var m = calc.measurements[key];
      var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
      cells[0] = key;
      cells[2] = m.resistenciaValor + ' ' + m.resistenciaUnidad + (m.nota ? ' †' : '');
      rows.push(unifiedRow_(cells, 'data', simpleMerges));
    });
  } else {
    // Punto extra (2026-09-13, a pedido del cliente): "R 1 MIN" agrega la
    // lectura cruda de resistencia al minuto (convencional en cualquier
    // protocolo real, no solo los índices DAR/IP derivados de ella) — 6
    // columnas lógicas en las 7 físicas, fusionando solo CALIF. IP sobre
    // las últimas 2.
    var completoMerges = [{ startColumnIndex: 5, columnSpan: 2 }];
    rows.push(unifiedRow_(['COMBINACIÓN', 'R 1 MIN', 'DAR', 'CALIF. DAR', 'IP', 'CALIF. IP', ''], 'header', completoMerges));
    Object.keys(calc.measurements).forEach(function (key) {
      var m = calc.measurements[key];
      var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
      cells[0] = key;
      cells[1] = m.r60sMegaohm != null ? (m.r60sMegaohm.toFixed(2) + ' MΩ') : '—';
      cells[2] = m.dar.toFixed(2);
      cells[3] = m.darRating;
      cells[4] = m.ip.toFixed(2);
      cells[5] = m.ipRating + (m.nota ? ' †' : '');
      rows.push(unifiedRow_(cells, 'data', completoMerges));
    });
  }

  return rows;
}

function collectInsulationUnifiedNotes_(calc) {
  var notes = [];
  Object.keys(calc.measurements).forEach(function (key) {
    var m = calc.measurements[key];
    if (m.nota) notes.push('Aislamiento — ' + key + ': ' + m.nota);
  });
  return notes;
}

/** Leyenda de rangos DAR/IP (2026-09-13, a pedido explícito del cliente
 *  tras compartir el formato de otra empresa que sí la muestra) — para
 *  que quien lea el PDF entienda de dónde sale CALIF. DAR/CALIF. IP sin
 *  tener que preguntar. Solo se agrega cuando el método es Completo
 *  (Simple no calcula DAR/IP, no aplica). Los umbrales son EXACTAMENTE
 *  los mismos que ya usan `darRating_`/`ipRating_` para decidir el
 *  resultado real — esto solo los imprime, no inventa una escala nueva. */
function buildDarIpLegendRows_() {
  var rows = [unifiedBannerRow_('CALIFICACIÓN DAR / IP — RANGOS DE REFERENCIA')];
  var merges = [{ startColumnIndex: 0, columnSpan: 2 }, { startColumnIndex: 4, columnSpan: 2 }];
  var tiers = [
    { darRange: '< 1.0', ipRange: '< 1.0', label: 'MALO', bg: PDF_COLORS_.DANGER_BG, fg: PDF_COLORS_.DANGER },
    { darRange: '1.0 – 1.25', ipRange: '1.0 – 2.0', label: 'CUESTIONABLE', bg: PDF_COLORS_.WARNING_BG, fg: PDF_COLORS_.WARNING },
    { darRange: '1.25 – 1.6', ipRange: '2.0 – 4.0', label: 'BUENO', bg: PDF_COLORS_.SUCCESS_BG, fg: PDF_COLORS_.SUCCESS },
    { darRange: '≥ 1.6', ipRange: '≥ 4.0', label: 'EXCELENTE', bg: PDF_COLORS_.SUCCESS_BG, fg: PDF_COLORS_.SUCCESS }
  ];
  tiers.forEach(function (t) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = 'DAR ' + t.darRange;
    cells[2] = t.label;
    cells[4] = 'IP ' + t.ipRange;
    cells[6] = t.label;
    var row = unifiedRow_(cells, 'legend', merges);
    row.coloredCols = [{ col: 2, bg: t.bg, fg: t.fg }, { col: 6, bg: t.bg, fg: t.fg }];
    rows.push(row);
  });
  return rows;
}

/** Punto 11 (2026-09-14) — panel de criterios de TTR, para el lado derecho
 *  del layout de 2 columnas (resultados | criterios). El umbral real que
 *  decide RECHAZADO ya vive en calculateTtr_/lo que llegue en
 *  `calc.taps[].phases[].status` — esto solo IMPRIME esa referencia, no
 *  inventa una nueva. */
/** Tabla de criterios de Devanados — Punto 11, ronda 2 (2026-09-14): la
 *  referencia real que compartió el cliente la muestra como SECCIÓN PROPIA
 *  a todo lo ancho (no al lado de AT/BT), con la escala de 3 niveles
 *  (≤1 %/1-3 %/>3 %) de la imagen original. El umbral REAL que decide
 *  APROBADO/RECHAZADO sigue siendo el único de 5 % ya verificado
 *  (`computePhaseUnbalance_`, sin cambios) — esta tabla es SOLO
 *  referencia visual, exactamente la misma decisión ya tomada el
 *  2026-09-13 ("esa escala solo se imprime como tabla de referencia
 *  visual, no reemplaza el cálculo"), ahora con el layout que de verdad
 *  pidió el cliente. */
function buildWindingCriteriaTable3Tier_() {
  var rows = [unifiedBannerRow_('CRITERIOS DE EVALUACIÓN — RESISTENCIA DE DEVANADOS')];
  var merges = [{ startColumnIndex: 0, columnSpan: 4 }, { startColumnIndex: 4, columnSpan: 3 }];
  var header = new Array(UNIFIED_TABLE_COLS_).fill('');
  header[0] = 'DESVIACIÓN ENTRE FASES'; header[4] = 'ESTADO';
  rows.push(unifiedRow_(header, 'header', merges));
  var tiers = [
    { range: '≤ 1 %', label: 'ACEPTABLE', bg: PDF_COLORS_.SUCCESS_BG, fg: PDF_COLORS_.SUCCESS },
    { range: '> 1 % y ≤ 3 %', label: 'CUESTIONABLE', bg: PDF_COLORS_.WARNING_BG, fg: PDF_COLORS_.WARNING },
    { range: '> 3 %', label: 'NO ACEPTABLE', bg: PDF_COLORS_.DANGER_BG, fg: PDF_COLORS_.DANGER }
  ];
  tiers.forEach(function (t) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = t.range; cells[4] = t.label;
    var row = unifiedRow_(cells, 'legend', merges);
    row.coloredCols = [{ col: 4, bg: t.bg, fg: t.fg }];
    rows.push(row);
  });
  return rows;
}

/** Panel de criterios de Aislamiento — Completo reutiliza la leyenda DAR/IP
 *  que ya existía (buildDarIpLegendRows_), ahora AL LADO de los resultados
 *  en vez de debajo (Punto 11, checklist ítem 4). Simple no calcula DAR/IP
 *  — un panel corto explica por qué no aplica, en vez de dejar el lado
 *  derecho vacío. */
function buildInsulationCriteriaRows_(esSimple) {
  if (!esSimple) return buildDarIpLegendRows_();
  var rows = [unifiedBannerRow_('MÉTODO SIMPLE — SIN DAR/IP')];
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = 'Lectura única de resistencia (ej. al minuto) — sin las lecturas adicionales de tiempo que arman DAR/IP, no aplica calificación por índice.';
  rows.push(unifiedRow_(cells, 'data', [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }]));
  return rows;
}

/** Espacio para anotaciones manuales del ingeniero — Punto 11, checklist
 *  ítem 5. Sin contenido dinámico propio (no existe un campo "observaciones"
 *  en el modelo de datos todavía): son filas en blanco con un poco más de
 *  padding para que se pueda escribir a mano sobre el PDF impreso. */
/** Une una lista en español con comas y "y" antes del último elemento —
 *  usado por buildObservacionesRows_ para listar las pruebas presentes. */
function joinSpanishList_(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' y ' + items[items.length - 1];
}

/** Observaciones — Punto 11, ronda 2 (2026-09-14): la referencia real del
 *  cliente trae un párrafo generado, no líneas en blanco para escribir a
 *  mano (esa fue la primera versión, antes de ver la referencia). Se arma
 *  con datos que YA se calculan en regenerateElectricalCombinedReport_
 *  (qué pruebas están presentes, estado del equipo, normas aplicables, y
 *  si el resultado combinado fue APROBADO) — no inventa ningún dato nuevo,
 *  solo redacta una frase con lo que ya se sabe. */
function buildObservacionesRows_(presentLabels, estadoEquipoText, normasText, aprobado) {
  var rows = [unifiedBannerRow_('OBSERVACIONES')];
  var fullMerge = [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }];
  var sentence = 'Las pruebas de ' + joinSpanishList_(presentLabels) +
    ' se realizaron con el equipo ' + String(estadoEquipoText || '').toLowerCase() +
    ', de acuerdo con las normas ' + normasText + '. ' +
    (aprobado
      ? 'Los resultados obtenidos se encuentran dentro de los rangos aceptables y presentan buen comportamiento.'
      : 'Los resultados obtenidos presentan valores fuera de los rangos aceptables — se recomienda una revisión adicional del equipo.');
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = sentence;
  rows.push(unifiedRow_(cells, 'data', fullMerge));
  return rows;
}

/** Conclusión General con checkbox — Punto 11, checklist ítem 5.
 *  `overallVerdict` ya viene combinado (ver regenerateElectricalCombinedReport_:
 *  APROBADO solo si TODAS las secciones presentes lo están) — esto no
 *  recalcula nada, solo decide qué casilla marcar. */
function buildConclusionRows_(overallVerdict) {
  var aprobado = String(overallVerdict || '').indexOf('APROBADO') === 0;
  var rows = [unifiedBannerRow_('CONCLUSIÓN GENERAL')];
  var merges = [{ startColumnIndex: 0, columnSpan: 4 }, { startColumnIndex: 4, columnSpan: 3 }];
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = (aprobado ? '☑' : '☐') + ' EQUIPO APROBADO';
  cells[4] = (!aprobado ? '☑' : '☐') + ' EQUIPO NO APROBADO';
  var row = unifiedRow_(cells, 'legend', merges);
  row.coloredCols = [
    { col: 0, bg: aprobado ? PDF_COLORS_.SUCCESS_BG : PDF_COLORS_.NEUTRAL_BG, fg: aprobado ? PDF_COLORS_.SUCCESS : PDF_COLORS_.TEXT_MUTED },
    { col: 4, bg: !aprobado ? PDF_COLORS_.DANGER_BG : PDF_COLORS_.NEUTRAL_BG, fg: !aprobado ? PDF_COLORS_.DANGER : PDF_COLORS_.TEXT_MUTED }
  ];
  rows.push(row);
  return rows;
}

/** Gráfica de barras de desviación de TTR por fase (Punto 11, checklist
 *  ítem 3) — servicio `Charts` nativo de Apps Script, sin costo ni servicio
 *  externo (ver aclaración a el cliente en Punto 11 de CLAUDE.md). Nunca
 *  lanza fuera de aquí: si algo falla (0 TAPs, monofásico sin base de
 *  comparación entre fases, etc.) devuelve `null` y el llamador simplemente
 *  no inserta la imagen — no debe bloquear la generación del informe. */
function buildTtrDeviationChart_(calc, esMonofasico, sectionNum) {
  if (esMonofasico) return null;
  var tapNums = Object.keys(calc.taps || {}).map(Number).sort(function (a, b) { return a - b; });
  if (tapNums.length === 0) return null;
  try {
    var dataTable = Charts.newDataTable().addColumn(Charts.ColumnType.STRING, 'TAP');
    TTR_PHASE_ORDER_.forEach(function (k) { dataTable.addColumn(Charts.ColumnType.NUMBER, k); });
    tapNums.forEach(function (tapNum) {
      var tap = calc.taps[String(tapNum)];
      var row = ['TAP ' + tapNum];
      TTR_PHASE_ORDER_.forEach(function (k) {
        var p = tap.phases[k];
        row.push(p && p.errorPercent != null ? p.errorPercent : 0);
      });
      dataTable.addRow(row);
    });
    var chart = Charts.newColumnChart()
      .setDataTable(dataTable)
      .setTitle((sectionNum ? sectionNum + '. ' : '') + 'DESVIACIÓN POR FASE (TTR)')
      .setDimensions(460, 240)
      .setColors(['#585d63', '#8f2d2d', '#3aaa35'])
      .setLegendPosition(Charts.Position.BOTTOM)
      .build();
    return chart.getAs('image/png');
  } catch (e) {
    return null;
  }
}

/** Inserta la tabla unificada completa en `body`, justo ANTES de
 *  `beforeChild` (el marcador de posición `<<TABLA_RESULTADOS_ELECTRICOS>>`
 *  que trae la plantilla — nunca "Área de Control de Calidad" en sí, que
 *  debe quedar siempre después, como tabla aparte, sin tocar). Construye
 *  con DocumentApp una tabla NORMAL de 7 columnas (nunca fusiona nada —
 *  eso lo hace applyUnifiedTableMerges_ después, sobre el documento ya
 *  guardado). Devuelve las instrucciones de fusión para que
 *  regenerateElectricalCombinedReport_ se las pase a finalizeReportPdf_. */
/** Aplica el estilo de una fila lógica (banner/header/verdict/labelvalue/
 *  legend/blankline/data) a UNA celda — extraído (Punto 11, 2026-09-14) del
 *  loop que antes vivía dentro de insertUnifiedResultsTable_, para poder
 *  reusarlo tanto en celdas de la tabla EXTERNA (banner/verdict a todo lo
 *  ancho) como en celdas de cada tabla ANIDADA (resultados/criterios) — el
 *  criterio visual de cada rol no cambió, solo dejó de estar atado a una
 *  sola tabla. */
function styleUnifiedCell_(cell, r, c, padding) {
  cell.setPaddingTop(padding).setPaddingBottom(padding)
    .setPaddingLeft(padding).setPaddingRight(padding);
  if (r.role === 'banner') {
    cell.setBackgroundColor(PDF_COLORS_.ACCENT);
    cell.editAsText().setBold(true).setFontSize(UNIFIED_FONT_BANNER_).setForegroundColor('#ffffff');
  } else if (r.role === 'header') {
    cell.setBackgroundColor(PDF_COLORS_.ACCENT);
    cell.editAsText().setBold(true).setFontSize(UNIFIED_FONT_DATA_).setForegroundColor('#ffffff');
  } else if (r.role === 'verdict') {
    var vcolors = verdictColor_(r.verdictValue);
    cell.setBackgroundColor(vcolors.bg);
    cell.editAsText().setBold(true).setFontSize(UNIFIED_FONT_VERDICT_).setForegroundColor(vcolors.text);
  } else if (r.role === 'labelvalue') {
    var isLabel = r.labelCols.indexOf(c) !== -1;
    if (isLabel) {
      cell.setBackgroundColor(PDF_COLORS_.NEUTRAL_BG);
      cell.editAsText().setBold(true).setFontSize(UNIFIED_FONT_DATA_).setForegroundColor(PDF_COLORS_.TEXT);
    } else {
      cell.editAsText().setBold(false).setFontSize(UNIFIED_FONT_DATA_).setForegroundColor(PDF_COLORS_.TEXT);
    }
  } else if (r.role === 'legend') {
    var colorSpec = (r.coloredCols || []).filter(function (cc) { return cc.col === c; })[0];
    if (colorSpec) {
      cell.setBackgroundColor(colorSpec.bg);
      cell.editAsText().setBold(true).setFontSize(UNIFIED_FONT_DATA_).setForegroundColor(colorSpec.fg);
    } else {
      cell.editAsText().setBold(false).setFontSize(UNIFIED_FONT_DATA_).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
    }
  } else if (r.role === 'blankline') {
    cell.setPaddingTop(6).setPaddingBottom(6);
    cell.editAsText().setFontSize(UNIFIED_FONT_DATA_);
  } else if (r.role === 'data') {
    // Punto 11 (2026-09-14, ronda 2 — referencia real del cliente): cada
    // celda de ESTADO/CALIF. en las filas de datos se colorea igual que el
    // banner de veredicto, no solo la fila de veredicto al final — se
    // detecta por el TEXTO de la celda (verdictCellColor_), no por posición
    // de columna, porque TTR/Devanados usan la última columna y Aislamiento
    // Completo tiene 2 columnas de calificación (CALIF. DAR y CALIF. IP).
    var dataColor = verdictCellColor_(cell.editAsText().getText());
    if (dataColor) {
      cell.setBackgroundColor(dataColor.bg);
      cell.editAsText().setFontSize(UNIFIED_FONT_DATA_).setBold(true).setForegroundColor(dataColor.fg);
    } else {
      cell.editAsText().setFontSize(UNIFIED_FONT_DATA_).setBold(false).setForegroundColor(PDF_COLORS_.TEXT);
    }
  } else {
    cell.editAsText().setFontSize(UNIFIED_FONT_DATA_).setBold(false).setForegroundColor(PDF_COLORS_.TEXT);
  }
}

/** Detecta si el texto de una celda de datos es un veredicto/calificación
 *  conocido (APROBADO/RECHAZADO, MALO/CUESTIONABLE/BUENO/EXCELENTE,
 *  ACEPTABLE/NO ACEPTABLE) y devuelve su color — mismo criterio que
 *  verdictColor_/las leyendas ya existentes, solo que aplicado celda por
 *  celda en vez de a toda una fila. `null` para cualquier otro texto (un
 *  valor numérico, una fecha, '—', 'REGISTRADO'/'PENDIENTE') — esas nunca
 *  se colorean. El orden de los `indexOf` importa: 'NO ACEPTABLE' y
 *  'CUESTIONABLE' se revisan ANTES que 'ACEPTABLE'/nada, para no
 *  confundirlas por substring. */
function verdictCellColor_(text) {
  var v = String(text || '').replace(' †', '').trim();
  if (!v || v === '—') return null;
  if (v.indexOf('RECHAZADO') === 0 || v.indexOf('MALO') === 0 || v === 'NO ACEPTABLE') {
    return { bg: PDF_COLORS_.DANGER_BG, fg: PDF_COLORS_.DANGER };
  }
  if (v.indexOf('CUESTIONABLE') === 0) {
    return { bg: PDF_COLORS_.WARNING_BG, fg: PDF_COLORS_.WARNING };
  }
  if (v.indexOf('APROBADO') === 0 || v.indexOf('BUENO') === 0 || v.indexOf('EXCELENTE') === 0 || v === 'ACEPTABLE') {
    return { bg: PDF_COLORS_.SUCCESS_BG, fg: PDF_COLORS_.SUCCESS };
  }
  return null;
}

/** Construye una tabla ANIDADA (Punto 11) dentro de una celda de la tabla
 *  externa — `TableCell.appendTable()` (sin argumentos) crea una tabla
 *  vacía ya insertada en esa celda; se llena fila por fila con
 *  appendTableRow_()/appendTableCell(texto), igual que si fuera la tabla de
 *  nivel superior de antes. Validado en vivo (prototipo `testNestedTableMerge_`,
 *  ya borrado — ver Punto 11 en CLAUDE.md) que `Docs.Documents.batchUpdate`
 *  sí puede fusionar celdas de una tabla anidada, direccionándola por su
 *  propio `startIndex` — por eso esta función también devuelve
 *  `bannerText` (el texto de su propia fila 0 / celda 0), que
 *  applyOuterAndNestedMerges_ usa para ubicarla entre varias candidatas. */
function appendNestedTable_(parentCell, rows) {
  parentCell.setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(0).setPaddingRight(0);
  var nestedTable = parentCell.appendTable();
  nestedTable.setBorderColor(PDF_COLORS_.BORDER);
  var mergeSpecs = [];
  rows.forEach(function (r, rowIndex) {
    var tr = nestedTable.appendTableRow();
    r.cells.forEach(function (text) { tr.appendTableCell(text); });
    for (var c = 0; c < r.cells.length; c++) {
      styleUnifiedCell_(tr.getCell(c), r, c, UNIFIED_CELL_PADDING_);
    }
    r.merges.forEach(function (m) {
      mergeSpecs.push({ rowIndex: rowIndex, startColumnIndex: m.startColumnIndex, columnSpan: m.columnSpan });
    });
  });
  return { table: nestedTable, mergeSpecs: mergeSpecs, bannerText: rows[0].cells[0] };
}

/** Ancho de la tabla EXTERNA (Punto 11) — siempre 2 columnas: casi todo el
 *  contenido (banners, veredictos, las grillas densas de cliente/equipo y
 *  datos generales, Observaciones, Conclusión) ocupa las 2 fusionadas como
 *  una sola fila ancha; solo las filas "resultados | criterios" de cada
 *  sección (TTR/AT/BT/Aislamiento) usan las 2 columnas de verdad, una
 *  tabla anidada distinta en cada una — así la tabla completa sigue siendo
 *  UNA SOLA tabla de DocumentApp (mismo motivo que forzó la tabla única del
 *  Punto 10: 2 tablas de nivel superior consecutivas siempre dejan un
 *  espacio visible entre ellas, sin importar el layout de cada una). */
var OUTER_TABLE_COLS_ = 2;

/** Fila externa que ocupa las 2 columnas fusionadas con una tabla anidada
 *  adentro (client/equipo, datos generales, Observaciones, Conclusión). */
function outerNestedFullRow_(nestedRows) {
  return { kind: 'nested-full', nestedRows: nestedRows };
}
/** Fila externa "resultados | criterios" — 2 tablas anidadas lado a lado,
 *  SIN fusionar (esta es la fila que de verdad necesita las 2 columnas). */
function outerNestedPairRow_(leftRows, rightRows) {
  return { kind: 'nested-pair', leftRows: leftRows, rightRows: rightRows };
}
/** Fila externa "resultados | gráfica" — Punto 11, ronda 2 (2026-09-14):
 *  la referencia real del cliente empareja TTR con su gráfica de
 *  desviación por fase, NO con un panel de criterios (a diferencia de
 *  AT/BT/Aislamiento, que sí van con criterios). Izquierda es una tabla
 *  anidada normal; derecha es una imagen insertada directo en la celda
 *  externa (una imagen no necesita tabla anidada alrededor). */
function outerPairTableImageRow_(leftRows, blob, widthPt, heightPt) {
  return { kind: 'pair-table-image', leftRows: leftRows, blob: blob, widthPt: widthPt, heightPt: heightPt };
}

/** Inserta la tabla EXTERNA de 2 columnas en `body`, justo ANTES de
 *  `beforeChild` (el marcador `<<TABLA_RESULTADOS_ELECTRICOS>>` de la
 *  plantilla — sin cambios en la plantilla misma, ver Punto 11 en
 *  CLAUDE.md: el marcador ya soportaba insertar cualquier contenido ahí).
 *  `outerRows` es un arreglo de descriptores outerNestedFullRow_/
 *  outerNestedPairRow_/outerPairTableImageRow_. Devuelve, además de
 *  la tabla externa, un `nestedRegistry` (una entrada por tabla anidada
 *  creada, con su `bannerText` único y sus propias `mergeSpecs`) para que
 *  finalizeReportPdf_ se lo pase a applyOuterAndNestedMerges_. */
function insertOuterResultsTable_(body, beforeChild, outerRows) {
  if (outerRows.length === 0) return { table: null, outerMergeSpecs: [], nestedRegistry: [], outerMarkerText: null };

  var insertIndex = body.getChildIndex(beforeChild);
  var initialCells = outerRows.map(function () { return ['', '']; });
  var table = body.insertTable(insertIndex, initialCells);
  table.setBorderColor(PDF_COLORS_.BORDER);

  var outerMergeSpecs = [];
  var nestedRegistry = [];

  outerRows.forEach(function (r, rowIndex) {
    var row = table.getRow(rowIndex);
    if (r.kind === 'pair-table-image') {
      var leftNested = appendNestedTable_(row.getCell(0), r.leftRows);
      nestedRegistry.push({ bannerText: leftNested.bannerText, mergeSpecs: leftNested.mergeSpecs });
      var imgCell = row.getCell(1);
      imgCell.setPaddingTop(2).setPaddingBottom(2).setPaddingLeft(2).setPaddingRight(2);
      if (r.blob) {
        var img = imgCell.appendImage(r.blob);
        if (r.widthPt) img.setWidth(r.widthPt);
        if (r.heightPt) img.setHeight(r.heightPt);
      }
    } else if (r.kind === 'nested-full') {
      var nested = appendNestedTable_(row.getCell(0), r.nestedRows);
      row.getCell(1).setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(0).setPaddingRight(0);
      nestedRegistry.push({ bannerText: nested.bannerText, mergeSpecs: nested.mergeSpecs });
      outerMergeSpecs.push({ rowIndex: rowIndex, startColumnIndex: 0, columnSpan: OUTER_TABLE_COLS_ });
    } else if (r.kind === 'nested-pair') {
      var left = appendNestedTable_(row.getCell(0), r.leftRows);
      var right = appendNestedTable_(row.getCell(1), r.rightRows);
      nestedRegistry.push({ bannerText: left.bannerText, mergeSpecs: left.mergeSpecs });
      nestedRegistry.push({ bannerText: right.bannerText, mergeSpecs: right.mergeSpecs });
    }
  });

  return { table: table, outerMergeSpecs: outerMergeSpecs, nestedRegistry: nestedRegistry, outerMarkerText: nestedRegistry.length ? nestedRegistry[0].bannerText : null };
}

/** Punto 6 (2026-09-13): un solo pie de nota para TODA la tabla unificada
 *  (antes había uno por tabla separada) — cada línea ya viene prefijada
 *  con la sección (TTR/AT/BT/Aislamiento) desde collect*UnifiedNotes_,
 *  así se distinguen aunque estén todas juntas. */
function appendUnifiedNoteFootnote_(body, table, notes) {
  if (!table || !notes || notes.length === 0) return;
  var idx = body.getChildIndex(table);
  var p = body.insertParagraph(idx + 1, '† Lectura repetida — ' + notes.join('  ·  '));
  p.editAsText().setFontSize(7).setItalic(true).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
  p.setSpacingBefore(2).setSpacingAfter(6);
}

/** Recorre TODO el contenido de un documento (Docs API avanzada) buscando
 *  tablas, incluidas las ANIDADAS dentro de celdas de otra tabla — a
 *  diferencia de antes (un solo nivel, `doc.body.content`), el layout de 2
 *  columnas del Punto 11 mete tablas dentro de celdas de la tabla externa,
 *  y `Docs.Documents.get` no las expone en el nivel superior: hay que bajar
 *  a `tableCell.content` (que tiene la MISMA forma que `body.content`) para
 *  encontrarlas — validado en vivo con el prototipo `testNestedTableMerge_`
 *  (ya borrado, ver Punto 11 en CLAUDE.md). Cada tabla encontrada guarda su
 *  propio `startIndex` (necesario para direccionarla en mergeTableCells) Y
 *  `rootStartIndex` — el `startIndex` de la tabla de NIVEL SUPERIOR que la
 *  contiene (si la tabla misma es de nivel superior, `rootStartIndex` es
 *  igual a su propio `startIndex`) — así se puede ubicar la tabla externa
 *  completa a partir de CUALQUIER tabla anidada que reconozcamos por texto,
 *  sin depender de que la celda 0/fila 0 de la tabla externa tenga texto
 *  (ya no lo tiene: ahora vive dentro de una tabla anidada). */
function collectAllTables_(content, rootStartIndex, out) {
  (content || []).forEach(function (el) {
    if (!el.table) return;
    var thisRoot = rootStartIndex === null ? el.startIndex : rootStartIndex;
    var row0 = el.table.tableRows[0];
    var cell0 = row0 && row0.tableCells[0];
    out.push({
      startIndex: el.startIndex,
      rootStartIndex: thisRoot,
      row0cell0Text: cell0 ? docsApiCellText_(cell0) : '',
      row0cellCount: row0 ? row0.tableCells.length : 0
    });
    (el.table.tableRows || []).forEach(function (tr) {
      (tr.tableCells || []).forEach(function (cell) {
        collectAllTables_(cell.content, thisRoot, out);
      });
    });
  });
}

/** Fusiona celdas de la tabla EXTERNA de resultados eléctricos Y de cada
 *  tabla ANIDADA dentro de ella (Punto 11) — DocumentApp no puede fusionar
 *  ninguna de las dos, así que ambas se resuelven en el mismo
 *  Docs.Documents.batchUpdate sobre el documento YA guardado (mismo patrón
 *  que ya usaba applyUnifiedTableMerges_/pinResultsTableHeaders_: ubicar por
 *  CONTENIDO, nunca por índice adivinado).
 *
 *  `outerMarkerText` es el `bannerText` de la PRIMERA tabla anidada
 *  ('DATOS DEL CLIENTE Y DEL EQUIPO', única en el documento) — sirve para
 *  ubicar la tabla externa indirectamente: se busca esa tabla anidada por
 *  su texto, y su `rootStartIndex` ES el `startIndex` de la tabla externa
 *  que la contiene. Cada entrada de `nestedRegistry` se ubica igual, por su
 *  propio `bannerText` único. Nunca lanza — si por lo que sea no encuentra
 *  alguna tabla, esa fusión en particular se omite, el PDF igual se genera. */
function applyOuterAndNestedMerges_(docId, outerMarkerText, outerMergeSpecs, nestedRegistry) {
  if (!outerMarkerText) return;
  var doc = Docs.Documents.get(docId);
  var allTables = [];
  collectAllTables_(doc.body.content, null, allTables);

  var requests = [];
  var outerCandidate = allTables.filter(function (t) { return t.row0cell0Text === outerMarkerText; })[0];
  if (outerCandidate && outerMergeSpecs && outerMergeSpecs.length) {
    outerMergeSpecs.forEach(function (spec) {
      requests.push(mergeTableCellsRequest_(outerCandidate.rootStartIndex, spec));
    });
  }

  (nestedRegistry || []).forEach(function (entry) {
    if (!entry.mergeSpecs || entry.mergeSpecs.length === 0) return;
    var match = allTables.filter(function (t) { return t.row0cell0Text === entry.bannerText; })[0];
    if (!match) return;
    entry.mergeSpecs.forEach(function (spec) {
      requests.push(mergeTableCellsRequest_(match.startIndex, spec));
    });
  });

  if (requests.length === 0) return;
  Docs.Documents.batchUpdate({ requests: requests }, docId);
}

function mergeTableCellsRequest_(tableStartIndex, spec) {
  return {
    mergeTableCells: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStartIndex },
          rowIndex: spec.rowIndex,
          columnIndex: spec.startColumnIndex
        },
        rowSpan: 1,
        columnSpan: spec.columnSpan
      }
    }
  };
}

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
/** Solo considera pruebas 'Certificada' (normalizeEstadoCertificacion_) — un
 *  Borrador o una Rechazada nunca puede terminar siendo "la más reciente"
 *  del informe combinado, sin importar qué tan reciente sea su fecha. Es la
 *  pieza clave de que el informe oficial del equipo solo cambie cuando un
 *  Supervisor/Administrador certifica, nunca por un envío crudo. */
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
    if (normalizeEstadoCertificacion_(obj.estado_certificacion) !== 'Certificada') continue;
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

// ---------------------------------------------------------------------------
// Plantillas de informes (2026-09-12) — cambio de arquitectura completo.
//
// Antes: cada informe se armaba de cero con DocumentApp, en cada
// certificación. Ahora: DOS documentos plantilla, generados una sola vez
// por código (crearPlantillasInformes_) con la MISMA estructura/colores/
// tipografía de siempre, pero con placeholders de texto <<CAMPO>> donde
// antes iba un valor dinámico. El único paso manual del usuario es abrir
// cada plantilla y agregarle el watermark del logo (Insertar imagen >
// Detrás del texto > transparencia > centrada) — algo que la Docs API no
// puede hacer por código (ver la sección de CLAUDE.md sobre esto: no
// existe ningún request de batchUpdate que cree o convierta una imagen a
// "posicionada"). Una vez con watermark, cada informe real hace
// `makeCopy()` de la plantilla correspondiente y llena los placeholders —
// el watermark, al ser un objeto anclado a la página (no al flujo del
// cuerpo), se copia intacto y nunca se toca por código.
//
// Dos problemas que NO resuelve un simple "reemplazar texto", ambos
// señalados explícitamente al usuario antes de escribir esto:
//
// 1. TABLAS DE FILAS VARIABLES: para Aceite (Fisicoquímico/DGA/PCB), la
//    plantilla trae la fila de encabezado y el informe real le agrega las
//    filas reales sobre la tabla que ya existe. **TTR/Devanados/
//    Aislamiento ya no funcionan así (2026-09-13)**: desde que se
//    fusionaron en una sola tabla de resultados (ver "Tabla única de
//    resultados eléctricos"), la plantilla ni siquiera trae esa tabla —
//    solo un marcador de posición (`<<TABLA_RESULTADOS_ELECTRICOS>>`). El
//    informe real construye la tabla COMPLETA (banner+encabezado+datos+
//    veredicto de cada sección presente) y la inserta entera donde estaba
//    el marcador — ver insertUnifiedResultsTable_/regenerateElectricalCombinedReport_.
//
// 2. SECCIONES ENTERAS QUE PUEDEN NO ESTAR PRESENTES: desde la
//    certificación por alcance ofertado, el eléctrico puede traer TTR
//    solo, Aislamiento solo, o cualquier combinación — y Aceite siempre
//    pudo traer de 0 a 3 secciones (Fisicoquímico/DGA/PCB) independientes.
//    Un placeholder de texto no puede representar "este bloque entero tal
//    vez no exista". Cada bloque opcional queda envuelto en la plantilla
//    entre dos marcadores invisibles (`<<BLOQUE_X_INICIO>>`/
//    `<<BLOQUE_X_FIN>>`, fuente tamaño 1 para que no se note si por algún
//    motivo sobreviviera sin resolver) — en tiempo de generación,
//    resolveTemplateBlock_ borra el bloque completo si no aplica a este
//    informe, o borra solo los 2 marcadores (dejando el contenido) si sí
//    aplica. Verificado que `Body.findText`/`Body.removeChild` existen en
//    DocumentApp antes de diseñar esto.
// ---------------------------------------------------------------------------

/** Objetos de datos "de mentira" — cada campo es literalmente el texto
 *  `<<...>>` que queda horneado en la plantilla. Truco central de este
 *  diseño: appendReportHeader_/appendSharedTestMetaSection_/appendSignatureSection_
 *  (las MISMAS funciones que arman el informe real hasta este cambio) arman
 *  la plantilla sin tocarlas — la única diferencia es qué objeto de datos
 *  reciben. Esto reduce el riesgo de que la plantilla se desalinee
 *  visualmente del informe real, porque literalmente comparten el código
 *  de armado. */
var TEMPLATE_SITE_ = { client_name: '<<CLIENTE>>', nit: '<<NIT>>', ciudad: '<<CIUDAD>>', project_name: '<<PROYECTO>>' };
var TEMPLATE_TRANSFORMER_ = {
  manufacturer: '<<FABRICANTE>>', serial_number: '<<NUMERO_SERIE>>', vector_group: '<<GRUPO_CONEXION>>',
  rated_power_kva: '<<POTENCIA_NOMINAL>>', hv_nominal_voltage: '<<TENSION_PRIMARIA>>', lv_nominal_voltage: '<<TENSION_SECUNDARIA>>',
  cooling_type: '<<REFRIGERACION>>', manufacture_year: '<<ANO_FABRICACION>>'
};
/** Marcador de bloque opcional — un párrafo propio, invisible (tamaño de
 *  fuente 1) porque siempre se borra antes de exportar a PDF, nunca debe
 *  verse. `body.findText()` los ubica por su texto exacto. */
function blockMarker_(name, which) {
  return '<<BLOQUE_' + name + '_' + which + '>>';
}
function appendBlockStart_(body, name) {
  var p = body.appendParagraph(blockMarker_(name, 'INICIO'));
  p.editAsText().setFontSize(1);
  return p;
}
function appendBlockEnd_(body, name) {
  var p = body.appendParagraph(blockMarker_(name, 'FIN'));
  p.editAsText().setFontSize(1);
  return p;
}

/** Sube por los padres desde el `Text` que encontró `findText` hasta llegar
 *  al `Paragraph` que lo contiene — un marcador de bloque siempre es su
 *  propio párrafo (nunca vive dentro de una celda de tabla), así que ese
 *  Paragraph es un hijo directo de `body`, listo para `getChildIndex`/
 *  `removeChild`. */
function findMarkerParagraph_(body, markerText) {
  var found = body.findText(markerText);
  if (!found) return null;
  var el = found.getElement();
  while (el && el.getType() !== DocumentApp.ElementType.PARAGRAPH) {
    el = el.getParent();
    if (!el) return null;
  }
  return el.asParagraph();
}

/** Resuelve un bloque opcional de la plantilla ya copiada: si `keep` es
 *  false, borra TODO el rango entre los 2 marcadores (inclusive) — de atrás
 *  hacia adelante, para no invalidar los índices todavía por procesar. Si
 *  `keep` es true, deja el contenido intacto y solo borra los 2 marcadores
 *  (ya cumplieron su función, no deben sobrevivir al PDF final). Si algún
 *  marcador no aparece (plantilla desactualizada / bloque ya resuelto antes)
 *  no hace nada — nunca lanza. */
function resolveTemplateBlock_(body, name, keep) {
  var startPar = findMarkerParagraph_(body, blockMarker_(name, 'INICIO'));
  var endPar = findMarkerParagraph_(body, blockMarker_(name, 'FIN'));
  if (!startPar || !endPar) return;
  if (keep) {
    body.removeChild(endPar);
    body.removeChild(startPar);
    return;
  }
  var startIdx = body.getChildIndex(startPar);
  var endIdx = body.getChildIndex(endPar);
  for (var i = endIdx; i >= startIdx; i--) {
    body.removeChild(body.getChild(i));
  }
}

/** Ubica la celda de tabla que contiene un placeholder de texto dado — se
 *  usa para fijar el COLOR real de un banner de veredicto/aviso antes de
 *  reemplazar su texto (`body.replaceText()` cambia texto, nunca estilo;
 *  por eso hay que ubicar la celda primero, con el placeholder todavía
 *  intacto, y solo después reemplazar el texto). */
function findCellByPlaceholder_(body, placeholderText) {
  var found = body.findText(placeholderText);
  if (!found) return null;
  var el = found.getElement();
  while (el && el.getType() !== DocumentApp.ElementType.TABLE_CELL) {
    el = el.getParent();
    if (!el) return null;
  }
  return el.asTableCell();
}

/** Fija el color real (verdictColor_) de un banner cuyo texto todavía es un
 *  placeholder — llamar SIEMPRE antes del `body.replaceText()` de ese mismo
 *  placeholder (una vez reemplazado el texto, ya no se puede volver a
 *  ubicar por el placeholder). */
function setVerdictBannerColor_(body, placeholderText, verdict) {
  var cell = findCellByPlaceholder_(body, placeholderText);
  if (!cell) return;
  var colors = verdictColor_(verdict);
  cell.setBackgroundColor(colors.bg);
  cell.editAsText().setForegroundColor(colors.text);
}

/** Mueve un archivo recién creado (DocumentApp.create() siempre lo deja en
 *  la raíz del Drive del ejecutor) a la carpeta de plantillas — patrón
 *  estándar de DriveApp: agregar a la carpeta destino y quitar de todos los
 *  padres anteriores. */
function moveFileToPlantillasFolder_(file) {
  var folder = getOrCreateFolderIn_(getRootFolder_(), 'Plantillas de Informes');
  var parents = file.getParents();
  while (parents.hasNext()) parents.next().removeFile(file);
  folder.addFile(file);
  return folder;
}

function getElectricalTemplateFileId_() {
  return PropertiesService.getScriptProperties().getProperty('TEMPLATE_ELECTRICO_FILE_ID');
}
function getOilTemplateFileId_() {
  return PropertiesService.getScriptProperties().getProperty('TEMPLATE_ACEITE_FILE_ID');
}

/** Arma la plantilla del informe Eléctrico — encabezado, datos del
 *  cliente/equipo, datos generales de la prueba, y firmas, con
 *  placeholders donde antes había datos reales. A diferencia de antes
 *  (2026-09-13): TTR/Devanados/Aislamiento YA NO tienen ninguna tabla
 *  horneada en la plantilla — desde la reestructura a tabla única
 *  (ver "Tabla única de resultados eléctricos" más arriba), esas 3
 *  secciones se calculan y arman por completo en tiempo de generación
 *  real, porque qué se fusiona (monofásico/trifásico, Simple/Completo,
 *  cuántos TAPs) solo se conoce ahí. La plantilla solo trae un marcador
 *  de posición (`<<TABLA_RESULTADOS_ELECTRICOS>>`, párrafo invisible
 *  igual que los marcadores de bloque) donde regenerateElectricalCombinedReport_
 *  inserta esa tabla, siempre antes de "Área de Control de Calidad". */
function buildElectricalTemplateDoc_() {
  var doc = DocumentApp.create('PLANTILLA_INFORME_ELECTRICO_' + Date.now());
  var body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(50).setMarginRight(50);

  appendPageHeader_(doc);
  // A diferencia de Aceite (que sí usa appendReportHeader_ completo, con
  // la grilla "Datos del cliente y del equipo" aparte), acá solo va el
  // título del protocolo — la grilla de cliente/equipo, la de "Datos
  // generales de la prueba" y las 4 secciones de resultados quedan TODAS
  // dentro de la misma tabla única (ver buildClientEquipoUnifiedRows_ y
  // regenerateElectricalCombinedReport_), sin ningún espacio entre ellas
  // — a pedido explícito del cliente.
  appendProtocolTitle_(body, 'PROTOCOLO DE PRUEBAS ELÉCTRICAS');

  var tablePlaceholder = body.appendParagraph('<<TABLA_RESULTADOS_ELECTRICOS>>');
  tablePlaceholder.editAsText().setFontSize(1);

  appendSignatureSection_(body,
    { nombre: '<<PROBADO_POR_NOMBRE>>', fecha: '<<PROBADO_POR_FECHA>>' },
    { nombre: '<<CERTIFICADO_POR_NOMBRE>>', fecha: '<<CERTIFICADO_POR_FECHA>>' }
  );

  var footer = doc.addFooter();
  var footerPar = footer.appendParagraph('M&A Ingeniería y Consultoría SAS · Informe generado vía Gestión de Pruebas el <<FECHA_GENERACION>>');
  footerPar.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  footerPar.editAsText().setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT_MUTED);

  doc.saveAndClose();
  return doc.getId();
}

/** Arma la plantilla del informe de Aceite Dieléctrico — mismo criterio que
 *  la Eléctrica. A diferencia de TTR/Devanados/Aislamiento, las 3 tablas de
 *  Aceite (Fisicoquímico/DGA/PCB) SÍ tienen cantidad de filas fija — llevan
 *  un placeholder por cada celda de VALOR, no una tabla "header-only". */
function buildOilTemplateDoc_() {
  var doc = DocumentApp.create('PLANTILLA_INFORME_ACEITE_' + Date.now());
  var body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(50).setMarginRight(50);

  appendPageHeader_(doc);
  appendReportHeader_(body, TEMPLATE_SITE_, TEMPLATE_TRANSFORMER_, TEST_TYPE_PROTOCOL_TITLE_.ACEITE_DIELECTRICO);

  appendSectionTitle_(body, 'Datos de la muestra');
  appendDenseInfoGrid_(body, [
    ['FECHA', '<<FECHA_MUESTRA>>', 'TÉCNICO RESPONSABLE', '<<TECNICO_MUESTRA>>'],
    ['MUESTRA TOMADA POR', '<<MUESTRA_TOMADA_POR>>', 'FECHA DE MUESTREO', '<<FECHA_MUESTREO>>']
  ]);

  appendBlockStart_(body, 'FISICOQUIMICO');
  appendSectionTitle_(body, 'Fisicoquímico');
  appendResultsTable_(body, [
    ['ENSAYO', 'VALOR', 'MÉTODO ASTM'],
    ['Agua', '<<AGUA_PPM>> ppm', 'ASTM D1533-20'],
    ['Rigidez dieléctrica', '<<RIGIDEZ_KV>> kV', 'ASTM D1816-12(2019)'],
    ['Tensión interfacial', '<<TENSION_INTERFACIAL>> dinas/cm', 'ASTM D971-20'],
    ['Número ácido', '<<NUMERO_ACIDO>> mg KOH/g', 'ASTM D974-22'],
    ['Densidad relativa', '<<DENSIDAD_RELATIVA>>', 'ASTM D1298-12b(2017)e1'],
    ['Color', '<<COLOR_ASTM>>', 'ASTM D1500-24'],
    ['Examen visual', '<<EXAMEN_VISUAL>>', 'ASTM D1524-15(2022)']
  ]);
  appendVerdictBanner_(body, 'Fisicoquímico', '<<VEREDICTO_FISICOQUIMICO>>');
  appendBlockEnd_(body, 'FISICOQUIMICO');

  appendBlockStart_(body, 'DGA');
  appendSectionTitle_(body, 'Cromatografía de Gases Disueltos (DGA)');
  var dgaRows = [['GAS', 'VALOR (PPM)']];
  OIL_DGA_GASES_.forEach(function (g) {
    dgaRows.push([g.label, '<<DGA_' + g.key.toUpperCase() + '>>']);
  });
  appendResultsTable_(body, dgaRows);
  var note = body.appendParagraph('Método ASTM D3612-02(2017), Método C — solo captura de datos, sin matriz de interpretación automática todavía.');
  note.editAsText().setItalic(true).setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
  appendBlockEnd_(body, 'DGA');

  appendBlockStart_(body, 'PCB');
  appendSectionTitle_(body, 'Cromatografía de PCB');
  var pcbRows = [['AROCLOR', 'VALOR (PPM)']];
  OIL_PCB_AROCLORES.forEach(function (key) {
    pcbRows.push([key.replace('aroclor_', 'Aroclor '), '<<PCB_' + key.toUpperCase() + '>>']);
  });
  pcbRows.push(['Total PCB', '<<PCB_TOTAL>> ppm']);
  appendResultsTable_(body, pcbRows);
  var pcbNote = body.appendParagraph('Método ASTM D4059-00(2018) · ente acreditado IDEAM.');
  pcbNote.editAsText().setItalic(true).setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
  appendVerdictBanner_(body, 'PCB', '<<VEREDICTO_PCB>>');
  appendBlockEnd_(body, 'PCB');

  appendBlockStart_(body, 'ADJUNTO');
  body.appendParagraph('');
  var certPar = body.appendParagraph('Certificado del laboratorio acreditado: <<URL_ADJUNTO>>');
  certPar.editAsText().setFontSize(9).setForegroundColor(PDF_COLORS_.ACCENT);
  var noteReplace = body.appendParagraph('Este informe es un resumen/interpretación de los resultados — no reemplaza el certificado del laboratorio acreditado.');
  noteReplace.editAsText().setItalic(true).setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
  appendBlockEnd_(body, 'ADJUNTO');

  appendVerdictBanner_(body, 'Veredicto general', '<<VEREDICTO_GENERAL>>');
  appendSignatureSection_(body,
    { nombre: '<<PROBADO_POR_NOMBRE>>', fecha: '<<PROBADO_POR_FECHA>>' },
    { nombre: '<<CERTIFICADO_POR_NOMBRE>>', fecha: '<<CERTIFICADO_POR_FECHA>>' }
  );

  var footer = doc.addFooter();
  var footerPar = footer.appendParagraph('M&A Ingeniería y Consultoría SAS · Informe generado vía Gestión de Pruebas el <<FECHA_GENERACION>>');
  footerPar.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  footerPar.editAsText().setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT_MUTED);

  doc.saveAndClose();
  return doc.getId();
}

/** Acción de Administración, solo Administrador — corre UNA sola vez (o de
 *  nuevo si alguna vez se necesita rehacer las plantillas). Genera los 2
 *  documentos, los mueve a la carpeta "Plantillas de Informes", los
 *  comparte con el mismo criterio "cualquiera con el enlace puede editar"
 *  de siempre, y persiste sus fileId en Propiedades del script — el
 *  usuario solo necesita las URLs devueltas para abrirlas y agregar el
 *  watermark a mano; no hace falta que copie ningún ID de vuelta. */
function crearPlantillasInformes_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede generar las plantillas de informes' });
  }
  var elecId = buildElectricalTemplateDoc_();
  var oilId = buildOilTemplateDoc_();
  var elecFile = DriveApp.getFileById(elecId);
  var oilFile = DriveApp.getFileById(oilId);
  moveFileToPlantillasFolder_(elecFile);
  moveFileToPlantillasFolder_(oilFile);
  shareForEditAnyone_(elecFile);
  shareForEditAnyone_(oilFile);
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_ELECTRICO_FILE_ID', elecId);
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_ACEITE_FILE_ID', oilId);
  return jsonResponse_({
    status: 200,
    message: 'Plantillas generadas — ábrelas y agrega el watermark del logo a mano en cada una (Insertar imagen → Detrás del texto → transparencia 85-92% → centrada)',
    data: { electricoUrl: elecFile.getUrl(), aceiteUrl: oilFile.getUrl() }
  });
}

/**
 * Punto 11, ronda 2 (2026-09-14) — migración puntual de la plantilla
 * ELÉCTRICA YA EXISTENTE (no una regeneración): el cliente compartió un
 * protocolo real donde el título trae, a la derecha, una caja de control
 * de documento (CÓDIGO/VERSIÓN/FECHA/PÁGINA) y un espacio para la foto
 * del equipo — ninguno de los dos existía en `appendProtocolTitle_`
 * (título de una sola celda, a todo lo ancho). Regenerar la plantilla
 * completa (`crearPlantillasInformes_`) los agregaría, pero BORRARÍA el
 * encabezado/pie de página/watermark que el cliente ya agregó a mano —
 * en vez de eso, esta función abre la plantilla YA EXISTENTE con
 * DocumentApp (no una copia) y reestructura SOLO la tabla del título,
 * dejando todo lo demás (header/footer/watermark, cuerpo del informe)
 * intacto.
 *
 * Ubica la tabla del título por FORMA + CONTENIDO exacto (1 fila, 1
 * celda, texto 'PROTOCOLO DE PRUEBAS ELÉCTRICAS' — el mismo criterio de
 * "ubicar por contenido, nunca por índice adivinado" que ya usa
 * findMarkerParagraph_/pinResultsTableHeaders_). Si no la encuentra (la
 * plantilla ya fue migrada antes, o alguien cambió el texto del título a
 * mano), no hace nada — nunca lanza, es seguro correrla más de una vez.
 * CÓDIGO/VERSIÓN/FECHA/PÁGINA y la foto quedan como texto/celda vacíos
 * para que el cliente los llene directo en la plantilla — mismo criterio
 * que el watermark, nunca datos que el código genere o inserte.
 */
function restructureElectricalTemplateTitle_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede modificar la plantilla' });
  }
  var templateId = getElectricalTemplateFileId_();
  if (!templateId) {
    return jsonResponse_({ status: 400, message: 'No existe la plantilla del informe eléctrico — genérala primero desde Administración.' });
  }

  var doc = DocumentApp.openById(templateId);
  var body = doc.getBody();
  var titleTable = null;
  for (var i = 0; i < body.getNumChildren(); i++) {
    var child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.TABLE) continue;
    var t = child.asTable();
    if (t.getNumRows() === 1 && t.getRow(0).getNumCells() === 1 && t.getText().trim() === 'PROTOCOLO DE PRUEBAS ELÉCTRICAS') {
      titleTable = t;
      break;
    }
  }
  if (!titleTable) {
    return jsonResponse_({ status: 404, message: 'No se encontró el título del protocolo en la plantilla — puede que ya se haya migrado antes, o que el título se haya editado a mano.' });
  }

  var idx = body.getChildIndex(titleTable);
  body.removeChild(titleTable);

  var newTitleTable = body.insertTable(idx, [['PROTOCOLO DE PRUEBAS ELÉCTRICAS', '']]);
  newTitleTable.setBorderColor(PDF_COLORS_.ACCENT);
  var titleCell = newTitleTable.getRow(0).getCell(0);
  titleCell.setBackgroundColor(PDF_COLORS_.ACCENT_SOFT);
  titleCell.setWidth(380);
  titleCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  titleCell.editAsText().setBold(true).setFontSize(13).setForegroundColor(PDF_COLORS_.ACCENT);

  // Caja de control de documento — texto de ejemplo, editable directo en
  // la plantilla (nunca lo toca regenerateElectricalCombinedReport_).
  var controlCell = newTitleTable.getRow(0).getCell(1);
  controlCell.setBackgroundColor('#ffffff');
  controlCell.editAsText().setText('CÓDIGO:\nVERSIÓN:\nFECHA:\nPÁGINA:');
  controlCell.editAsText().setBold(false).setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT_MUTED);

  // Espacio para la foto del equipo — caja vacía con borde, el cliente
  // inserta la imagen directo ahí (Insertar > Imagen > Desde el equipo).
  var photoTable = controlCell.appendTable();
  photoTable.setBorderColor(PDF_COLORS_.BORDER);
  var photoRow = photoTable.appendTableRow();
  photoRow.setMinimumHeight(70);
  var photoCell = photoRow.appendTableCell('Foto del equipo');
  photoCell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  photoCell.editAsText().setItalic(true).setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT_MUTED);

  doc.saveAndClose();
  return jsonResponse_({
    status: 200,
    message: 'Plantilla actualizada — abre el título y agrega la foto del equipo + completa CÓDIGO/VERSIÓN/FECHA/PÁGINA directo ahí.',
    data: { templateUrl: 'https://docs.google.com/document/d/' + templateId + '/edit' }
  });
}

/**
 * Un solo PDF consolidado (TTR/Devanados/Aislamiento, solo los tipos que
 * fueron ofertados para este equipo) — SOLO se genera desde la acción
 * explícita "Certificar Pruebas Eléctricas" (certifyElectricalReport_),
 * nunca automáticamente al certificar una prueba individual.
 *
 * Reescrita por segunda vez (2026-09-13) para la tabla única de
 * resultados: en vez de resolver bloques de plantilla por tipo y agregar
 * filas a tablas ya existentes, arma cada sección (TTR/AT/BT/Aislamiento)
 * como un arreglo de filas (`build*UnifiedRows_`), las concatena TODAS y
 * las inserta de una vez como una sola tabla de 7 columnas
 * (`insertUnifiedResultsTable_`) justo antes del marcador
 * `<<TABLA_RESULTADOS_ELECTRICOS>>` de la plantilla (nunca antes de
 * "Área de Control de Calidad", que sigue siendo una tabla aparte, sin
 * tocar). Las fusiones de celdas (monofásico, Aislamiento Simple/
 * Completo) se aplican después, vía Docs API, en finalizeReportPdf_.
 *
 * Aceite dieléctrico NO entra aquí — sigue con un informe por envío
 * (generateOilTestReportPdf_): es un análisis de una muestra puntual con
 * su propio laboratorio acreditado, conceptualmente distinto a una
 * medición eléctrica repetible del mismo equipo, y esa decisión no cambia.
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
function regenerateElectricalCombinedReport_(transformer, site, folderId, uploadedBy, includeTypes) {
  var latest = findLatestElectricalTestsByType_(transformer.id);
  var order = ['TTR', 'RESISTENCIA_DEVANADOS', 'AISLAMIENTO'];
  var present = order.filter(function (t) { return includeTypes.indexOf(t) !== -1 && latest[t]; });
  if (present.length === 0) return null;

  var templateId = getElectricalTemplateFileId_();
  if (!templateId) throw new Error('No existe la plantilla del informe eléctrico — genera las plantillas primero desde Administración.');

  var copy = DriveApp.getFileById(templateId).makeCopy('tmp_informe_electrico_' + Date.now());
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();

  // Datos de cliente/equipo/prueba general se calculan ANTES de armar las
  // secciones (2026-09-13): ya no son placeholders <<CLIENTE>>/
  // <<FECHA_GENERAL>>/etc. reemplazados después — ahora son las primeras
  // filas de la tabla única (ver buildClientEquipoUnifiedRows_/
  // buildDatosGeneralesUnifiedRows_), con el valor real ya adentro desde
  // que se construyen. `signedTest` (antes calculado al final, para
  // "PROBADO POR") se necesita aquí arriba para eso.
  var mostRecentType = present.reduce(function (a, b) {
    return toComparableDate_(latest[a].created_at) >= toComparableDate_(latest[b].created_at) ? a : b;
  });
  var signedTest = latest[mostRecentType];

  var esMonofasico = transformer.phase_type === 'MONOFASICO';
  // TÉCNICO RESPONSABLE = operador_nombre (2026-09-13, a pedido del
  // cliente): `tested_by` es la cuenta de LOGIN compartida (ej.
  // "admin.mya"), no identifica quién realmente hizo la prueba en campo
  // — `operador_nombre` sí, es el nombre que la app pide una vez por
  // dispositivo/navegador (ver "Convenciones de frontend" en CLAUDE.md).
  // Con fallback a tested_by para pruebas viejas que no tenían este campo.
  var tecnicoResponsable = signedTest.operador_nombre || signedTest.tested_by || '—';
  var ambienteTempText = signedTest.temperatura_ambiente ? (signedTest.temperatura_ambiente + ' °C') : null;
  var ambienteHumedadText = signedTest.humedad_relativa ? (signedTest.humedad_relativa + ' %') : null;
  // ESTADO DEL EQUIPO — dato que YA existía en TRANSFORMADORES
  // (estado_equipo, ver normalizeEstadoEquipo_), no hizo falta agregarlo.
  var estadoEquipoText = normalizeEstadoEquipo_(transformer.estado_equipo);

  var allNotes = [];
  // Punto 11 (2026-09-14): APROBADO general = TODAS las secciones
  // presentes APROBADAS — alimenta la Conclusión General con checkbox al
  // final de la tabla (buildConclusionRows_), no reemplaza ningún
  // veredicto individual, solo los combina.
  var allVerdicts = [];

  // Punto 11, ronda 2 (2026-09-14): la referencia real que compartió el
  // cliente numera cada sección (1-12) y pone TODOS los instrumentos +
  // normas aplicables en la sección "DATOS GENERALES DE LA PRUEBA" — eso
  // solo se sabe completo después de mirar qué tipos están presentes, pero
  // tiene que imprimirse ANTES de los resultados. Por eso el cálculo de
  // cada tipo (ttrCalc/wrCalc/aisCalc + su línea de instrumento) se separó
  // de dónde se arma outerRows: primero se calcula todo, después se arma
  // en el orden final del documento.
  function pushNormaUnica_(arr, norma) { if (arr.indexOf(norma) === -1) arr.push(norma); }
  var instrumentLines = [];
  var normas = [];
  var presentLabels = [];

  var ttrCalc = null, ttrInstrumento = null, ttrWarning = null;
  if (present.indexOf('TTR') !== -1) {
    var ttrRow = latest.TTR;
    ttrCalc = safeParseJson_(ttrRow.calculated_results_json);
    if (ttrCalc.theoreticalAvailable === false) {
      ttrWarning = 'Teórico no disponible — falta voltaje nominal de placa.';
    } else if (ttrCalc.theoreticalReliable === false) {
      ttrWarning = '⚠ Grupo de conexión no registrado en placa — teórico sin factor de relación trifásica, puede ser impreciso.';
    }
    var ttrCal = findMatchingCalibracionServer_(ttrRow.instrument_used);
    ttrInstrumento = 'Instrumento: ' + (ttrRow.instrument_used || '—') + (ttrCal ? ' (' + ttrCal.estado + ')' : '');
    instrumentLines.push(['INSTRUMENTO TTR', buildInstrumentLine_(ttrRow.instrument_used, ttrCal)]);
    pushNormaUnica_(normas, 'IEEE C57.12.90');
    presentLabels.push('relación de transformación (TTR)');
  }

  var wrCalc = null, wrInstrumento = null;
  if (present.indexOf('RESISTENCIA_DEVANADOS') !== -1) {
    var wrRow = latest.RESISTENCIA_DEVANADOS;
    wrCalc = safeParseJson_(wrRow.calculated_results_json);
    var wrCal = findMatchingCalibracionServer_(wrRow.instrument_used);
    wrInstrumento = 'Instrumento: ' + (wrRow.instrument_used || '—') + (wrCal ? ' (' + wrCal.estado + ')' : '');
    instrumentLines.push(['INSTRUMENTO MICRO-ÓHMETRO', buildInstrumentLine_(wrRow.instrument_used, wrCal)]);
    pushNormaUnica_(normas, 'IEEE C57.12.90');
    presentLabels.push('resistencia de devanados');
  }

  var aisCalc = null, aisInstrumento = null, aisTension = null, aisEsSimple = false;
  if (present.indexOf('AISLAMIENTO') !== -1) {
    var aisRow = latest.AISLAMIENTO;
    aisCalc = safeParseJson_(aisRow.calculated_results_json);
    var aisRaw = safeParseJson_(aisRow.raw_readings_json);
    var aisCal = findMatchingCalibracionServer_(aisRow.instrument_used);
    aisInstrumento = 'Instrumento: ' + (aisRow.instrument_used || '—') + (aisCal ? ' (' + aisCal.estado + ')' : '');
    aisTension = aisRaw && aisRaw.tension_prueba_v ? (aisRaw.tension_prueba_v + ' V') : null;
    aisEsSimple = aisCalc.metodo === 'simple';
    instrumentLines.push(['INSTRUMENTO MEGÓHMETRO', buildInstrumentLine_(aisRow.instrument_used, aisCal)]);
    pushNormaUnica_(normas, 'IEEE C57.152');
    presentLabels.push('resistencia de aislamiento');
  }

  // Punto 11, ronda 2: numeración secuencial de secciones (1, 2, 3...) sin
  // huecos — un informe con solo Aislamiento numera esa sección "3.", no
  // "8." (el número que tendría si TTR/Devanados estuvieran presentes).
  var n = 1;
  var outerRows = [
    outerNestedFullRow_(numberSection_(buildClientEquipoUnifiedRows_(site, transformer), n++)),
    outerNestedFullRow_(numberSection_(buildDatosGeneralesUnifiedRows_(
      fmtDatePdf_(signedTest.created_at), tecnicoResponsable, ambienteTempText, ambienteHumedadText,
      estadoEquipoText, instrumentLines, normas.join(' / ')
    ), n++))
  ];

  // TTR — a diferencia de AT/BT/Aislamiento (que van con un panel de
  // criterios al lado), la referencia real del cliente empareja TTR con
  // SU GRÁFICA de desviación por fase (outerPairTableImageRow_). El
  // veredicto de sección ahora vive DENTRO de la tabla anidada
  // (nestedVerdictRow_), no en una fila aparte de la tabla externa — otro
  // ajuste sobre la referencia real.
  if (ttrCalc) {
    var ttrRows = buildTtrUnifiedSection_(ttrCalc, esMonofasico, ttrInstrumento, ttrWarning);
    ttrRows.push(nestedVerdictRow_('Veredicto TTR', ttrCalc.overallVerdict));
    numberSection_(ttrRows, n++);
    // Misma condición que usa buildTtrDeviationChart_ internamente
    // (monofásico o sin TAPs no tiene gráfica) — se verifica ANTES de
    // pedir la imagen para saber si el número de sección 4 se consume o
    // no (sin huecos en la numeración si la gráfica no aplica).
    var willHaveChart = !esMonofasico && ttrCalc.taps && Object.keys(ttrCalc.taps).length > 0;
    if (willHaveChart) {
      var ttrChartBlob = buildTtrDeviationChart_(ttrCalc, esMonofasico, n++);
      outerRows.push(outerPairTableImageRow_(ttrRows, ttrChartBlob, 300, 157));
    } else {
      outerRows.push(outerNestedFullRow_(ttrRows));
    }
    allVerdicts.push(ttrCalc.overallVerdict);
    allNotes = allNotes.concat(collectTtrUnifiedNotes_(ttrCalc));
  }

  // AT y BT — Punto 4 (2026-09-13): primario y secundario son cada uno
  // opcional, se prueba solo AT, solo BT, o ambos.
  // calculateWindingResistance_ nunca devuelve un "primaryVerdict" aparte
  // (solo el overallVerdict combinado), así que se re-deriva aquí con la
  // MISMA fórmula que usa internamente (every tap APROBADO); el
  // secundario sí trae su propio `verdict` directo.
  //
  // Punto 11, ronda 2: AT y BT ahora van LADO A LADO entre sí (no cada uno
  // con su propio panel de criterios) — la referencia real trae una sola
  // tabla de criterios de Devanados, a todo lo ancho, DESPUÉS de ambos.
  if (wrCalc) {
    var atRows = null, btRows = null, atVerdict = null;
    if (wrCalc.taps && wrCalc.taps.length > 0) {
      atRows = buildWindingSideUnifiedRows_('ALTA TENSIÓN (AT)', wrCalc.taps, esMonofasico, transformer.at_devanado_material, wrInstrumento, WINDING_PHASE_ORDER_);
      atVerdict = wrCalc.taps.every(function (t) { return t.tapVerdict === 'APROBADO'; }) ? 'APROBADO' : 'RECHAZADO';
      atRows.push(nestedVerdictRow_('Veredicto AT', atVerdict));
      allVerdicts.push(atVerdict);
      allNotes = allNotes.concat(collectWindingSideUnifiedNotes_('AT', wrCalc.taps));
    }
    if (wrCalc.secondary) {
      btRows = buildWindingSideUnifiedRows_('BAJA TENSIÓN (BT)', [wrCalc.secondary], esMonofasico, transformer.bt_devanado_material, wrInstrumento, WINDING_SECONDARY_PHASE_ORDER_);
      btRows.push(nestedVerdictRow_('Veredicto BT', wrCalc.secondary.verdict));
      allVerdicts.push(wrCalc.secondary.verdict);
      allNotes = allNotes.concat(collectWindingSideUnifiedNotes_('BT', [wrCalc.secondary]));
    }
    if (atRows && btRows) {
      numberSection_(atRows, n++);
      numberSection_(btRows, n++);
      outerRows.push(outerNestedPairRow_(atRows, btRows));
    } else if (atRows) {
      outerRows.push(outerNestedFullRow_(numberSection_(atRows, n++)));
    } else if (btRows) {
      outerRows.push(outerNestedFullRow_(numberSection_(btRows, n++)));
    }
    if (atRows || btRows) {
      outerRows.push(outerNestedFullRow_(numberSection_(buildWindingCriteriaTable3Tier_(), n++)));
    }
  }

  // Aislamiento — sigue emparejado con su panel de criterios (leyenda
  // DAR/IP en Completo, nota corta en Simple), igual que ya estaba.
  if (aisCalc) {
    var aisRows = buildInsulationUnifiedRows_(aisCalc, aisInstrumento, aisTension);
    aisRows.push(nestedVerdictRow_('Veredicto Aislamiento', aisCalc.overallVerdict));
    numberSection_(aisRows, n++);
    var aisCriteriaRows = numberSection_(buildInsulationCriteriaRows_(aisEsSimple), n++);
    outerRows.push(outerNestedPairRow_(aisRows, aisCriteriaRows));
    allVerdicts.push(aisCalc.overallVerdict);
    allNotes = allNotes.concat(collectInsulationUnifiedNotes_(aisCalc));
  }

  var conclusionVerdict = allVerdicts.length && allVerdicts.every(function (v) { return String(v).indexOf('APROBADO') === 0; }) ? 'APROBADO' : 'RECHAZADO';
  outerRows.push(outerNestedFullRow_(numberSection_(buildObservacionesRows_(presentLabels, estadoEquipoText, normas.join(' / '), conclusionVerdict === 'APROBADO'), n++)));
  outerRows.push(outerNestedFullRow_(numberSection_(buildConclusionRows_(conclusionVerdict), n++)));

  var tablePlaceholderPar = findMarkerParagraph_(body, '<<TABLA_RESULTADOS_ELECTRICOS>>');
  if (!tablePlaceholderPar) throw new Error('La plantilla no tiene el marcador de la tabla de resultados — regenera las plantillas desde Administración.');
  var tableResult = insertOuterResultsTable_(body, tablePlaceholderPar, outerRows);
  body.removeChild(tablePlaceholderPar);
  appendUnifiedNoteFootnote_(body, tableResult.table, allNotes);
  // "12. ÁREA DE CONTROL DE CALIDAD" — Punto 11, ronda 2: la sección de
  // firmas (appendSignatureSection_) se arma UNA VEZ en la plantilla
  // (buildElectricalTemplateDoc_ → appendSectionTitle_, que además pasa el
  // texto a MAYÚSCULAS — el replaceText de abajo tiene que buscar el texto
  // YA en mayúsculas o nunca encuentra nada, sin lanzar error, solo se
  // queda sin numerar en silencio). No se puede numerar en la plantilla
  // misma porque el número real depende de cuántas secciones vinieron
  // antes en ESTE informe — se numera acá con un replaceText simple, sin
  // tocar la plantilla ni regenerarla.
  body.replaceText('ÁREA DE CONTROL DE CALIDAD', n + '. ÁREA DE CONTROL DE CALIDAD');

  // PROBADO POR = mismo criterio que TÉCNICO RESPONSABLE arriba
  // (operador_nombre, no la cuenta de login compartida). CERTIFICADO POR
  // (2026-09-13, a pedido del cliente) queda FIJO en el mismo ingeniero
  // que ya firma "APROBADO POR" — deja de mostrar quién certificó en la
  // app (revisado_por), la fecha real de certificación sí se conserva.
  body.replaceText('<<PROBADO_POR_NOMBRE>>', tecnicoResponsable);
  body.replaceText('<<PROBADO_POR_FECHA>>', fmtDatePdf_(signedTest.created_at));
  body.replaceText('<<CERTIFICADO_POR_NOMBRE>>', ENGINEER_SIGNATURE_NAME_);
  body.replaceText('<<CERTIFICADO_POR_FECHA>>', fmtDatePdf_(signedTest.revisado_at));

  var fileName = 'Informe_Electrico_' + transformer.serial_number + '_' + fmtTimestampForFilename_(new Date());
  var saved = finalizeReportPdf_(doc, folderId, fileName, { outerMarkerText: tableResult.outerMarkerText, outerMergeSpecs: tableResult.outerMergeSpecs, nestedRegistry: tableResult.nestedRegistry });

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
 *  (fisicoquimico_realizado/dga_realizado/pcb_realizado). Reescrita
 *  (2026-09-12) sobre el cambio de arquitectura de plantillas: copia la
 *  plantilla de Aceite, resuelve qué de las 3 secciones + el bloque de
 *  adjunto sobreviven, y reemplaza placeholders — a diferencia del
 *  Eléctrico, las 3 tablas de Aceite son de tamaño fijo, así que no hace
 *  falta insertar filas, solo reemplazar celdas de VALOR. */
function generateOilTestReportPdf_(transformer, site, rawReadings, calculated, testMeta, folderId) {
  var templateId = getOilTemplateFileId_();
  if (!templateId) throw new Error('No existe la plantilla del informe de aceite — genera las plantillas primero desde Administración.');

  var copy = DriveApp.getFileById(templateId).makeCopy('tmp_informe_aceite_' + Date.now());
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();

  body.replaceText('<<CLIENTE>>', site.client_name || '—');
  body.replaceText('<<NIT>>', site.nit || '—');
  body.replaceText('<<CIUDAD>>', site.ciudad || '—');
  body.replaceText('<<PROYECTO>>', site.project_name || '—');
  body.replaceText('<<FABRICANTE>>', transformer.manufacturer || '—');
  body.replaceText('<<NUMERO_SERIE>>', transformer.serial_number || '—');
  body.replaceText('<<GRUPO_CONEXION>>', transformer.vector_group || '—');
  body.replaceText('<<POTENCIA_NOMINAL>>', transformer.rated_power_kva ? String(transformer.rated_power_kva) : '—');
  body.replaceText('<<TENSION_PRIMARIA>>', transformer.hv_nominal_voltage ? String(transformer.hv_nominal_voltage) : '—');
  body.replaceText('<<TENSION_SECUNDARIA>>', transformer.lv_nominal_voltage ? String(transformer.lv_nominal_voltage) : '—');
  body.replaceText('<<REFRIGERACION>>', transformer.cooling_type || '—');
  body.replaceText('<<ANO_FABRICACION>>', transformer.manufacture_year ? String(transformer.manufacture_year) : '—');

  body.replaceText('<<FECHA_MUESTRA>>', fmtDatePdf_(testMeta.created_at));
  body.replaceText('<<TECNICO_MUESTRA>>', testMeta.tested_by || '—');
  body.replaceText('<<MUESTRA_TOMADA_POR>>', rawReadings.sample_taken_by || '—');
  body.replaceText('<<FECHA_MUESTREO>>', rawReadings.sample_date ? fmtDatePdf_(rawReadings.sample_date) : '—');

  resolveTemplateBlock_(body, 'FISICOQUIMICO', !!calculated.sections.fisicoquimico);
  if (calculated.sections.fisicoquimico) {
    setVerdictBannerColor_(body, '<<VEREDICTO_FISICOQUIMICO>>', calculated.sections.fisicoquimico.verdict);
    body.replaceText('<<VEREDICTO_FISICOQUIMICO>>', calculated.sections.fisicoquimico.verdict);
    body.replaceText('<<AGUA_PPM>>', String(numOrDash_(rawReadings.agua_ppm)));
    body.replaceText('<<RIGIDEZ_KV>>', String(numOrDash_(rawReadings.rigidez_dielectrica_kv)));
    body.replaceText('<<TENSION_INTERFACIAL>>', String(numOrDash_(rawReadings.tension_interfacial_dinas_cm)));
    body.replaceText('<<NUMERO_ACIDO>>', String(numOrDash_(rawReadings.numero_acido_mg_koh_g)));
    body.replaceText('<<DENSIDAD_RELATIVA>>', String(numOrDash_(rawReadings.densidad_relativa)));
    body.replaceText('<<COLOR_ASTM>>', rawReadings.color_astm || '—');
    body.replaceText('<<EXAMEN_VISUAL>>', rawReadings.examen_visual || '—');
  }

  resolveTemplateBlock_(body, 'DGA', !!calculated.sections.dga);
  if (calculated.sections.dga) {
    OIL_DGA_GASES_.forEach(function (g) {
      body.replaceText('<<DGA_' + g.key.toUpperCase() + '>>', String(numOrDash_(rawReadings[g.key])));
    });
  }

  resolveTemplateBlock_(body, 'PCB', !!calculated.sections.pcb);
  if (calculated.sections.pcb) {
    setVerdictBannerColor_(body, '<<VEREDICTO_PCB>>', calculated.sections.pcb.verdict);
    body.replaceText('<<VEREDICTO_PCB>>', calculated.sections.pcb.verdict);
    OIL_PCB_AROCLORES.forEach(function (key) {
      body.replaceText('<<PCB_' + key.toUpperCase() + '>>', String(numOrDash_(rawReadings[key])));
    });
    body.replaceText('<<PCB_TOTAL>>', calculated.sections.pcb.totalPcbPpm.toFixed(2));
  }

  resolveTemplateBlock_(body, 'ADJUNTO', !!testMeta.attachment_url);
  if (testMeta.attachment_url) {
    body.replaceText('<<URL_ADJUNTO>>', testMeta.attachment_url);
  }

  setVerdictBannerColor_(body, '<<VEREDICTO_GENERAL>>', calculated.overallVerdict);
  body.replaceText('<<VEREDICTO_GENERAL>>', calculated.overallVerdict);

  // Mismo criterio que el eléctrico (2026-09-13): PROBADO POR usa
  // operador_nombre (quien realmente hizo la prueba en campo), no
  // tested_by (la cuenta de login compartida); CERTIFICADO POR queda
  // fijo en el ingeniero responsable, igual que APROBADO POR.
  body.replaceText('<<PROBADO_POR_NOMBRE>>', testMeta.operador_nombre || testMeta.tested_by || '—');
  body.replaceText('<<PROBADO_POR_FECHA>>', fmtDatePdf_(testMeta.created_at));
  body.replaceText('<<CERTIFICADO_POR_NOMBRE>>', ENGINEER_SIGNATURE_NAME_);
  body.replaceText('<<CERTIFICADO_POR_FECHA>>', fmtDatePdf_(testMeta.revisado_at));

  return finalizeReportPdf_(doc, folderId, 'Informe_Aceite_' + transformer.serial_number);
}

/** Exporta el Doc a PDF, lo guarda en la carpeta destino, y manda el Doc
 *  intermedio a la papelera — solo el PDF queda como archivo real.
 *
 *  Reescrita (2026-09-12): antes armaba el pie de página desde cero
 *  (`doc.addFooter()`) porque cada informe se creaba en blanco; ahora el
 *  pie ya viene copiado de la plantilla (`makeCopy()` copia el documento
 *  completo, encabezado y pie incluidos) — solo hace falta reemplazar su
 *  único placeholder dinámico, la fecha de generación. DocumentApp no
 *  expone un campo dinámico de número de página en Apps Script, así que
 *  no se intenta un falso "Página X de Y" (decisión de antes, sigue
 *  vigente). */
/** `unifiedTableMerge` (opcional) — {bannerText, mergeSpecs} devuelto por
 *  insertUnifiedResultsTable_ para el informe eléctrico (ver
 *  regenerateElectricalCombinedReport_); ausente para Aceite, que no tiene
 *  tabla unificada. Se aplica DESPUÉS de doc.saveAndClose() (la Docs API
 *  avanzada solo ve cambios ya guardados) y ANTES de pinResultsTableHeaders_
 *  — el orden entre ambas no importa para el resultado, pero fusionar
 *  primero es más natural de leer. */
function finalizeReportPdf_(doc, folderId, fileName, unifiedTableMerge) {
  var footer = doc.getFooter();
  if (footer) footer.replaceText('<<FECHA_GENERACION>>', fmtDatePdf_(new Date().toISOString()));
  doc.saveAndClose();
  if (unifiedTableMerge) {
    try { applyOuterAndNestedMerges_(doc.getId(), unifiedTableMerge.outerMarkerText, unifiedTableMerge.outerMergeSpecs, unifiedTableMerge.nestedRegistry); }
    catch (mergeErr) { /* No relanzar — el PDF igual se genera, solo sin fusionar celdas. */ }
  }
  try { pinResultsTableHeaders_(doc.getId()); } catch (pinErr) { /* No relanzar — el PDF igual se genera sin encabezado repetido. */ }
  var docFile = DriveApp.getFileById(doc.getId());
  var pdfBlob = docFile.getAs('application/pdf').setName(fileName + '.pdf');
  var folder = DriveApp.getFolderById(folderId);
  var pdfFile = folder.createFile(pdfBlob);
  shareForEditAnyone_(pdfFile);
  docFile.setTrashed(true);
  return { fileId: pdfFile.getId(), url: pdfFile.getUrl() };
}

/** Texto plano de una celda de tabla, tal como viene del recurso `Document`
 *  de la Docs API avanzada (no de DocumentApp) — recorre
 *  `cell.content[].paragraph.elements[].textRun.content` concatenando.
 *  Usado solo para identificar la fila de encabezado de cada tabla por su
 *  contenido, nunca para mostrarlo. */
function docsApiCellText_(cell) {
  var text = '';
  (cell.content || []).forEach(function (block) {
    if (!block.paragraph) return;
    (block.paragraph.elements || []).forEach(function (pe) {
      if (pe.textRun) text += pe.textRun.content;
    });
  });
  return text.trim();
}

/**
 * Repite automáticamente la fila de encabezado de cada tabla de resultados
 * larga (TTR, Resistencia de Devanados —primario y secundario—,
 * Resistencia de Aislamiento) en cada página donde Google Docs decida
 * partir la tabla (2026-09-12) — reemplaza el truco anterior de saltos de
 * página manuales cada N filas.
 *
 * Usa `pinTableHeaderRows` de la Docs API avanzada (`Docs.Documents.
 * batchUpdate`, servicio avanzado habilitado en appsscript.json), la única
 * forma real de lograr esto: verificado contra la referencia oficial
 * (developers.google.com/docs/api/reference/rest/v1/documents/request)
 * que el request existe con exactamente estos dos campos —
 * `tableStartLocation` (dónde empieza la tabla) y `pinnedHeaderRowsCount`
 * (cuántas filas de encabezado pinear, acá siempre 1). DocumentApp no
 * tiene ningún equivalente (ver también appendSignatureSection_) — por
 * esto hace falta abrir el documento ya guardado con la Docs API para
 * ubicar dónde empieza cada tabla (`startIndex`, un dato que solo expone
 * este servicio, no DocumentApp).
 *
 * Se identifican las tablas candidatas por la FORMA de su fila de
 * encabezado (cantidad de celdas + texto de la primera), no por posición,
 * para no depender de que TTR/Devanados/Aislamiento aparezcan siempre en
 * el mismo orden ni de si Devanados trae su tabla "Secundario" o no:
 *   - 6 celdas, primera "TAP"           → TTR
 *   - 5 celdas, primera "TAP"           → Devanados (primario)
 *   - 4 celdas, primera "FASE"          → Devanados (secundario)
 *   - 5 celdas, primera "COMBINACIÓN"   → Aislamiento
 * Cualquier otra tabla del documento (grillas de datos, banner de
 * veredicto, firmas) no calza ninguna de las 4 formas y se ignora.
 *
 * NO cubre "evitar que una fila se parta entre dos páginas" — verificado
 * contra la misma referencia oficial que `TableRowStyle` (el objeto de
 * estilo de fila que sí existe en la Docs API) solo tiene `minRowHeight` y
 * `exactRowHeight`; no existe ningún campo `preventOverflow` ni equivalente
 * en toda la API. Repetir el encabezado es lo único que la Docs API
 * permite automatizar aquí.
 *
 * **QUEDÓ INERTE para el informe eléctrico (2026-09-13)**: desde la tabla
 * única de resultados (ver "Tabla única de resultados eléctricos" más
 * arriba), la fila 0 de esa tabla es siempre un banner de sección (1 sola
 * celda fusionada), nunca una de las formas de abajo — así que esta
 * función deja de encontrar nada que pinear ahí. Es una pérdida de
 * respaldo aceptada explícitamente por el cliente (equipos con muchos
 * TAPs que no quepan en 1 página ya no repiten encabezado al cambiar de
 * página) a cambio de que todo quede en una sola tabla continua. Se deja
 * la función tal cual (no rompe nada, solo deja de encontrar coincidencias
 * para el eléctrico) por si algún otro documento futuro sí tiene una tabla
 * con alguna de estas formas.
 */
/** Punto 11 (2026-09-14): desde el layout de 2 columnas, TTR/Devanados/
 *  Aislamiento ya NO son tablas de nivel superior — son tablas ANIDADAS
 *  dentro de la tabla externa (ver "Tabla EXTERNA de 2 columnas" más
 *  arriba). `pinTableHeaderRows` sigue funcionando igual sobre una tabla
 *  anidada (se direcciona por su propio `startIndex`, mismo mecanismo que
 *  las fusiones — ver applyOuterAndNestedMerges_), pero HAY que buscarlas
 *  con collectAllTables_ (recursivo) en vez de solo `doc.body.content`
 *  (antes alcanzaba porque todas eran de nivel superior) — si no, esta
 *  función queda inerte para el eléctrico (regresión real: se detectó al
 *  extender esto al layout de 2 columnas, corregida en el mismo cambio). */
function pinResultsTableHeaders_(docId) {
  var doc = Docs.Documents.get(docId);
  var allTables = [];
  collectAllTables_(doc.body.content, null, allTables);
  var requests = [];
  allTables.forEach(function (t) {
    var cellCount = t.row0cellCount;
    var firstCellText = t.row0cell0Text;
    // Punto 7 (2026-09-13): TTR compacto agrega las formas de 7 columnas
    // (trifásico) y 5 columnas (monofásico) con 'TAP'. Punto 8: Devanados
    // compacto agrega 6 columnas (trifásico, primario) y 4 columnas
    // (monofásico, primario) también con 'TAP' — ambigüedad con TTR sin
    // problema, ambas deben pinearse igual — más 6/4 columnas con
    // 'DEVANADO' (secundario). Punto 5 había dejado sin pinear la
    // variante Simple de Aislamiento (2 columnas) — se agrega aquí.
    var isResultsHeader =
      (cellCount === 7 && firstCellText === 'TAP') ||
      (cellCount === 6 && firstCellText === 'TAP') ||
      (cellCount === 5 && firstCellText === 'TAP') ||
      (cellCount === 4 && firstCellText === 'TAP') ||
      (cellCount === 6 && firstCellText === 'DEVANADO') ||
      (cellCount === 4 && firstCellText === 'DEVANADO') ||
      (cellCount === 5 && firstCellText === 'COMBINACIÓN') ||
      (cellCount === 2 && firstCellText === 'COMBINACIÓN');
    if (!isResultsHeader) return;
    requests.push({
      pinTableHeaderRows: {
        tableStartLocation: { index: t.startIndex },
        pinnedHeaderRowsCount: 1
      }
    });
  });
  if (requests.length > 0) {
    Docs.Documents.batchUpdate({ requests: requests }, docId);
  }
}

// ---------------------------------------------------------------------------
// Almacenamiento de archivos en Drive
// ---------------------------------------------------------------------------

function getOrCreateFolder_(name) {
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  var folder = DriveApp.createFolder(name);
  shareForEditAnyone_(folder);
  return folder;
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
  shareForEditAnyone_(file);
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
  var folder = parentFolder.createFolder(name);
  shareForEditAnyone_(folder);
  return folder;
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
  shareForEditAnyone_(file);
  return { fileId: file.getId(), url: file.getUrl() };
}

/**
 * Aplica "cualquiera con el enlace puede editar" a TODO lo que ya existía
 * en Drive antes de este cambio (2026-09-12) — shareForEditAnyone_ arriba
 * solo cubre archivos/carpetas creados DESDE ahora. Recorre toda la
 * carpeta raíz del proyecto de forma recursiva. Solo Administrador. Puede
 * tardar si hay muchos archivos — Apps Script corta la ejecución a los 6
 * minutos; si eso pasa, se puede volver a llamar sin problema (lo ya
 * compartido no se rompe por compartirlo de nuevo, solo cuesta tiempo
 * volver a recorrerlo).
 */
function applyDriveSharingToAll_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede aplicar permisos de Drive' });
  }
  var root = getRootFolder_();
  var counts = { folders: 1, files: 0 };
  shareForEditAnyone_(root);
  walkAndShare_(root, counts);
  return jsonResponse_({ status: 200, message: 'Permisos aplicados', data: counts });
}

function walkAndShare_(folder, counts) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    shareForEditAnyone_(files.next());
    counts.files++;
  }
  var subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    var sub = subfolders.next();
    shareForEditAnyone_(sub);
    counts.folders++;
    walkAndShare_(sub, counts);
  }
}

/**
 * Limpieza puntual (2026-09-12): deleteSite_/deleteTransformer_ nunca
 * borran las carpetas/archivos reales de Drive (a propósito, ver
 * comentario arriba de la estructura de carpetas), así que tras borrar
 * todos los Sitios DEMO/de prueba (limpieza del 2026-09-06 y
 * verificaciones posteriores) sus carpetas quedaron huérfanas en Drive —
 * ya no hay fila en SITIOS que guarde el ID para borrarlas por ID, así que
 * se buscan por NOMBRE bajo la carpeta raíz: cualquier carpeta que empiece
 * con "DEMO -" o "PRUEBA -", el mismo prefijo que este proyecto ya usa a
 * propósito para marcar datos no reales (ver "Estado / pendientes
 * conocidos" en CLAUDE.md). Solo Administrador. Manda a la papelera
 * (recuperable 30 días), nunca borra permanentemente.
 * `params.execute` (booleano): sin él (o en false), solo LISTA lo que
 * borraría, sin tocar nada — hay que pasarlo en true para borrar de
 * verdad, a propósito, para poder revisar la lista antes de ejecutar.
 */
function cleanupDemoSiteFolders_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede limpiar carpetas de Drive' });
  }
  var root = getRootFolder_();
  var folders = root.getFolders();
  var matches = [];
  while (folders.hasNext()) {
    var folder = folders.next();
    var name = folder.getName();
    if (name.indexOf('DEMO -') === 0 || name.indexOf('PRUEBA -') === 0) {
      matches.push(name);
      if (params.execute === true) folder.setTrashed(true);
    }
  }
  return jsonResponse_({
    status: 200,
    message: params.execute === true ? 'Carpetas enviadas a la papelera' : 'Vista previa — nada borrado todavía',
    data: { executed: params.execute === true, folders: matches }
  });
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
  certifyTest: certifyTest_,
  certifyElectricalReport: certifyElectricalReport_,
  generateReportTemplates: crearPlantillasInformes_,
  restructureElectricalTemplateTitle: restructureElectricalTemplateTitle_,
  rejectTest: rejectTest_,
  updateTestDraft: updateTestDraft_,
  uploadDocument: uploadDocument_,
  deleteDocument: deleteDocument_,
  ensureDriveStructure: ensureDriveStructure_,
  applyDriveSharingToAll: applyDriveSharingToAll_,
  cleanupDemoSiteFolders: cleanupDemoSiteFolders_,
  createOferta: createOferta_,
  updateOferta: updateOferta_,
  addOfertaNota: addOfertaNota_,
  deleteOferta: deleteOferta_,
  createCalibracion: createCalibracion_,
  updateCalibracion: updateCalibracion_,
  deleteCalibracion: deleteCalibracion_,
  uploadLogoAsset: uploadLogoAsset_,
  uploadEngineerSignatureAsset: uploadEngineerSignatureAsset_
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
