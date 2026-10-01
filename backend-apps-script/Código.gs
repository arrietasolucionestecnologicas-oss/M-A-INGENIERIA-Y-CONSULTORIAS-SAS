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
    'at_devanado_material', 'bt_devanado_material',
    // 2026-10-01, a pedido explícito del cliente en vivo: `posicion_tap_nominal`
    // es el TAP de FÁBRICA (referencia para el Informe de Historial — nunca
    // cambia). `posicion_actual_tap` es DISTINTA: dónde está físicamente el
    // conmutador HOY en el equipo real (puede estar en cualquier posición por
    // regulación de voltaje, independiente del nominal) — es la posición que
    // de verdad hay que probar en campo. Van al final por la misma regla de
    // "nunca insertar entre columnas existentes".
    'posicion_actual_tap'
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
    'uploaded_by', 'created_at',
    // Punto 11, ronda 7 (2026-09-17) — columnas nuevas, agregadas AL FINAL
    // (ensureAllSheets_ sincroniza la fila de encabezado sola, ver
    // comentario ahí) SOLO para el QR de autenticidad del informe
    // eléctrico: `id` de esta misma fila es el token que va en el QR
    // (`.../exec?verificar=<id>`), y estos 3 campos son lo que muestra la
    // página pública de verificación (verificarInformeElectrico_/doGet).
    // Quedan en blanco para cualquier documento que no sea un informe
    // eléctrico (adjuntos, informes de Aceite, subidas manuales).
    'transformer_id', 'verdict', 'certified_by'
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
// 2026-10-01, decisión explícita del cliente tras consultar normas (IEEE
// C57.125 / IEC 60076-1 citan ≤2% como ideal entre fases) vs. la práctica
// real de campo en Barranquilla: desensamblar un transformador de
// distribución en aluminio por un desbalance de 3-4% (común por oxidación
// Al2O3 en las uniones y termofluencia del aluminio, no necesariamente una
// falla) cuesta más que el equipo. Se mantiene 5% como el límite real de
// RECHAZADO (criterio operativo ya usado, no se cambia), pero entre 2% y 5%
// el veredicto pasa a 'OBSERVADO' (aprobado con nota explícita de la norma)
// en vez de 'APROBADO' silencioso — ver computePhaseUnbalance_.
var UNBALANCE_THRESHOLD_PERCENT = 5.0;
var UNBALANCE_OBSERVE_THRESHOLD_PERCENT = 2.0;

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
  // Punto 11, ronda 7 (2026-09-17) — página pública de verificación del QR
  // de autenticidad (ver regenerateElectricalCombinedReport_): quien
  // escanea el QR de un informe eléctrico NO tiene (ni debe necesitar)
  // usuario de la app, así que esta ruta se resuelve ACÁ, ANTES de
  // routeRequest_/validateAuth_ (que exige token para todo lo demás) —
  // nunca pasa por Control de Acceso ni por ninguna acción de POST_ACTIONS/
  // GET_ACTIONS.
  if (e && e.parameter && e.parameter.verificar) {
    return verificarInformeElectrico_(e.parameter.verificar);
  }
  return routeRequest_(e, 'GET');
}

function doPost(e) {
  return routeRequest_(e, 'POST');
}

/** Página pública (sin login) del QR de autenticidad — Punto 11, ronda 7
 *  (2026-09-17). `docId` es el `id` de la fila en DOCUMENTOS que
 *  `regenerateElectricalCombinedReport_` crea junto con el PDF (ver ahí:
 *  el mismo id va embebido en el QR y en esta fila, nunca 2 ids
 *  distintos). Muestra solo lo mínimo para confirmar autenticidad — nunca
 *  el PDF completo ni datos sensibles — y "no válido" si el id no
 *  corresponde a un CERTIFICADOS eléctrico real (mismo criterio: un QR
 *  reimpreso a mano con un id inventado no encuentra nada acá). Nunca
 *  lanza — cualquier error interno también cae en "no válido" en vez de
 *  un stack trace público. */
function verificarInformeElectrico_(docId) {
  var html;
  try {
    ensureAllSheets_();
    var sheet = getSheet_('DOCUMENTOS');
    var data = sheet.getDataRange().getValues();
    var idCol = HEADERS.DOCUMENTOS.indexOf('id');
    var row = null;
    for (var r = 1; r < data.length; r++) {
      if (data[r][idCol] === docId) { row = rowToObject_(data[r], 'DOCUMENTOS', r + 1); break; }
    }
    if (!row || row.category !== 'CERTIFICADOS' || !row.transformer_id) {
      html = verificationPageHtml_(false, null);
    } else {
      var transformer = findTransformerRow_(row.transformer_id);
      var site = transformer ? findSiteRow_(transformer.site_id) : null;
      html = verificationPageHtml_(true, {
        cliente: site ? site.client_name : '—',
        serie: transformer ? transformer.serial_number : '—',
        fecha: fmtDatePdf_(row.created_at),
        veredicto: row.verdict || '—',
        certificadoPor: row.certified_by || '—'
      });
    }
  } catch (e) {
    html = verificationPageHtml_(false, null);
  }
  return HtmlService.createHtmlOutput(html).setTitle('Verificación de certificado — M&A Ingeniería');
}

/** HTML mínimo, inline (sin plantilla ni assets externos — esta página la
 *  ve cualquiera que escanee el QR, no solo usuarios de la app). */
function verificationPageHtml_(valido, datos) {
  var style = 'body{font-family:Arial,Helvetica,sans-serif;background:#F4F6F7;margin:0;' +
    'padding:32px 16px;color:#222222;} .card{max-width:420px;margin:0 auto;background:#fff;' +
    'border-radius:8px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,0.15);} h1{font-size:16px;' +
    'margin:0 0 16px;color:#00506F;} .row{display:flex;justify-content:space-between;' +
    'padding:6px 0;border-bottom:1px solid #E5E8EA;font-size:13px;} .label{color:#404040;} ' +
    '.value{font-weight:bold;text-align:right;} .badge{display:inline-block;padding:4px 10px;' +
    'border-radius:4px;font-weight:bold;font-size:13px;} .ok{background:#C6EFCE;color:#006100;} ' +
    '.bad{background:#F4CCCC;color:#9C0006;} .warn{background:#FFEB9C;color:#9C6500;} ' +
    '.neutral{background:#E5E8EA;color:#404040;}';
  if (!valido) {
    return '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' + style + '</style></head><body><div class="card">' +
      '<h1>M&amp;A Ingeniería y Consultoría SAS</h1>' +
      '<span class="badge bad">Certificado no válido</span>' +
      '<p style="font-size:13px;color:#404040;margin-top:12px;">Este código no corresponde a ningún ' +
      'informe certificado por M&amp;A Ingeniería y Consultoría SAS.</p></div></body></html>';
  }
  // Ronda 10 (2026-09-29) — antes: indexOf('APROBADO')===0 ? 'ok' : 'bad',
  // que pintaba en rojo veredictos válidos de Aceite sin ese prefijo (ej.
  // "No contaminado"). Ahora reusa classifyVerdict_ (mismo semáforo que ya
  // pinta el PDF vía verdictColor_), con las 4 categorías reales.
  var badgeClassMap = { success: 'ok', danger: 'bad', warning: 'warn', neutral: 'neutral' };
  var badgeClass = badgeClassMap[classifyVerdict_(datos.veredicto)];
  return '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' + style + '</style></head><body><div class="card">' +
    '<h1>M&amp;A Ingeniería y Consultoría SAS</h1>' +
    '<span class="badge ok">Certificado válido</span>' +
    '<div class="row"><span class="label">Cliente</span><span class="value">' + escapeHtml_(datos.cliente) + '</span></div>' +
    '<div class="row"><span class="label">N° de serie</span><span class="value">' + escapeHtml_(datos.serie) + '</span></div>' +
    '<div class="row"><span class="label">Fecha</span><span class="value">' + escapeHtml_(datos.fecha) + '</span></div>' +
    '<div class="row"><span class="label">Resultado</span><span class="value ' + badgeClass + '">' + escapeHtml_(datos.veredicto) + '</span></div>' +
    '<div class="row" style="border-bottom:none;"><span class="label">Certificado por</span><span class="value">' + escapeHtml_(datos.certificadoPor) + '</span></div>' +
    '</div></body></html>';
}

/** Escape mínimo de HTML — esta página pública inserta texto que viene de
 *  Sheets (nombre de cliente, etc.) directo en el HTML, sin plantilla que
 *  lo escape sola. */
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    posicion_actual_tap: row.posicion_actual_tap || null,
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
    if (params.posicion_actual_tap) {
      var createTapCount2 = params.numero_posiciones_tap || 5;
      if (params.posicion_actual_tap < 1 || params.posicion_actual_tap > createTapCount2) {
        return jsonResponse_({ status: 400, message: 'posicion_actual_tap debe estar entre 1 y ' + createTapCount2 });
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
      posicion_actual_tap: params.posicion_actual_tap || '',
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
    if (params.posicion_actual_tap) {
      var updateTapCount2 = params.numero_posiciones_tap || row.numero_posiciones_tap || 5;
      if (params.posicion_actual_tap < 1 || params.posicion_actual_tap > updateTapCount2) {
        return jsonResponse_({ status: 400, message: 'posicion_actual_tap debe estar entre 1 y ' + updateTapCount2 });
      }
    }

    var updates = {};
    ['serial_number', 'manufacturer', 'manufacture_year', 'phase_type', 'vector_group', 'rated_power_kva',
      'hv_nominal_voltage', 'lv_nominal_voltage', 'site_id',
      'cooling_type', 'impedance_percent', 'insulation_type', 'numero_posiciones_tap', 'posicion_tap_nominal',
      'posicion_actual_tap',
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
      // Ronda 9 (2026-09-26): regenerateOilCombinedReport_ reemplaza
      // generateOilTestReportPdf_ — YA escribe su propia fila en
      // DOCUMENTOS (con transformer_id/verdict/certified_by, para que el
      // QR de autenticidad funcione igual que en Eléctrico) usando
      // `verificationId` como `id` — el appendRow_ manual que vivía acá
      // se quita, o quedaría una fila duplicada con un id que el QR no
      // conoce.
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
        var oilReport = regenerateOilCombinedReport_(transformer, site, rawReadings, calculated, oilTestMeta, folders.certificadosFolderId);
        reportFileId = oilReport.fileId;
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

/** Texto de la nota automática para un desbalance en la zona "OBSERVADO"
 *  (entre 2% y 5%) — ver UNBALANCE_OBSERVE_THRESHOLD_PERCENT arriba para el
 *  porqué. Se combina con una nota propia del técnico ("repetí esta
 *  lectura") si ya existía, nunca la reemplaza. */
function unbalanceObserveNote_(deviationPercent, existingNota) {
  var norm = 'Desbalance ' + Math.abs(deviationPercent).toFixed(2) + ' % — por encima del 2 % ideal de la norma ' +
    '(IEEE C57.125 / IEC 60076-1) pero dentro del margen operativo de campo (5 %) para devanados de aluminio ' +
    'en equipos de distribución: aprobado con observación, revisar en el próximo mantenimiento.';
  return existingNota ? (existingNota + ' · ' + norm) : norm;
}

/** Desbalance entre fases a partir de un objeto {clave: {resistanceOhm}} —
 *  reusado tanto para cada TAP del primario como para el secundario (una
 *  sola medición, sin TAP), para no duplicar la fórmula.
 *  2026-10-01: veredicto de 3 niveles (antes solo APROBADO/RECHAZADO) — ver
 *  UNBALANCE_OBSERVE_THRESHOLD_PERCENT/UNBALANCE_THRESHOLD_PERCENT. */
function computePhaseUnbalance_(phases) {
  var keys = Object.keys(phases || {});
  if (keys.length === 0) throw new Error('No hay lecturas de fase');

  var values = keys.map(function (k) { return phases[k].resistanceOhm; });
  var avg = values.reduce(function (a, b) { return a + b; }, 0) / values.length;

  var phaseResults = {};
  var maxUnbalance = 0;
  var anyRechazado = false, anyObservado = false;

  if (keys.length === 1) {
    phaseResults[keys[0]] = { resistanceOhm: values[0], deviationFromAvgPercent: 0, status: 'APROBADO', nota: phases[keys[0]].nota || null };
  } else {
    keys.forEach(function (k) {
      var v = phases[k].resistanceOhm;
      var deviation = ((v - avg) / avg) * 100;
      var absDeviation = Math.abs(deviation);
      var status, nota;
      if (absDeviation > UNBALANCE_THRESHOLD_PERCENT) {
        status = 'RECHAZADO'; nota = phases[k].nota || null; anyRechazado = true;
      } else if (absDeviation > UNBALANCE_OBSERVE_THRESHOLD_PERCENT) {
        status = 'OBSERVADO'; nota = unbalanceObserveNote_(deviation, phases[k].nota || null); anyObservado = true;
      } else {
        status = 'APROBADO'; nota = phases[k].nota || null;
      }
      phaseResults[k] = { resistanceOhm: v, deviationFromAvgPercent: deviation, status: status, nota: nota };
      if (absDeviation > maxUnbalance) maxUnbalance = absDeviation;
    });
  }

  var verdict = anyRechazado ? 'RECHAZADO' : (anyObservado ? 'OBSERVADO' : 'APROBADO');
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

  // `null` (no "APROBADO" por vacuidad) cuando no se probó el primario — el
  // punto 4 (2026-09-13) permite enviar solo secundario, y un primario nunca
  // probado no debe contar como "aprobado". 2026-10-01: cascada de 3
  // niveles — antes `every(... === 'APROBADO')` colapsaba un TAP OBSERVADO
  // directo a RECHAZADO, perdiendo la nota/gradación.
  var primaryVerdict = tapResults.length > 0
    ? (tapResults.some(function (t) { return t.tapVerdict === 'RECHAZADO'; }) ? 'RECHAZADO'
      : (tapResults.some(function (t) { return t.tapVerdict === 'OBSERVADO'; }) ? 'OBSERVADO' : 'APROBADO'))
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
  // opcional; ahora cualquiera de los dos puede faltar. 2026-10-01: cascada
  // de 3 niveles, mismo criterio que primaryVerdict arriba.
  var overallVerdict =
    (primaryVerdict === 'RECHAZADO' || (secondaryResult && secondaryResult.verdict === 'RECHAZADO')) ? 'RECHAZADO'
    : (primaryVerdict === 'OBSERVADO' || (secondaryResult && secondaryResult.verdict === 'OBSERVADO')) ? 'OBSERVADO'
    : 'APROBADO';

  return {
    unbalanceThresholdPercent: UNBALANCE_THRESHOLD_PERCENT,
    unbalanceObserveThresholdPercent: UNBALANCE_OBSERVE_THRESHOLD_PERCENT,
    taps: tapResults,
    // 2026-10-01: se expone primaryVerdict (ya calculado arriba con la
    // cascada de 3 niveles) para que regenerateElectricalCombinedReport_ lo
    // use directo en vez de re-derivarlo con su propia fórmula — antes esa
    // re-derivación usaba `every(tapVerdict === 'APROBADO')`, colapsando un
    // TAP OBSERVADO a RECHAZADO en el informe combinado.
    primaryVerdict: primaryVerdict,
    secondary: secondaryResult,
    overallVerdict: overallVerdict
  };
}

/** Bug real reportado por el usuario el 2026-10-01: "Veredicto AT: undefined"
 *  en un informe combinado recién generado. Causa — `wrCalc` en
 *  `regenerateElectricalCombinedReport_` no se recalcula: se lee TAL CUAL
 *  quedó guardado en `calculated_results_json` de la prueba de Devanados ya
 *  certificada. Cualquier prueba de Devanados certificada ANTES del deploy
 *  del veredicto graduado (2026-10-01, `primaryVerdict` recién agregado al
 *  objeto que devuelve `calculateWindingResistance_`) quedó guardada SIN
 *  ese campo — al generar o regenerar el informe combinado para esa prueba
 *  vieja, `wrCalc.primaryVerdict` es `undefined`. Este helper repite la
 *  misma cascada de 3 niveles a partir de `taps[].tapVerdict` (que SÍ
 *  existía antes) cuando falta `primaryVerdict`, para que registros viejos
 *  sigan funcionando sin tener que volver a certificar la prueba. */
function legacyPrimaryVerdictFallback_(wrCalc) {
  if (wrCalc.primaryVerdict) return wrCalc.primaryVerdict;
  if (!wrCalc.taps || !wrCalc.taps.length) return null;
  if (wrCalc.taps.some(function (t) { return t.tapVerdict === 'RECHAZADO'; })) return 'RECHAZADO';
  if (wrCalc.taps.some(function (t) { return t.tapVerdict === 'OBSERVADO'; })) return 'OBSERVADO';
  return 'APROBADO';
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
/** Ronda 9 (2026-09-26) — Protocolo único de Aceite Dieléctrico, a pedido
 *  explícito del usuario ("parecido al de pruebas [eléctrico], sin las
 *  fotos"): mismos 7 parámetros que YA se capturan hoy (nunca se agregan
 *  campos nuevos al formulario — Viscosidad/Factor de potencia/Inhibidor/
 *  Sedimentos que trae la referencia visual quedan fuera, decisión
 *  explícita del usuario), con el mismo método ASTM que ya usaba
 *  `buildOilTemplateDoc_` (plantilla vieja) por parámetro — no se inventa
 *  ningún método nuevo, se reusa el ya aprobado. `check` es null cuando el
 *  parámetro no tiene umbral numérico definido (Examen visual/Color/
 *  Densidad) — la fila muestra ESTADO "—" en vez de CUMPLE/NO CUMPLE
 *  inventado.
 */
var OIL_FISICOQUIMICO_PARAMS_ = [
  { key: 'examen_visual', label: 'Examen visual', metodo: 'ASTM D1524-15(2022)', unidad: '—', isText: true, check: null },
  { key: 'color_astm', label: 'Color', metodo: 'ASTM D1500-24', unidad: '—', isText: true, check: null },
  { key: 'densidad_relativa', label: 'Densidad relativa', metodo: 'ASTM D1298-12b(2017)e1', unidad: '—', check: null },
  { key: 'tension_interfacial_dinas_cm', label: 'Tensión interfacial (IFT)', metodo: 'ASTM D971-20', unidad: 'mN/m', limiteText: '≥ ' + OIL_TENSION_INTERFACIAL_MIN_MN_M + ' mN/m', check: function (v) { return v >= OIL_TENSION_INTERFACIAL_MIN_MN_M; } },
  { key: 'numero_acido_mg_koh_g', label: 'Número de acidez (TAN)', metodo: 'ASTM D974-22', unidad: 'mg KOH/g', limiteText: '≤ ' + OIL_ACIDEZ_MAX_MG_KOH_G + ' mg KOH/g', check: function (v) { return v <= OIL_ACIDEZ_MAX_MG_KOH_G; } },
  { key: 'agua_ppm', label: 'Contenido de agua', metodo: 'ASTM D1533-20', unidad: 'ppm', limiteText: '≤ ' + OIL_HUMEDAD_MAX_PPM + ' ppm', check: function (v) { return v <= OIL_HUMEDAD_MAX_PPM; } },
  { key: 'rigidez_dielectrica_kv', label: 'Rigidez dieléctrica', metodo: 'ASTM D1816-12(2019)', unidad: 'kV', limiteText: '≥ ' + OIL_RIGIDEZ_MIN_KV + ' kV', check: function (v) { return v >= OIL_RIGIDEZ_MIN_KV; } }
];
/** Método/límite de cuantificación/incertidumbre de PCB — igual que los
 *  métodos ASTM de arriba, son datos FIJOS de la metodología de
 *  laboratorio (no una medición por muestra), no un dato inventado por
 *  esta app. El método ya documentado en la plantilla vieja
 *  ("ASTM D4059-00(2018) · ente acreditado IDEAM") se reemplaza por el
 *  que trae la referencia visual más reciente del usuario (EPA 8082 por
 *  GC-ECD) — ambos son métodos reales para PCB en aceite, se usa el que
 *  el usuario mostró último.
 */
var OIL_PCB_METODO_ = 'EPA 8082 (por GC-ECD)';
var OIL_PCB_LOQ_PPM_ = 0.5;
var OIL_PCB_INCERTIDUMBRE_ = '± 10 %';
/** Clasificación real de la Resolución 0222 de 2011 (MinAmbiente,
 *  Colombia) por concentración de PCB — regulación pública verificable,
 *  no un umbral inventado por esta app (el único que ya estaba en código,
 *  OIL_PCB_LIMITE_PPM=50, es exactamente el primer corte de esta misma
 *  tabla). Se agrega completa porque la referencia visual del usuario la
 *  trae completa. */
var OIL_PCB_CLASIFICACION_ = [
  { rango: '< 50', clasificacion: 'NO PCB', descripcion: 'Puede ser gestionado como residuo convencional (según aplicabilidad).' },
  { rango: '≥ 50 y < 500', clasificacion: 'PCB - Grupo 3', descripcion: 'Equipos o desechos contaminados con PCB (baja concentración).' },
  { rango: '≥ 500 y < 100.000', clasificacion: 'PCB - Grupo 2', descripcion: 'Equipos o desechos contaminados con PCB (concentración intermedia).' },
  { rango: '≥ 100.000', clasificacion: 'PCB - Grupo 1', descripcion: 'Equipos o desechos contaminados con PCB (alta concentración).' }
];

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

/** Paleta del protocolo PDF (2026-09-15, "prompt maestro" del cliente —
 *  reemplaza la paleta gris del 2026-09-13). Totalmente independiente de
 *  `--accent`/etc. en `styles.css` (el tema de la app en pantalla) — ya
 *  venía siendo así desde el cambio del 2026-09-13, esto solo cambia LOS
 *  VALORES del lado del PDF, no reconecta nada con la app. Centralizada
 *  acá a propósito (pedido explícito del cliente: "centralizar todos los
 *  colores en una única constante, no escribir colores diferentes
 *  manualmente en cada función") — todo el código de generación de PDF ya
 *  usaba exclusivamente `PDF_COLORS_.*`, así que este cambio de valores
 *  se propaga solo, sin tocar ninguna función de armado. */
var PDF_COLORS_ = {
  ACCENT: '#00506F',
  ACCENT_SOFT: '#DCEAF2',
  TEXT: '#222222',
  TEXT_MUTED: '#404040',
  SUCCESS: '#006100', SUCCESS_BG: '#C6EFCE',
  WARNING: '#7F6000', WARNING_BG: '#FFF2CC',
  DANGER: '#9C0006', DANGER_BG: '#F4CCCC',
  NEUTRAL_BG: '#E5E8EA',
  BORDER: '#AEB7BD',
  // Punto 11, ronda 7 (2026-09-17) — token puntual del JSON de diseño del
  // cliente ("label_bg_blue"), usado SOLO en la Sección 1 de 3 columnas
  // (ver buildSection1ThreeColRows_) — no reemplaza NEUTRAL_BG en el
  // resto del documento, que el cliente nunca pidió cambiar.
  LABEL_BG_BLUE: '#E8F1F8'
};

/** Título de protocolo — barra prominente bajo el encabezado, formato
 *  "protocolo de pruebas" estándar de la industria (referencia visual dada
 *  por el usuario: dense datasheet grid + barras de sección + bloque de
 *  "área de control de calidad" al final). Las 3 pruebas eléctricas ya no
 *  tienen título propio: comparten uno solo en el informe combinado
 *  (regenerateElectricalCombinedReport_); solo Aceite sigue siendo un
 *  informe independiente por envío. */
var TEST_TYPE_PROTOCOL_TITLE_ = {
  ACEITE_DIELECTRICO: 'PROTOCOLO DE ANÁLISIS DE ACEITE DIELÉCTRICO',
  HISTORIAL: 'INFORME DE HISTORIAL DE PRUEBAS'
};

/** Mismo criterio de severidad que ya usa la app para pintar pills
 *  (success/warning/danger) — mapea cualquier veredicto de los 4 módulos de
 *  prueba a un color. REGISTRADO (Aceite con solo DGA, sin veredicto
 *  propio) y cualquier valor no reconocido caen en neutro. */
/** Categoría semántica de un veredicto — extraído de verdictColor_ (ronda
 *  10, 2026-09-29) para que verificationPageHtml_ (página pública del QR)
 *  pinte el mismo semáforo que ya usa el PDF, en vez de su propio chequeo
 *  ingenuo `indexOf('APROBADO') === 0` que pintaba en rojo veredictos
 *  válidos de Aceite como "No contaminado" (HALLAZGO real, ver CLAUDE.md). */
function classifyVerdict_(verdict) {
  var v = String(verdict || '');
  if (v.indexOf('APROBADO') === 0 || v === 'No contaminado') return 'success';
  if (v === 'RECHAZADO' || v.indexOf('REQUIERE REGENERACIÓN') === 0 || v.indexOf('Contaminado') === 0) return 'danger';
  if (v === 'OBSERVADO' || v.indexOf('REQUIERE TERMOVACÍO') === 0) return 'warning';
  return 'neutral';
}

function verdictColor_(verdict) {
  var category = classifyVerdict_(verdict);
  if (category === 'success') return { bg: PDF_COLORS_.SUCCESS_BG, text: PDF_COLORS_.SUCCESS };
  if (category === 'danger') return { bg: PDF_COLORS_.DANGER_BG, text: PDF_COLORS_.DANGER };
  if (category === 'warning') return { bg: PDF_COLORS_.WARNING_BG, text: PDF_COLORS_.WARNING };
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

/** QR de autenticidad — Punto 11, ronda 7 (2026-09-17). `Charts.newQRCode`
 *  NO existe en el servicio Charts de Apps Script (no hay tipo de gráfico
 *  QR nativo — confirmado en vivo: "Charts.newQRCode is not a function").
 *  Se genera vía `api.qrserver.com` (servicio público gratuito, sin
 *  API key) con `UrlFetchApp` — mismo patrón que cualquier llamada HTTP
 *  saliente de Apps Script. Nunca lanza — si el servicio no responde, el
 *  informe se genera igual, solo sin QR (mismo criterio que
 *  getEngineerSignatureBlob_/getTransformerPlatePhotoBlob_). */
function getQrCodeBlob_(text) {
  try {
    var url = 'https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=2&data=' + encodeURIComponent(text);
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) return resp.getBlob();
  } catch (e) { /* No relanzar — ver comentario de arriba. */ }
  return null;
}

/** Punto 11, ronda 7b (2026-09-17) — HALLAZGO REAL: el QR generado sí
 *  decodifica perfecto en su tamaño original (confirmado bajando la
 *  imagen fuente y leyéndola con el propio lector de qrserver.com), pero
 *  la miniatura REAL del PDF ya exportado (`drive.google.com/thumbnail`)
 *  NO decodifica — Google Docs reescala/recomprime la imagen al
 *  exportar a PDF, y a 45pt de ancho la URL completa (larga: dominio de
 *  Apps Script + deploymentId + id de verificación, ~150 caracteres)
 *  queda con demasiados módulos para ese tamaño físico, así que el
 *  camarógrafo del celular no la detecta — confirmado en vivo por el
 *  cliente ("la cámara no detecta ningún código"). Se acorta la URL con
 *  is.gd (servicio público gratuito, sin API key) ANTES de generar el
 *  QR — menos caracteres = menos módulos = QR más "grueso" y fácil de
 *  leer al mismo tamaño físico. Si el acortador falla, se usa la URL
 *  completa igual (nunca debe bloquear la generación del informe). */
function shortenUrl_(longUrl) {
  try {
    var resp = UrlFetchApp.fetch('https://is.gd/create.php?format=simple&url=' + encodeURIComponent(longUrl), { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var short = resp.getContentText().trim();
      if (short.indexOf('http') === 0) return short;
    }
  } catch (e) { /* No relanzar — se usa la URL larga como respaldo. */ }
  return longUrl;
}

/** Foto de placa del transformador (`plate_photo_file_id`, la sube el
 *  técnico al crear/editar el equipo — ver createTransformer_/
 *  updateTransformer_) — Punto 11, ronda 7 (2026-09-17): reusada como la
 *  foto de la columna central de la nueva Sección 1 de 3 columnas. Mismo
 *  criterio que getEngineerSignatureBlob_/getLogoBlob_: si el equipo nunca
 *  tuvo foto, el informe se genera igual, sin bloquear. */
function getTransformerPlatePhotoBlob_(fileId) {
  if (!fileId) return null;
  try { return DriveApp.getFileById(fileId).getBlob(); } catch (e) { return null; }
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

/** Caja de título del protocolo — fondo acento sólido, texto blanco
 *  centrado (2026-09-15, "prompt maestro" del cliente — antes era fondo
 *  claro con texto de color, ver el mismo cambio de paleta en
 *  PDF_COLORS_). Va justo bajo el encabezado (logo + nombre), antes de
 *  cualquier sección de datos. Solo usada al armar plantillas. */
function appendProtocolTitle_(body, text) {
  var table = body.appendTable([[text]]);
  table.setBorderColor(PDF_COLORS_.ACCENT);
  var cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(PDF_COLORS_.ACCENT);
  var par = cell.getChild(0).asParagraph();
  par.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  cell.editAsText().setBold(true).setFontSize(15).setFontFamily(PROTOCOL_FONT_FAMILY_).setForegroundColor('#ffffff');
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
/** Tamaños de fuente — actualizados 2026-09-15 al "prompt maestro" del
 *  cliente (antes eran más pequeños, 5pt mínimo, del pedido de
 *  compactación del 2026-09-13; el cliente ahora prioriza legibilidad
 *  sobre caber en 1 sola hoja a toda costa — ver Punto 11 en CLAUDE.md,
 *  "control de desbordamiento": ajustar espaciado ANTES que sacrificar
 *  tamaño de fuente). */
// Tamaños bajados otra vez en la ronda 4 (2026-09-16, "una sola página")
// dentro de los rangos que el cliente pidió esta vez (banner 8-8.5,
// encabezados de tabla 6.5-7) — el orden que pidió es geometría/espaciado/
// columnas PRIMERO, tipografía después; esto es el paso de tipografía,
// aplicado después de los anchos de columna (TTR_WINDING_COL_WIDTHS_PT_/
// EQUIPOS_COL_WIDTHS_PT_) que ya deberían evitar el wrap sin bajar más la
// fuente de datos.
var UNIFIED_FONT_BANNER_ = 8.5;
var UNIFIED_FONT_HEADER_ = 7;
var UNIFIED_FONT_VERDICT_ = 8;
// UNIFIED_FONT_DATA_ se queda en 6 (no en 6.5-7 como pide esta ronda) —
// bajó de 7 a 6 en la ronda 3 porque a 7pt palabras como "APROBADO"/
// "EXCELENTE"/"CUESTIONABLE" se partían en 2 líneas en las columnas
// angostas de las tablas emparejadas. Con los anchos de columna explícitos
// de esta ronda eso debería resolverse en la RAÍZ (geometría, no fuente)
// — pero hasta verificarlo en vivo, se deja en 6 (dentro del piso que la
// ronda 3 ya había fijado) en vez de arriesgar que vuelva a partirse.
var UNIFIED_FONT_DATA_ = 6;
/** Padding mínimo de celda (en puntos) — DocumentApp lo deja en ~5pt por
 *  defecto en cada lado; bajarlo a esto es lo que de verdad reduce la
 *  altura de cada fila (más que la fuente en sí), igual que pidió el
 *  cliente ("celdas y filas al mínimo").
 *  Punto 11, ronda 6 (2026-09-16): bajado de 1 a 0.5 — con la Sección
 *  8/9 (Gráficos+Criterios) ya en su piso de compactación (ver
 *  `buildWindingCriteriaTable3Tier_`/`buildInsulationUnifiedRows_`/
 *  `buildDarIpLegendRows_`, `rows.cellPadding = 0.5`), el PDF real seguía
 *  desbordando a una 2ª página por SOLO la última fila de la leyenda
 *  DAR/IP (confirmado con pdftotext -f 2 -l 2 sobre un informe generado
 *  en vivo). El diagnóstico esta vez no fue "una sección puntual", sino
 *  el padding de 1pt acumulado en las ~35-40 filas del resto de
 *  secciones (1-7, 10, 11) que NO tenían override — bajar el piso
 *  global a 0.5pt (mismo valor ya validado para 8/9, dentro del rango
 *  0.5-2pt que pidió el cliente) recupera ~35-40pt, de sobra para la
 *  ~1 fila que faltaba. */
var UNIFIED_CELL_PADDING_ = 0.5;
/** Familia tipográfica única del protocolo — Arial, a pedido explícito
 *  del "prompt maestro" (punto 5). Google Docs ya usa Arial por defecto
 *  en documentos nuevos, pero se fija explícito en cada celda para no
 *  depender de ese default. */
var PROTOCOL_FONT_FAMILY_ = 'Arial';

// Punto 11, ronda 4 (2026-09-16) — anchos de columna explícitos para las
// tablas anidadas que SIEMPRE viven en contexto de mitad de página (TTR,
// AT, BT y Equipos Utilizados van emparejadas de a 2, ver
// regenerateElectricalCombinedReport_) — sin esto DocumentApp reparte las
// 7 columnas en partes iguales y las palabras largas de encabezado/estado
// se parten. 270pt es un ancho conservador para la mitad de página en A4
// con márgenes de 6mm (columna útil real ≈ 276pt; se deja un margen de
// seguridad para el borde/padding de la tabla externa).
var NESTED_HALF_WIDTH_PT_ = 270;
/** TAP/U/V/W/PROMEDIO-o-TEÓRICA/DESVIACIÓN-o-ERROR/ESTADO — usada por TTR
 *  Y Devanados (misma forma de 7 columnas en ambas). ESTADO se deja la
 *  más ancha de las 3 últimas porque ahí caen las palabras más largas
 *  (CUESTIONABLE en Devanados, aunque en la práctica esa tabla solo
 *  muestra APROBADO/RECHAZADO/REGISTRADO). */
var TTR_WINDING_COL_WIDTHS_PT_ = [24, 30, 30, 30, 51, 49, 56];
/** EQUIPO(1 col)/MARCA-MODELO(2 cols fusionadas)/N° SERIE(2 cols)/FECHA
 *  CALIBRACIÓN(2 cols) — MARCA/MODELO se deja la más ancha porque ahí van
 *  los nombres de instrumento más largos ("Micro-ohmmeter DLRO-10"). */
var EQUIPOS_COL_WIDTHS_PT_ = [41, 54, 54, 27, 27, 34, 33];
/** Ronda 8m (2026-09-19) — COMBINACIÓN(1 col, "AT-Tierra"/"BT-Tierra")/
 *  R 1 MIN(1)/DAR(1)/CALIF. DAR(1, "CUESTIONABLE")/IP(1)/CALIF. IP(2 cols
 *  fusionadas). Reusar TTR_WINDING_COL_WIDTHS_PT_ acá (mismo total de
 *  270pt, pero proporciones pensadas para TAP/U/V/W) partía "EXCELENTE"/
 *  "AT-Tierra" en 2 líneas — detectado en la verificación en vivo de esta
 *  ronda. Mismo total, proporciones propias. */
var AISLAMIENTO_COL_WIDTHS_PT_ = [58, 38, 28, 56, 28, 31, 31];
/** Ronda 8m (2026-09-19) — usada por AMBAS tablas de criterios
 *  (Devanados 3-tier y DAR/IP), que se concatenan en una sola tabla
 *  anidada (`criteriaRows`, ver regenerateElectricalCombinedReport_) —
 *  deben compartir un solo arreglo de anchos porque Docs no permite que
 *  distintas filas de LA MISMA tabla tengan columnas de ancho distinto.
 *  Balanceada para que sirva a los 2 patrones de fusión (4+3 columnas en
 *  Devanados, 2+2+1+2 en DAR/IP) sin partir "CUESTIONABLE"/"NO ACEPTABLE"
 *  ni los rangos numéricos. */
var CRITERIA_COL_WIDTHS_PT_ = [38, 38, 38, 38, 42, 40, 36];

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

// buildClientEquipoUnifiedRows_/buildDatosGeneralesUnifiedRows_ (rondas
// 2-4) se borraron en la ronda 7 (2026-09-17) — sin más llamadores desde
// que buildSection1ThreeColRows_ (más abajo) las reemplazó. El informe de
// Aceite sigue con su propio appendClientEquipoGrid_, sin tocar.

/** Anchos de columna (pt) de la Sección 1 de 3 columnas — etiqueta-izq /
 *  valor-izq / FOTO / etiqueta-der / valor-der. Suman ~560pt, el ancho
 *  útil real a 5mm de margen (ver PROTOCOL_MARGIN_PT_). */
var SECTION1_THREE_COL_WIDTHS_PT_ = [80, 160, 90, 75, 155];

/** Sección 1 en 3 columnas reales — Punto 11, ronda 7 (2026-09-17), JSON
 *  de diseño del cliente: columna izquierda (12 filas, Cliente→Año de
 *  fabricación, una etiqueta/valor por fila, sin emparejar 2 por fila
 *  como antes), columna central (foto de placa del transformador,
 *  `plate_photo_file_id` — la misma que ya sube el técnico al crear/
 *  editar el equipo, ver getTransformerPlatePhotoBlob_, reusada acá en
 *  vez de pedir una foto nueva), columna derecha (6 filas, Fecha de
 *  prueba→Normas). Reemplaza a `buildClientEquipoUnifiedRows_` +
 *  `buildDatosGeneralesUnifiedRows_` (borradas, sin más llamadores — el
 *  informe de Aceite usa su propio `appendClientEquipoGrid_`, sin tocar,
 *  este rediseño solo lo pidió el cliente para el Eléctrico). La celda de
 *  la foto se llena aparte, vía el
 *  `afterBuild` de `outerNestedFullRow_` (mismo mecanismo que la firma del
 *  ingeniero en `buildFirmasUnifiedRows_`) — esta función solo arma el
 *  texto y la fusión vertical de esa celda. */
function buildSection1ThreeColRows_(site, transformer, fechaText, tecnicoText, tempText, humedadText, estadoEquipoText, normasText) {
  // Ronda 8i (2026-09-19) — a pedido explícito del usuario: la derecha
  // solo tenía 6 datos contra 12 de la izquierda, así que la mitad de las
  // filas de esta sección quedaban con la mitad derecha completamente en
  // blanco (espacio desperdiciado real, visible en el PDF). Se mueven acá
  // los 3 últimos campos de placa (antes al final de `left`) para
  // equilibrar ambas columnas en 9 filas cada una — la sección pasa de 12
  // a 9 filas (–25 %), sin perder ningún dato.
  var left = [
    ['CLIENTE', site.client_name || '—'],
    ['NIT', site.nit || '—'],
    ['CIUDAD', site.ciudad || '—'],
    ['PROYECTO', site.project_name || '—'],
    ['FABRICANTE', transformer.manufacturer || '—'],
    ['N° DE SERIE', transformer.serial_number || '—'],
    ['GRUPO DE CONEXIÓN', transformer.vector_group || '—'],
    ['POTENCIA NOMINAL', transformer.rated_power_kva ? (String(transformer.rated_power_kva) + ' kVA') : '—'],
    ['TENSIÓN PRIMARIA', transformer.hv_nominal_voltage ? (String(transformer.hv_nominal_voltage) + ' V') : '—']
  ];
  var right = [
    ['TENSIÓN SECUNDARIA', transformer.lv_nominal_voltage ? (String(transformer.lv_nominal_voltage) + ' V') : '—'],
    ['REFRIGERACIÓN', transformer.cooling_type || '—'],
    ['AÑO DE FABRICACIÓN', transformer.manufacture_year ? String(transformer.manufacture_year) : '—'],
    ['FECHA DE PRUEBA', fechaText],
    ['TÉCNICO RESPONSABLE', tecnicoText],
    ['TEMPERATURA AMBIENTE', tempText || '—'],
    ['HUMEDAD RELATIVA', humedadText || '—'],
    ['ESTADO DEL EQUIPO', estadoEquipoText],
    ['NORMAS DE REFERENCIA', normasText]
  ];
  var rows = [unifiedRow_(['DATOS DEL CLIENTE Y DEL EQUIPO', '', '', '', ''], 'banner', [{ startColumnIndex: 0, columnSpan: 5 }])];
  for (var i = 0; i < left.length; i++) {
    var r = right[i] || ['', ''];
    var dataRow = unifiedLabelRow_([left[i][0], left[i][1], '', r[0], r[1]], [0, 3], []);
    // r.labelBgOverride se lee por FILA en styleUnifiedCell_ (no por
    // arreglo) — ver ronda 7 más arriba.
    dataRow.labelBgOverride = PDF_COLORS_.LABEL_BG_BLUE;
    rows.push(dataRow);
  }
  rows.colWidths = SECTION1_THREE_COL_WIDTHS_PT_;
  rows.customMerges = [{ rowIndex: 1, startColumnIndex: 2, columnSpan: 1, rowSpan: left.length }];
  return rows;
}

/** "Equipos utilizados" — Punto 11, ronda 3 (2026-09-15): sección nueva,
 *  una fila por instrumento REALMENTE usado (TTR/Micro-óhmetro/
 *  Megóhmetro, solo los tipos de prueba presentes) con Marca/Modelo, N°
 *  de Serie y Fecha de calibración — cruzando el catálogo de
 *  Calibraciones vía `findMatchingCalibracionServer_`, igual fuente que
 *  ya usaba la línea de instrumento de la ronda 2, ahora en su propia
 *  tabla con columnas en vez de texto corrido. `equipos` es un arreglo de
 *  {equipo, marcaModelo, numeroSerie, fechaCalibracion} armado por el
 *  llamador — esta función no decide qué instrumentos están presentes. */
function buildEquiposUtilizadosRows_(equipos) {
  var rows = [unifiedBannerRow_('EQUIPOS UTILIZADOS')];
  var merges = [{ startColumnIndex: 1, columnSpan: 2 }, { startColumnIndex: 3, columnSpan: 2 }, { startColumnIndex: 5, columnSpan: 2 }];
  var header = ['EQUIPO', 'MARCA / MODELO', '', 'N° DE SERIE', '', 'FECHA CALIBRACIÓN', ''];
  rows.push(unifiedRow_(header, 'header', merges));
  equipos.forEach(function (eq) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = eq.equipo; cells[1] = eq.marcaModelo; cells[3] = eq.numeroSerie; cells[5] = eq.fechaCalibracion;
    rows.push(unifiedRow_(cells, 'data', merges));
  });
  rows.colWidths = EQUIPOS_COL_WIDTHS_PT_;
  return rows;
}

/** "Objetivo y alcance" — Punto 11, ronda 3 (2026-09-15): sección nueva,
 *  texto descriptivo fijo (no es un dato del equipo, es la misma
 *  redacción para cualquier informe) pero SÍ lista dinámicamente cuáles
 *  pruebas se hicieron (`presentLabels`, ya calculado por el llamador
 *  para Observaciones desde la ronda 2) — nunca dice "TTR" si TTR no se
 *  hizo en este informe. */
function buildObjetivoAlcanceRows_(presentLabels) {
  var rows = [unifiedBannerRow_('OBJETIVO Y ALCANCE')];
  var fullMerge = [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }];
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = 'Verificar el estado eléctrico del transformador mediante la medición de ' + joinSpanishList_(presentLabels) +
    ', con el fin de evaluar su condición operativa y detectar posibles deterioros en el sistema de aislamiento y en los devanados.';
  rows.push(unifiedRow_(cells, 'data', fullMerge));
  rows.colWidths = TTR_WINDING_COL_WIDTHS_PT_;
  return rows;
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

  rows.colWidths = TTR_WINDING_COL_WIDTHS_PT_;
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
        // 2026-10-01: cascada de 3 niveles — RECHAZADO siempre gana; si no
        // hay ninguno, OBSERVADO gana sobre APROBADO (antes solo miraba
        // RECHAZADO, dejando un TAP con fase OBSERVADO mostrado como
        // APROBADO liso, sin la nota de la norma visible en el estado).
        if (p.status === 'RECHAZADO') worstStatus = 'RECHAZADO';
        else if (p.status === 'OBSERVADO' && worstStatus !== 'RECHAZADO') worstStatus = 'OBSERVADO';
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

  rows.colWidths = TTR_WINDING_COL_WIDTHS_PT_;
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
  // Punto 11, ronda 5 (2026-09-16) — misma corrección quirúrgica que
  // Sección 8 (banner/encabezado más chicos, padding 0.5pt), esta vez
  // sobre Aislamiento/DAR-IP: con la Sección 8 ya resuelta, esta pasó a
  // ser la siguiente que no entraba NI UNA FILA en la página 1. Nada
  // antes de la Sección 8 se tocó otra vez.
  rows[0].fontSizeOverride = 8;

  if (esSimple) {
    var simpleMerges = [{ startColumnIndex: 0, columnSpan: 2 }, { startColumnIndex: 2, columnSpan: 5 }];
    var simpleHeaderRow = unifiedRow_(['COMBINACIÓN', '', 'RESISTENCIA', '', '', '', ''], 'header', simpleMerges);
    simpleHeaderRow.fontSizeOverride = 6.5;
    rows.push(simpleHeaderRow);
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
    var completoHeaderRow = unifiedRow_(['COMBINACIÓN', 'R 1 MIN', 'DAR', 'CALIF. DAR', 'IP', 'CALIF. IP', ''], 'header', completoMerges);
    completoHeaderRow.fontSizeOverride = 6.5;
    rows.push(completoHeaderRow);
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

  rows.cellPadding = 0.5;
  rows.colWidths = AISLAMIENTO_COL_WIDTHS_PT_;
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
  // Punto 11, ronda 5 (2026-09-16): banner 8pt + padding 0.5pt, misma
  // corrección quirúrgica que Sección 8/Aislamiento — ver
  // buildInsulationUnifiedRows_.
  rows[0].fontSizeOverride = 8;
  // 2026-09-15: las celdas de calificación (col2/col6) eran de 1 sola
  // columna física — "CUESTIONABLE" (12 letras) se partía en 2 líneas ahí
  // aun a 6pt (detectado en la verificación en vivo de la ronda 3). Se
  // ensanchan a 2 columnas cada una, quitándole 1 a cada rango de
  // referencia (los valores del rango, tipo "1.0 – 2.0", son más cortos y
  // caben igual en 1 columna).
  var merges = [{ startColumnIndex: 0, columnSpan: 2 }, { startColumnIndex: 2, columnSpan: 2 }, { startColumnIndex: 5, columnSpan: 2 }];
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
    cells[5] = t.label;
    var row = unifiedRow_(cells, 'legend', merges);
    row.coloredCols = [{ col: 2, bg: t.bg, fg: t.fg }, { col: 5, bg: t.bg, fg: t.fg }];
    rows.push(row);
  });
  rows.cellPadding = 0.5;
  rows.colWidths = CRITERIA_COL_WIDTHS_PT_;
  return rows;
}

/** Punto 11 (2026-09-14) — panel de criterios de TTR, para el lado derecho
 *  del layout de 2 columnas (resultados | criterios). El umbral real que
 *  decide RECHAZADO ya vive en calculateTtr_/lo que llegue en
 *  `calc.taps[].phases[].status` — esto solo IMPRIME esa referencia, no
 *  inventa una nueva. */
/** Tabla de criterios de Devanados — Punto 11, ronda 2 (2026-09-14): la
 *  referencia real que compartió el cliente la muestra como SECCIÓN PROPIA
 *  a todo lo ancho (no al lado de AT/BT). Hasta el 2026-09-30 esta tabla
 *  mostraba una escala de 3 niveles (≤1 %/1-3 %/>3 %) que era SOLO
 *  referencia visual — el umbral real que decidía APROBADO/RECHAZADO era
 *  un único corte de 5 % en `computePhaseUnbalance_`, deliberadamente
 *  distinto de lo impreso aquí (decisión 2026-09-13: "esa escala solo se
 *  imprime como tabla de referencia visual, no reemplaza el cálculo").
 *  2026-10-01: `computePhaseUnbalance_` pasó a un veredicto real de 3
 *  niveles (≤2 % APROBADO / 2-5 % OBSERVADO / >5 % RECHAZADO — ver
 *  UNBALANCE_OBSERVE_THRESHOLD_PERCENT/UNBALANCE_THRESHOLD_PERCENT). Esta
 *  tabla YA NO es solo decorativa: ahora sí debe coincidir exactamente con
 *  el cálculo real, así que se actualiza a los mismos 2 %/5 % — bug real
 *  reportado por el usuario el 2026-10-01 (la tabla impresa seguía en
 *  1 %/3 %, sin relación con el veredicto que de verdad se mostraba). */
function buildWindingCriteriaTable3Tier_() {
  var rows = [unifiedBannerRow_('CRITERIOS DE EVALUACIÓN — RESISTENCIA DE DEVANADOS')];
  // Punto 11, ronda 5 (2026-09-16) — corrección QUIRÚRGICA a pedido
  // explícito del cliente: esta era, casi sola, la única tabla que
  // empujaba el informe a una 2ª página (el resto de la Sección 8 ya
  // cabía en la página 1 — solo faltaban unos pocos puntos de alto para
  // sus 3 filas de datos). En vez de bajar la tipografía/padding
  // globales (que el cliente pidió explícitamente NO tocar otra vez),
  // esta tabla puntual usa `fontSizeOverride`/`cellPadding` — banner 8pt,
  // encabezado y filas 6.5pt, padding 0.5pt (todo dentro de los rangos
  // que el propio cliente definió para esta corrección puntual) — el
  // resto del documento sigue exactamente igual que en la ronda 4.
  rows[0].fontSizeOverride = 8;
  var merges = [{ startColumnIndex: 0, columnSpan: 4 }, { startColumnIndex: 4, columnSpan: 3 }];
  var header = new Array(UNIFIED_TABLE_COLS_).fill('');
  header[0] = 'DESVIACIÓN ENTRE FASES'; header[4] = 'ESTADO';
  var headerRow = unifiedRow_(header, 'header', merges);
  headerRow.fontSizeOverride = 6.5;
  rows.push(headerRow);
  var tiers = [
    { range: '≤ 2 %', label: 'ACEPTABLE', bg: PDF_COLORS_.SUCCESS_BG, fg: PDF_COLORS_.SUCCESS },
    { range: '> 2 % y ≤ 5 %', label: 'CUESTIONABLE', bg: PDF_COLORS_.WARNING_BG, fg: PDF_COLORS_.WARNING },
    { range: '> 5 %', label: 'NO ACEPTABLE', bg: PDF_COLORS_.DANGER_BG, fg: PDF_COLORS_.DANGER }
  ];
  tiers.forEach(function (t) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = t.range; cells[4] = t.label;
    var row = unifiedRow_(cells, 'legend', merges);
    row.coloredCols = [{ col: 4, bg: t.bg, fg: t.fg }];
    row.fontSizeOverride = 6;
    rows.push(row);
  });
  rows.cellPadding = 0.5;
  rows.colWidths = CRITERIA_COL_WIDTHS_PT_;
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
  rows.colWidths = CRITERIA_COL_WIDTHS_PT_;
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
/** `conclusionVerdict` es el string real ('APROBADO'/'OBSERVADO'/'RECHAZADO'),
 *  no un booleano — 2026-10-01, para poder redactar la 3ra frase de
 *  OBSERVADO (antes solo había aprobado/no aprobado). */
function buildObservacionesRows_(presentLabels, estadoEquipoText, normasText, conclusionVerdict) {
  var rows = [unifiedBannerRow_('OBSERVACIONES')];
  var fullMerge = [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }];
  var rechazado = String(conclusionVerdict || '').indexOf('RECHAZADO') === 0;
  var observado = String(conclusionVerdict || '').indexOf('OBSERVADO') === 0;
  var resultSentence;
  if (rechazado) {
    resultSentence = 'Los resultados obtenidos presentan valores fuera de los rangos aceptables — se recomienda una revisión adicional del equipo.';
  } else if (observado) {
    resultSentence = 'Los resultados obtenidos se aprueban con observación: el desbalance de resistencia de devanados superó el 2 % ideal de la norma (IEEE C57.125 / IEC 60076-1), pero se mantiene dentro del margen operativo de campo (5 %) para devanados de aluminio — se recomienda revisar en el próximo mantenimiento.';
  } else {
    resultSentence = 'Los resultados obtenidos se encuentran dentro de los rangos aceptables y presentan buen comportamiento.';
  }
  var sentence = 'Las pruebas de ' + joinSpanishList_(presentLabels) +
    ' se realizaron con el equipo ' + String(estadoEquipoText || '').toLowerCase() +
    ', de acuerdo con las normas ' + normasText + '. ' + resultSentence;
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = sentence;
  rows.push(unifiedRow_(cells, 'data', fullMerge));
  rows.colWidths = TTR_WINDING_COL_WIDTHS_PT_;
  return rows;
}

/** Conclusión General con checkbox — Punto 11, checklist ítem 5.
 *  `overallVerdict` ya viene combinado (ver regenerateElectricalCombinedReport_:
 *  APROBADO solo si TODAS las secciones presentes lo están) — esto no
 *  recalcula nada, solo decide qué casilla marcar. */
/** Punto 11, ronda 7b (2026-09-17) — a pedido del cliente ("elimina las
 *  opciones tipo checkbox... renderiza un único resultado centrado"):
 *  antes mostraba las 2 opciones lado a lado (APROBADO/NO APROBADO, la
 *  que no aplica en gris tachado visualmente con un ☐) — ahora es UNA
 *  sola celda, todo el ancho, con SOLO el resultado real, centrada. El
 *  backend (acá) ya calculaba el resultado final antes de esto — el
 *  cambio es puramente de presentación, ningún dato nuevo. */
function buildConclusionRows_(overallVerdict) {
  // 2026-10-01: 3er nivel OBSERVADO (desbalance de devanados 2-5%, ver
  // UNBALANCE_OBSERVE_THRESHOLD_PERCENT) — antes esto era binario
  // (APROBADO/NO APROBADO) y un OBSERVADO cualquiera caía en "NO APROBADO"
  // en rojo, que es engañoso: el equipo SÍ se aprueba, solo con una
  // observación de la norma, no se rechaza.
  var v = String(overallVerdict || '');
  var rechazado = v.indexOf('RECHAZADO') === 0;
  var observado = v.indexOf('OBSERVADO') === 0;
  var rows = [unifiedBannerRow_('CONCLUSIÓN GENERAL')];
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = rechazado ? '✗ EQUIPO NO APROBADO' : (observado ? '✓ EQUIPO APROBADO — CON OBSERVACIÓN' : '✓ EQUIPO APROBADO');
  var row = unifiedRow_(cells, 'legend', [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }]);
  row.coloredCols = [{ col: 0,
    bg: rechazado ? PDF_COLORS_.DANGER_BG : (observado ? PDF_COLORS_.WARNING_BG : PDF_COLORS_.SUCCESS_BG),
    fg: rechazado ? PDF_COLORS_.DANGER : (observado ? PDF_COLORS_.WARNING : PDF_COLORS_.SUCCESS) }];
  // Resultado final del informe — más grande que el resto de la letra de
  // datos (6pt) para que destaque, sin llegar al tamaño "14px" literal
  // del JSON (rompería la escala compacta de todo el documento).
  row.fontSizeOverride = 9;
  rows.push(row);
  rows.colWidths = TTR_WINDING_COL_WIDTHS_PT_;
  return rows;
}

/** "Área de Control de Calidad" (firmas) — Punto 11, ronda 6k (2026-09-16):
 *  antes vivía HORNEADA en la plantilla (appendSignatureSection_, 2 tablas
 *  de nivel superior aparte, fuera de la tabla unificada) — con el resto
 *  del documento (1-11) ya comprimido a "0 espacio entre filas", esas 2
 *  tablas sueltas eran lo único que seguía sin caber en la página 1
 *  (confirmado con un informe real: comprimirlas a su piso de
 *  padding/fuente no movió el corte de página ni un punto, señal de que el
 *  problema era el hueco ENTRE tablas de nivel superior, no su tamaño).
 *  Se arma ahora como una fila más de la tabla unificada (mismo mecanismo
 *  que Observaciones/Conclusión), eliminando ese hueco. La imagen de la
 *  firma se inserta aparte (ver el `afterBuild` que le pasa el llamador a
 *  `outerNestedFullRow_`), porque `appendNestedTable_`/`styleUnifiedCell_`
 *  solo saben estilizar texto. */
/** Anchos de columna (pt) de la Sección 12 — Probado/Revisado/Aprobado a
 *  110pt (alcanza de sobra para nombre+fecha) y Autenticidad partida en 2
 *  columnas FÍSICAS de la MISMA tabla (126pt imagen + 100pt texto) — ronda
 *  8b/8c (2026-09-19): una sub-tabla anidada DENTRO de la celda
 *  "Autenticidad" reportaba el `appendImage` como exitoso a nivel
 *  DocumentApp (blob válido, ancho/alto correctos, celda con sus hijos)
 *  pero la imagen NUNCA aparecía en el PDF ya exportado — un límite real
 *  de Docs con imágenes anidadas 3 niveles (tabla externa → tabla de
 *  firmas → sub-tabla) que no tiene que ver con partido de página (el bug
 *  de la ronda 6). La fila "AUTENTICIDAD" se fusiona en el header (mismo
 *  mecanismo `merges` de siempre) para que el título quede centrado sobre
 *  las 2 columnas, pero en la fila de DATOS cada una es su propia celda
 *  real de la tabla de firmas — mismo nivel de anidación que el resto del
 *  documento, nada nuevo. Suman lo mismo ~556pt de antes. */
// Ronda 8j (2026-09-19) — sin columna de texto junto al QR, las 4 celdas
// visuales (Probado/Revisado/Aprobado/QR) quedan del mismo ancho — antes
// el bloque QR (126+100=226pt) era visiblemente más ancho que los otros 3
// (110pt cada uno), a pedido del usuario ("no está uniforme").
var SECTION12_FIVE_COL_WIDTHS_PT_ = [141, 141, 142, 71, 71];

/** "Área de Control de Calidad" en 4 bloques — Punto 11, ronda 7
 *  (2026-09-17), JSON de diseño del cliente: pasa de 3 columnas (Probado/
 *  Certificado/Aprobado) a 4 (Probado/Revisado/Aprobado/QR de
 *  Autenticidad) — el bloque de autenticidad usa 2 columnas FÍSICAS
 *  (imagen + texto, ver SECTION12_FIVE_COL_WIDTHS_PT_ más arriba), así
 *  que la tabla real tiene 5 columnas, no 4. El cliente no tiene hoy un
 *  rol "Coordinador" separado del ingeniero (decisión explícita,
 *  2026-09-17): el bloque "REVISADO POR" muestra el MISMO ingeniero que
 *  ya firma "APROBADO POR" (`certificadoPor`), no un firmante nuevo. La
 *  firma (imagen) y el QR se llenan aparte, vía el `afterBuild` de
 *  `outerNestedFullRow_` — esta función solo arma el texto. */
function buildFirmasUnifiedRows_(probadoPor, certificadoPor) {
  var rows = [unifiedRow_(['ÁREA DE CONTROL DE CALIDAD', '', '', '', ''], 'banner', [{ startColumnIndex: 0, columnSpan: 5 }])];
  rows.push(unifiedRow_(
    ['PROBADO POR', 'REVISADO POR', 'APROBADO POR', 'AUTENTICIDAD', ''],
    'header', [{ startColumnIndex: 3, columnSpan: 2 }]
  ));
  // Ronda 8j (2026-09-19) — a pedido explícito del usuario: se quita la
  // columna de texto ("Verificación de autenticidad. Escanee...") al lado
  // del QR, y la celda de datos se fusiona igual que la de encabezado
  // (mismas 2 columnas físicas, ahora una sola celda visual) para que el
  // QR quede centrado y del mismo tamaño de bloque que Probado/Revisado/
  // Aprobado, no descuadrado con una columna angosta de más.
  // Ronda 8o (2026-09-19) — Probado/Revisado pasan a llenarse en
  // afterBuild igual que Firma/QR (antes un solo string "nombre\nfecha"
  // sin poder darle negrita/tamaño distinto solo al nombre).
  var dataRow = unifiedRow_([
    '', // Probado Por — se llena aparte, ver afterBuild
    '', // Revisado Por — se llena aparte, ver afterBuild
    '', // firma del ingeniero — se llena aparte, ver afterBuild
    '', // QR de autenticidad — se llena aparte, ver afterBuild
    ''  // celda fusionada con la anterior — queda vacía
  ], 'data', [{ startColumnIndex: 3, columnSpan: 2 }]);
  rows.push(dataRow);
  rows.colWidths = SECTION12_FIVE_COL_WIDTHS_PT_;
  return rows;
}

/** Gráfica de barras de desviación de TTR por fase (Punto 11, checklist
 *  ítem 3) — servicio `Charts` nativo de Apps Script, sin costo ni servicio
 *  externo (ver aclaración a el cliente en Punto 11 de CLAUDE.md). Nunca
 *  lanza fuera de aquí: si algo falla (0 TAPs, monofásico sin base de
 *  comparación entre fases, etc.) devuelve `null` y el llamador simplemente
 *  no inserta la imagen — no debe bloquear la generación del informe. */
/** Punto 11, ronda 8 (2026-09-17) — a pedido del cliente, pasa de barras
 *  (desviación % por fase) a líneas: la RELACIÓN MEDIDA real
 *  (`measuredRatio`, ya calculada por `calculateTtr_` — nunca se
 *  inventa nada nuevo) por fase (U/V/W) a lo largo de los TAPs. La
 *  desviación % sigue disponible en la tabla de datos (columna ERROR %),
 *  esto es solo el gráfico. */
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
        row.push(p && p.measuredRatio != null ? p.measuredRatio : 0);
      });
      dataTable.addRow(row);
    });
    var chart = Charts.newLineChart()
      .setDataTable(dataTable)
      .setTitle((sectionNum ? sectionNum + '. ' : '') + 'RELACIÓN MEDIDA POR FASE (TTR)')
      .setDimensions(460, 240)
      .setColors([PDF_COLORS_.ACCENT, PDF_COLORS_.DANGER, PDF_COLORS_.SUCCESS])
      .setLegendPosition(Charts.Position.BOTTOM)
      .setPointStyle(Charts.PointStyle.MEDIUM)
      .build();
    return chart.getAs('image/png');
  } catch (e) {
    return null;
  }
}

/** Gráfica de líneas genérica para tendencias año a año — Informe de
 *  Historial (2026-09-29). Mismo servicio Charts y mismo criterio de
 *  nunca-lanzar que buildTtrDeviationChart_ (si algo falla devuelve null,
 *  nunca bloquea el informe). `seriesByLabel` es {etiqueta: {año: valor|
 *  null}} — un año sin dato en una serie se manda como `null` a la
 *  DataTable de Charts, que respeta el hueco (no dibuja un 0 falso, a
 *  diferencia de buildTtrDeviationChart_, que sí lo hace pero ahí "TAP sin
 *  medir dentro de la misma prueba" es un caso distinto a "año sin ninguna
 *  prueba"). Verificado con un PDF real que Charts.newLineChart sí deja el
 *  hueco en vez de interpolar o forzar 0. */
function buildYearlyTrendChart_(title, years, seriesByLabel, colors) {
  var labels = Object.keys(seriesByLabel || {});
  if (labels.length === 0) return null;
  try {
    var dataTable = Charts.newDataTable().addColumn(Charts.ColumnType.STRING, 'Año');
    labels.forEach(function (l) { dataTable.addColumn(Charts.ColumnType.NUMBER, l); });
    years.forEach(function (y) {
      var row = [String(y)];
      labels.forEach(function (l) {
        var v = seriesByLabel[l][y];
        row.push(typeof v === 'number' && !isNaN(v) ? v : null);
      });
      dataTable.addRow(row);
    });
    // Ronda 10 (2026-09-29) — HALLAZGO REAL con PDF real: con 3 series
    // (DAR/IP por combinación, TTR/Devanados por fase) y solo 260px de
    // ancho, Charts pagina la leyenda ("AT-BT ◀ 1/3 ▶") en vez de mostrar
    // las 3 — inútil en una imagen estática, nadie puede hacer clic en
    // "▶". Más ancho de RENDER (no de inserción en el doc, que sigue en
    // 260pt vía widthPt/heightPt en el llamador) le da a Charts espacio
    // real para las 3 entradas sin paginar. 420px alcanzó para DAR/IP y
    // Devanados, pero TTR (etiquetas más largas: "H1H2-X1X2") seguía
    // paginando 2/2 con ese ancho — verificado con un 2do PDF real, subido
    // a 520px hasta que las 3 entradas de TTR también entraron completas.
    var chart = Charts.newLineChart()
      .setDataTable(dataTable)
      .setTitle(title)
      .setDimensions(520, 230)
      .setColors(colors)
      .setLegendPosition(labels.length > 1 ? Charts.Position.BOTTOM : Charts.Position.NONE)
      .setPointStyle(Charts.PointStyle.MEDIUM)
      .build();
    return chart.getAs('image/png');
  } catch (e) {
    return null;
  }
}

/** Gráfica de curva de aislamiento (Punto 11, ronda 3, 2026-09-15 — a
 *  pedido del "prompt maestro" del cliente): NO es una curva continua —
 *  la app solo captura 3 lecturas por combinación (30 s / 60 s / 10 min,
 *  ver `calculateInsulation_`), nunca puntos intermedios (15 s, 45 s,
 *  2 min, 3 min...). Decisión explícita del cliente (2026-09-15): mostrar
 *  esos 3 puntos reales conectados, no inventar una curva suave con datos
 *  que no existen — ver regla 29 del prompt maestro ("no inventar
 *  mediciones"). Usa `raw` (raw_readings_json), NO `calc`
 *  (calculated_results_json) — `calculateInsulation_` guarda `dar`/`ip`/
 *  `r60sMegaohm` en el resultado, pero NUNCA r30sMegaohm/r10minMegaohm
 *  (se usan para calcular DAR/IP y se descartan) — esos 2 solo siguen
 *  existiendo en las lecturas crudas. Solo aplica a método Completo
 *  (Simple no tiene 3 tiempos, una sola lectura). */
function buildInsulationCurveChart_(calc, raw, sectionNum) {
  if (!raw || calc.metodo === 'simple') return null;
  var keys = Object.keys(raw.measurements || {});
  if (keys.length === 0) return null;
  try {
    var dataTable = Charts.newDataTable().addColumn(Charts.ColumnType.STRING, 'Tiempo');
    keys.forEach(function (k) { dataTable.addColumn(Charts.ColumnType.NUMBER, k); });
    var points = [
      { label: '30 s', field: 'r30sMegaohm' },
      { label: '60 s', field: 'r60sMegaohm' },
      { label: '10 min', field: 'r10minMegaohm' }
    ];
    points.forEach(function (pt) {
      var row = [pt.label];
      keys.forEach(function (k) {
        var m = raw.measurements[k];
        // Punto 11, ronda 8 (2026-09-17): `null` en vez de `0` para una
        // lectura faltante — con escala logarítmica (ver setOption más
        // abajo) un 0 real rompe el eje (log(0) no existe); `null` deja
        // el punto sin graficar en vez de inventar un valor.
        row.push(m && m[pt.field] != null ? m[pt.field] : null);
      });
      dataTable.addRow(row);
    });
    var chart = Charts.newLineChart()
      .setDataTable(dataTable)
      .setTitle((sectionNum ? sectionNum + '. ' : '') + 'CURVA DE AISLAMIENTO (MΩ)')
      .setDimensions(460, 240)
      .setColors([PDF_COLORS_.ACCENT, PDF_COLORS_.DANGER, PDF_COLORS_.SUCCESS])
      .setLegendPosition(Charts.Position.BOTTOM)
      .setPointStyle(Charts.PointStyle.MEDIUM)
      // A pedido del cliente — escala logarítmica en el eje de resistencia
      // (MΩ), que suele crecer en órdenes de magnitud entre 30s y 10min.
      .setOption('vAxis.logScale', true)
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
function cellAlign_(cell, alignment) {
  if (cell.getNumChildren() > 0 && cell.getChild(0).getType() === DocumentApp.ElementType.PARAGRAPH) {
    cell.getChild(0).asParagraph().setAlignment(alignment);
  }
}

function styleUnifiedCell_(cell, r, c, padding) {
  // Punto 11, ronda 5 (2026-09-16) — `r.fontSizeOverride` (opcional, en el
  // objeto de la FILA, no en la tabla) deja compactar una tabla puntual
  // (Sección 8 — ver buildWindingCriteriaTable3Tier_) SIN tocar las
  // constantes globales UNIFIED_FONT_*, que siguen igual para todo lo
  // demás — a pedido explícito del cliente ("corrección quirúrgica",
  // "no reducir globalmente toda la tipografía").
  var fontOverride = r.fontSizeOverride;
  cell.setPaddingTop(padding).setPaddingBottom(padding)
    .setPaddingLeft(padding).setPaddingRight(padding);
  cell.editAsText().setFontFamily(PROTOCOL_FONT_FAMILY_);
  // Punto 11, ronda 6c (2026-09-16) — reducir el padding de 1 a 0.5pt no
  // movió NI UN PUNTO el corte de página (verificado con 2 informes reales
  // generados en vivo, mismo renglón exacto desbordando ambas veces): la
  // causa real es que esta función nunca tocaba el espaciado de PÁRRAFO de
  // la celda (setSpacingBefore/After, setLineSpacing) — cada celda se crea
  // con el interlineado/espaciado "Normal text" de Docs por defecto, que
  // domina la altura de fila muchísimo más que el padding. Se normaliza acá,
  // una sola vez para las ~40+ filas de toda la tabla unificada (outer +
  // anidadas, ambas pasan por esta función).
  for (var pi = 0; pi < cell.getNumChildren(); pi++) {
    var pchild = cell.getChild(pi);
    if (pchild.getType() === DocumentApp.ElementType.PARAGRAPH) {
      pchild.asParagraph().setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
    }
  }
  if (r.role === 'banner') {
    cell.setBackgroundColor(PDF_COLORS_.ACCENT);
    cell.editAsText().setBold(true).setFontSize(fontOverride || UNIFIED_FONT_BANNER_).setForegroundColor('#ffffff');
  } else if (r.role === 'header') {
    cell.setBackgroundColor(PDF_COLORS_.ACCENT);
    cell.editAsText().setBold(true).setFontSize(fontOverride || UNIFIED_FONT_HEADER_).setForegroundColor('#ffffff');
    cellAlign_(cell, DocumentApp.HorizontalAlignment.CENTER);
  } else if (r.role === 'verdict') {
    var vcolors = verdictColor_(r.verdictValue);
    cell.setBackgroundColor(vcolors.bg);
    cell.editAsText().setBold(true).setFontSize(UNIFIED_FONT_VERDICT_).setForegroundColor(vcolors.text);
  } else if (r.role === 'labelvalue') {
    var isLabel = r.labelCols.indexOf(c) !== -1;
    if (isLabel) {
      // Punto 11, ronda 7 (2026-09-17) — `r.labelBgOverride` (opcional,
      // mismo criterio que `fontSizeOverride`) permite un color de fondo
      // de etiqueta distinto para UNA tabla puntual (Sección 1 de 3
      // columnas, ver buildSection1ThreeColRows_ — el cliente pidió
      // celdas de etiqueta en azul claro ahí) sin cambiar NEUTRAL_BG para
      // el resto de tablas etiqueta/valor del documento.
      cell.setBackgroundColor(r.labelBgOverride || PDF_COLORS_.NEUTRAL_BG);
      cell.editAsText().setBold(true).setFontSize(UNIFIED_FONT_DATA_).setForegroundColor(PDF_COLORS_.TEXT);
    } else {
      cell.editAsText().setBold(false).setFontSize(UNIFIED_FONT_DATA_).setForegroundColor(PDF_COLORS_.TEXT);
    }
  } else if (r.role === 'legend') {
    var colorSpec = (r.coloredCols || []).filter(function (cc) { return cc.col === c; })[0];
    if (colorSpec) {
      cell.setBackgroundColor(colorSpec.bg);
      cell.editAsText().setBold(true).setFontSize(fontOverride || UNIFIED_FONT_DATA_).setForegroundColor(colorSpec.fg);
      cellAlign_(cell, DocumentApp.HorizontalAlignment.CENTER);
    } else {
      cell.editAsText().setBold(false).setFontSize(fontOverride || UNIFIED_FONT_DATA_).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
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
      cellAlign_(cell, DocumentApp.HorizontalAlignment.CENTER);
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
  // Ronda 9 (2026-09-26) — 'NO CUMPLE' se revisa ANTES que 'CUMPLE' (mismo
  // motivo que 'NO ACEPTABLE' antes que 'ACEPTABLE': contiene la palabra
  // como substring) — terminología del protocolo de Aceite (ENSAYO/ESTADO),
  // nunca usada por Eléctrico.
  if (v.indexOf('RECHAZADO') === 0 || v.indexOf('MALO') === 0 || v === 'NO ACEPTABLE' || v.indexOf('NO CUMPLE') === 0) {
    return { bg: PDF_COLORS_.DANGER_BG, fg: PDF_COLORS_.DANGER };
  }
  if (v.indexOf('CUESTIONABLE') === 0 || v.indexOf('OBSERVADO') === 0) {
    return { bg: PDF_COLORS_.WARNING_BG, fg: PDF_COLORS_.WARNING };
  }
  if (v.indexOf('APROBADO') === 0 || v.indexOf('BUENO') === 0 || v.indexOf('EXCELENTE') === 0 || v === 'ACEPTABLE' || v.indexOf('CUMPLE') === 0) {
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
  // Punto 11, ronda 6l (2026-09-16) — HALLAZGO REAL, confirmado con
  // captura de un informe real (Drive viewer): quedaban huecos visibles
  // de verdad entre cada sección de la tabla unificada (~15-30pt cada
  // uno), pese a que ronda 6c/6d ya habían normalizado el espaciado de
  // párrafo DENTRO de cada celda. Causa: `insertOuterResultsTable_` crea
  // la tabla externa con `body.insertTable(idx, initialCells)`, donde
  // cada celda 'nested-full'/'nested-pair' arranca con texto '' (relleno,
  // ver `initialCells`) — eso deja un párrafo vacío YA EXISTENTE en la
  // celda ANTES de `parentCell.appendTable()`, con el interlineado/
  // espaciado "Normal text" de Docs por defecto SIN normalizar (nunca
  // pasa por styleUnifiedCell_, que solo estiliza celdas de la tabla
  // ANIDADA). Se quita ese párrafo sobrante acá, en el único lugar por el
  // que pasan TODAS las tablas anidadas (externas Y anidadas-dentro-de-
  // anidadas), en vez de en cada llamador.
  if (parentCell.getNumChildren() > 1) {
    var leftoverPar = parentCell.getChild(0);
    if (leftoverPar.getType() === DocumentApp.ElementType.PARAGRAPH && leftoverPar.asParagraph().getText() === '') {
      parentCell.removeChild(leftoverPar);
    }
  }
  // Punto 11, ronda 5 (2026-09-16) — `rows.cellPadding` (opcional, en el
  // arreglo devuelto por el build*_, no una constante global) permite
  // compactar el padding de UNA tabla puntual sin bajarle el padding a
  // todo el documento — mismo criterio que `rows.colWidths`/
  // `r.fontSizeOverride`, para la corrección quirúrgica de la Sección 8
  // que pidió el cliente.
  var cellPadding = rows.cellPadding != null ? rows.cellPadding : UNIFIED_CELL_PADDING_;
  var mergeSpecs = [];
  rows.forEach(function (r, rowIndex) {
    var tr = nestedTable.appendTableRow();
    r.cells.forEach(function (text) { tr.appendTableCell(text); });
    for (var c = 0; c < r.cells.length; c++) {
      styleUnifiedCell_(tr.getCell(c), r, c, cellPadding);
    }
    r.merges.forEach(function (m) {
      mergeSpecs.push({ rowIndex: rowIndex, startColumnIndex: m.startColumnIndex, columnSpan: m.columnSpan });
    });
  });
  // Punto 11, ronda 7 (2026-09-17) — `rows.customMerges` (opcional, mismo
  // criterio que `colWidths`/`cellPadding`): fusiones que no pertenecen a
  // una fila lógica puntual (r.merges es horizontal, dentro de UNA fila) —
  // la celda de la foto del transformador en `buildSection1ThreeColRows_`
  // necesita fusionarse VERTICALMENTE a lo largo de varias filas.
  if (rows.customMerges) {
    rows.customMerges.forEach(function (m) { mergeSpecs.push(m); });
  }
  // Punto 11, ronda 4 (2026-09-16) — anchos de columna explícitos, a pedido
  // del cliente: sin esto, DocumentApp reparte las 7 columnas en partes
  // IGUALES dentro de la tabla anidada, así que en tablas con columnas de
  // ancho muy distinto (TAP angosto vs ESTADO/PROMEDIO/DESVIACIÓN % que
  // necesitan más espacio) las palabras largas se parten ("PROMEDI/O",
  // "APROBAD/O"). `rows.colWidths` (opcional, 7 números en puntos que
  // suman al ancho real disponible) lo arma el `build*Rows_` que conoce el
  // significado de cada columna — ver TTR_WINDING_COL_WIDTHS_PT_/
  // EQUIPOS_COL_WIDTHS_PT_.
  if (rows.colWidths) {
    for (var wc = 0; wc < rows.colWidths.length; wc++) {
      nestedTable.setColumnWidth(wc, rows.colWidths[wc]);
    }
  }
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
 *  adentro (client/equipo, datos generales, Observaciones, Conclusión).
 *  `afterBuild` (opcional, ronda 6k) — callback(nestedTable) que
 *  insertOuterResultsTable_ llama justo después de crear la tabla anidada,
 *  con la tabla YA CREADA (antes de fusionar celdas) — permite insertar
 *  contenido que appendNestedTable_ no sabe armar solo (una imagen en una
 *  celda puntual, ver buildFirmasUnifiedRows_/la firma del ingeniero en
 *  "Área de Control de Calidad"). */
function outerNestedFullRow_(nestedRows, afterBuild) {
  return { kind: 'nested-full', nestedRows: nestedRows, afterBuild: afterBuild };
}
/** Fila externa "resultados | criterios" — 2 tablas anidadas lado a lado,
 *  SIN fusionar (esta es la fila que de verdad necesita las 2 columnas). */
function outerNestedPairRow_(leftRows, rightRows) {
  return { kind: 'nested-pair', leftRows: leftRows, rightRows: rightRows };
}
/** Fila externa "imágenes | criterios" — Punto 11, ronda 6 (2026-09-16):
 *  bug real encontrado en la verificación en vivo de esta ronda — 2
 *  imágenes apiladas DENTRO de una tabla anidada (`unifiedImageRow_`)
 *  quedan mal si esa tabla anidada necesita partirse entre páginas
 *  (Google Docs las dibuja fuera de su celda, montadas sobre el
 *  encabezado de la página siguiente). Insertar las imágenes DIRECTO en
 *  la celda de la tabla EXTERNA (nivel superior, nunca anidada) — mismo
 *  mecanismo que ya usaban `outerImageFullRow_`/`outerPairTableImageRow_`
 *  en rondas anteriores, que nunca mostraron este bug — lo evita. El
 *  banner ("N. GRÁFICOS DE RESULTADOS") va como el texto inicial de esa
 *  misma celda, estilizado como banner; las imágenes se agregan después,
 *  apiladas debajo, en la misma celda. `images` es un arreglo de
 *  {blob, widthPt, heightPt}. */
function outerImagesPairRow_(bannerText, images, rightRows) {
  return { kind: 'images-pair', bannerText: bannerText, images: images, rightRows: rightRows };
}
/** Inserta la tabla EXTERNA de 2 columnas en `body`, justo ANTES de
 *  `beforeChild` (el marcador `<<TABLA_RESULTADOS_ELECTRICOS>>` de la
 *  plantilla — sin cambios en la plantilla misma, ver Punto 11 en
 *  CLAUDE.md: el marcador ya soportaba insertar cualquier contenido ahí).
 *  `outerRows` es un arreglo de descriptores outerNestedFullRow_/
 *  outerNestedPairRow_ (ronda 6, 2026-09-16: `outerPairTableImageRow_`/
 *  `outerImageFullRow_` se borraron — las imágenes ahora van DENTRO de
 *  una tabla anidada normal, ver `unifiedImageRow_`, no como fila externa
 *  propia). Devuelve, además de la tabla externa, un `nestedRegistry`
 *  (una entrada por tabla anidada creada, con su `bannerText` único y sus
 *  propias `mergeSpecs`) para que finalizeReportPdf_ se lo pase a
 *  applyOuterAndNestedMerges_. */
function insertOuterResultsTable_(body, beforeChild, outerRows) {
  if (outerRows.length === 0) return { table: null, outerMergeSpecs: [], nestedRegistry: [], outerMarkerText: null };

  var insertIndex = body.getChildIndex(beforeChild);
  var initialCells = outerRows.map(function (r) { return r.kind === 'images-pair' ? [r.bannerText, ''] : ['', '']; });
  var table = body.insertTable(insertIndex, initialCells);
  table.setBorderColor(PDF_COLORS_.BORDER);

  var outerMergeSpecs = [];
  var nestedRegistry = [];

  // Punto 11, ronda 6d (2026-09-16) — la celda de la tabla EXTERNA que
  // ALOJA una tabla anidada nunca tenía su propio padding puesto a 0: solo
  // se zeroeaba la celda "vacía" del par (la que no lleva contenido), nunca
  // la que sí lo lleva. DocumentApp deja ~5pt de padding por defecto en
  // cada lado (mismo valor documentado en UNIFIED_CELL_PADDING_) — eso es
  // ~10pt verticales de sobra POR CADA fila externa (1-7, 9-derecha, 10-11),
  // que se sumaban aparte de lo que ya controla `cellPadding` de la tabla
  // anidada. Confirmado con 2 informes reales: bajar el padding/espaciado
  // de párrafo de las celdas ANIDADAS movió el corte de página de la
  // Sección 9 a la 10 — pero la 10-11-12 seguían sin caber; este es el
  // siguiente desperdicio real, no una nueva suposición ciega.
  function zeroOuterCellPadding_(cell) {
    cell.setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(0).setPaddingRight(0);
  }
  outerRows.forEach(function (r, rowIndex) {
    var row = table.getRow(rowIndex);
    // Punto 11, ronda 6m (2026-09-16) — HALLAZGO REAL (reportado por el
    // cliente con captura: "dos filas en blanco" entre secciones,
    // confirmado también en el Drive viewer de este lado): cada
    // TableRow de la tabla externa se crea vía `body.insertTable(idx,
    // initialCells)`, que le calcula una altura mínima a partir del
    // contenido INICIAL ('' o el texto del banner de images-pair) — esa
    // altura mínima queda pegada a la fila aunque después se rellene con
    // contenido mucho más compacto (tabla anidada ya en su piso de
    // padding/fuente), así que Docs dibuja la fila más alta de lo que su
    // contenido real necesita. `setMinimumHeight(0)` fuerza a la fila a
    // encogerse al alto real de su contenido — ronda 6l (quitar el
    // párrafo vacío sobrante) no alcanzaba porque el problema no era el
    // párrafo en sí, era la altura mínima ya fijada en la FILA.
    row.setMinimumHeight(0);
    if (r.kind === 'nested-full') {
      zeroOuterCellPadding_(row.getCell(0));
      var nested = appendNestedTable_(row.getCell(0), r.nestedRows);
      zeroOuterCellPadding_(row.getCell(1));
      nestedRegistry.push({ bannerText: nested.bannerText, mergeSpecs: nested.mergeSpecs });
      outerMergeSpecs.push({ rowIndex: rowIndex, startColumnIndex: 0, columnSpan: OUTER_TABLE_COLS_ });
      if (r.afterBuild) r.afterBuild(nested.table);
    } else if (r.kind === 'nested-pair') {
      zeroOuterCellPadding_(row.getCell(0));
      zeroOuterCellPadding_(row.getCell(1));
      var left = appendNestedTable_(row.getCell(0), r.leftRows);
      var right = appendNestedTable_(row.getCell(1), r.rightRows);
      nestedRegistry.push({ bannerText: left.bannerText, mergeSpecs: left.mergeSpecs });
      nestedRegistry.push({ bannerText: right.bannerText, mergeSpecs: right.mergeSpecs });
    } else if (r.kind === 'images-pair') {
      var imgLeftCell = row.getCell(0);
      styleUnifiedCell_(imgLeftCell, { role: 'banner' }, 0, UNIFIED_CELL_PADDING_);
      var validImages = (r.images || []).filter(function (im) { return im.blob; });
      // Ronda 8l (2026-09-19) — a pedido explícito del usuario: lado a
      // lado en vez de apiladas (antes dejaban un hueco vertical vacío
      // debajo, con solo 1 gráfico usando el ancho completo). La ronda 6
      // había sacado las imágenes de cualquier tabla anidada porque una
      // fila que necesita partirse entre páginas dibuja las imágenes
      // fuera de su celda, montadas sobre el encabezado de la página
      // siguiente — riesgo real, pero de partido de página, no de
      // anidación (el límite de 3 niveles de la ronda 8d es un problema
      // distinto). Esta tabla 1×2 queda en nivel de anidación 1 (igual
      // que cualquier otra tabla anidada del documento), y solo hace
      // falta 1 fila que nunca necesita partirse mientras el documento
      // siga en 1 página — verificado con un PDF real tras este cambio.
      if (validImages.length > 1) {
        var imgPairTable = imgLeftCell.appendTable();
        imgPairTable.setBorderWidth(0);
        var imgPairRow = imgPairTable.appendTableRow();
        validImages.forEach(function (im) {
          var pairCell = imgPairRow.appendTableCell();
          pairCell.setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(2).setPaddingRight(2);
          var img = pairCell.appendImage(im.blob);
          if (im.widthPt) img.setWidth(im.widthPt);
          if (im.heightPt) img.setHeight(im.heightPt);
          img.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
        });
      } else {
        validImages.forEach(function (im) {
          var img = imgLeftCell.appendImage(im.blob);
          if (im.widthPt) img.setWidth(im.widthPt);
          if (im.heightPt) img.setHeight(im.heightPt);
        });
      }
      if (r.rightRows) {
        zeroOuterCellPadding_(row.getCell(1));
        var rightNested = appendNestedTable_(row.getCell(1), r.rightRows);
        nestedRegistry.push({ bannerText: rightNested.bannerText, mergeSpecs: rightNested.mergeSpecs });
      } else {
        // Sin criterios que emparejar (caso raro: solo TTR presente, sin
        // Devanados ni Aislamiento) — las imágenes ocupan las 2 columnas.
        row.getCell(1).setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(0).setPaddingRight(0);
        outerMergeSpecs.push({ rowIndex: rowIndex, startColumnIndex: 0, columnSpan: OUTER_TABLE_COLS_ });
      }
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
  p.editAsText().setFontSize(6).setItalic(true).setForegroundColor(PDF_COLORS_.TEXT_MUTED);
  // Punto 11, ronda 4 (2026-09-16): spacing before/after a 0, a pedido
  // explícito del cliente ("no utilizar espaciado automático adicional") —
  // antes 2/6pt, un contribuyente real (aunque chico) al desborde a 2
  // páginas.
  p.setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
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
/** Encoge (nunca intenta borrar — Docs los vuelve a insertar, ver ronda
 *  6l/6o) los párrafos vacíos que Google Docs exige antes/después de
 *  CUALQUIER tabla dentro de una celda, a `fontSize(1)` + espaciado 0 —
 *  extraído de `applyOuterAndNestedMerges_` (ronda 8, 2026-09-19) para
 *  reusarlo también en sub-tablas ad-hoc que se arman fuera del pipeline
 *  build*Rows_/appendNestedTable_ (ver el sub-layout QR+texto de
 *  `buildFirmasUnifiedRows_`/afterBuild). */
function shrinkEmptyBookendParagraphs_(cell) {
  for (var pp = 0; pp < cell.getNumChildren(); pp++) {
    var pChild = cell.getChild(pp);
    if (pChild.getType() === DocumentApp.ElementType.PARAGRAPH && pChild.asParagraph().getText() === '') {
      pChild.asParagraph().setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
      pChild.editAsText().setFontSize(1);
    }
  }
}

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

  // Punto 11, ronda 6o (2026-09-16) — HALLAZGO REAL (confirmado con un
  // diagnóstico puntual sobre un informe ya generado, debugInspectGeneratedReportRows_,
  // ya retirado): la causa real de los huecos visibles entre CADA sección
  // de la tabla unificada era doble, y ninguna de las 2 se veía ANTES del
  // merge:
  //   1) `mergeTableCells` resetea la altura mínima de la fila fusionada a
  //      ~11pt, sin importar que ya se hubiera puesto en 0 antes de
  //      fusionar (rondas 6d/6m, sin efecto por esto).
  //   2) TODA celda de la tabla externa que aloja una tabla anidada queda
  //      con [párrafo vacío, tabla, párrafo vacío] — Docs exige un
  //      párrafo antes Y después de cualquier tabla dentro de una celda
  //      (por eso ronda 6l no lograba QUITAR el de antes: Docs lo vuelve a
  //      insertar), y ninguno de los 2 pasa por styleUnifiedCell_ (que
  //      solo estiliza celdas DENTRO de la tabla anidada), así que se
  //      quedan con el tamaño "Normal text" (~11pt) de Docs por defecto.
  //      Esto era lo que de verdad ocupaba el espacio — (1) resultó ser
  //      irrelevante en la práctica, el contenido real ya superaba 11pt.
  // Ambas se corrigen acá, DESPUÉS del merge — es el único momento en que
  // el párrafo final (el de después de la tabla) ya existe de verdad y en
  // que `setMinimumHeight` no vuelve a pisarse.
  if (outerCandidate) {
    // Pequeño margen para que el batchUpdate recién hecho por la API
    // avanzada se propague antes de que DocumentApp reabra el mismo
    // documento (mismo tipo de desfase entre las 2 APIs que ya documentaba
    // pinResultsTableHeaders_ en la dirección contraria).
    Utilities.sleep(1500);
    var docApp = DocumentApp.openById(docId);
    var bodyApp = docApp.getBody();
    for (var oi = 0; oi < bodyApp.getNumChildren(); oi++) {
      var c2 = bodyApp.getChild(oi);
      if (c2.getType() !== DocumentApp.ElementType.TABLE) continue;
      var t2 = c2.asTable();
      if (t2.getRow(0).getCell(0).getText().indexOf(outerMarkerText) === -1) continue;
      for (var ri = 0; ri < t2.getNumRows(); ri++) {
        var rowRi = t2.getRow(ri);
        rowRi.setMinimumHeight(0);
        for (var cc = 0; cc < rowRi.getNumCells(); cc++) {
          var cellRc = rowRi.getCell(cc);
          shrinkEmptyBookendParagraphs_(cellRc);
          // Ronda 8h (2026-09-19) — el hallazgo de ronda 6o ("mergeTableCells
          // resetea minimumHeight a ~11pt") se aplicó siempre solo a las filas
          // de la tabla EXTERNA; las tablas ANIDADAS dentro de cada celda
          // (Sección 1 con el rowSpan de la foto, Sección 12 con el colspan
          // de AUTENTICIDAD) también pasan por mergeTableCells vía
          // nestedRegistry, y sus propias filas nunca volvían a bajarse a 0
          // después de ese merge — mismo bug, un nivel más adentro.
          for (var nc = 0; nc < cellRc.getNumChildren(); nc++) {
            var nestedChild = cellRc.getChild(nc);
            if (nestedChild.getType() !== DocumentApp.ElementType.TABLE) continue;
            var nestedT = nestedChild.asTable();
            for (var nr = 0; nr < nestedT.getNumRows(); nr++) {
              nestedT.getRow(nr).setMinimumHeight(0);
            }
          }
        }
      }
      // Ronda 8e (2026-09-19) — HALLAZGO REAL: la MISMA regla de Docs que
      // obliga un párrafo vacío antes/después de una tabla ANIDADA dentro
      // de una celda (ver shrinkEmptyBookendParagraphs_ arriba) aplica
      // igual a la tabla EXTERNA dentro del BODY del documento — nunca se
      // encogía ese párrafo vacío de después (el de antes lo absorbe el
      // placeholder ya existente en la plantilla). Confirmado con un PDF
      // real: sin este encogido, ese único párrafo a tamaño "Normal text"
      // (~11pt) por defecto era el sobrante exacto que partía a una
      // página 2 con solo el pie de página repetido, incluso ya con el
      // gráfico a 55pt y el margen inferior a 6mm.
      // Ronda 8f (2026-09-19) — HALLAZGO REAL (confirmado con
      // DEBUG_BODY_TAIL sobre un informe real): NO es un solo párrafo
      // vacío después de la tabla externa, son VARIOS consecutivos
      // (3 en el informe de prueba) — Docs los va acumulando cada vez que
      // esta función reabre/gu arda el documento y los vuelve a insertar.
      // La ronda 8e solo encogía el inmediato siguiente (oi+1); los demás
      // se quedaban a tamaño "Normal text" (~11pt) por defecto — de ahí
      // que ni el gráfico a 55pt ni el margen a 6mm alcanzaran a cerrar
      // el desborde. Se recorren TODOS los que sigan a la tabla, no solo
      // el primero.
      for (var afterIdx = oi + 1; afterIdx < bodyApp.getNumChildren(); afterIdx++) {
        var afterEl = bodyApp.getChild(afterIdx);
        if (afterEl.getType() !== DocumentApp.ElementType.PARAGRAPH || afterEl.asParagraph().getText() !== '') break;
        afterEl.asParagraph().setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
        afterEl.editAsText().setFontSize(1);
      }
      break;
    }
    docApp.saveAndClose();
  }
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
        // Punto 11, ronda 7 (2026-09-17) — `spec.rowSpan` opcional (antes
        // siempre 1): la celda de la foto del transformador en la nueva
        // Sección 1 de 3 columnas (`buildSection1ThreeColRows_`) necesita
        // fusionarse VERTICALMENTE a lo largo de varias filas, no solo
        // horizontalmente — mismo mecanismo de `mergeTableCells`, la API
        // ya soportaba rowSpan>1, solo faltaba exponerlo acá.
        rowSpan: spec.rowSpan || 1,
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

/** TODAS las pruebas Certificadas de un transformador (cualquier tipo,
 *  incluye Aceite dieléctrico a propósito — a diferencia de
 *  findLatestElectricalTestsByType_, que sí lo excluye porque ese es solo
 *  para el combinado eléctrico) — fuente de datos del Informe de Historial
 *  (ver generateYearlyHistoryReportPdf_). `raw_readings`/`calculated_results`
 *  se parsean acá mismo (mismo criterio que listTests_ en modo completo) —
 *  esta función nunca se llama en modo "light", el informe de historial
 *  siempre necesita los datos completos. */
function findAllCertifiedTestsByTransformer_(transformerId) {
  var sheet = getSheet_('PRUEBAS');
  var data = sheet.getDataRange().getValues();
  var transformerCol = HEADERS.PRUEBAS.indexOf('transformer_id');
  var result = [];
  for (var r = 1; r < data.length; r++) {
    if (data[r][transformerCol] !== transformerId) continue;
    var obj = rowToObject_(data[r], 'PRUEBAS', r + 1);
    if (normalizeEstadoCertificacion_(obj.estado_certificacion) !== 'Certificada') continue;
    result.push({
      test_type: obj.test_type,
      created_at: obj.created_at,
      raw_readings: safeParseJson_(obj.raw_readings_json),
      calculated_results: safeParseJson_(obj.calculated_results_json)
    });
  }
  return result;
}

/** Agrupa por año calendario de `created_at` — mismo criterio que
 *  renderYearlyBehaviorChart_ en app.js (ver CLAUDE.md), portado acá para
 *  que el Informe de Historial (PDF, servidor) calcule exactamente las
 *  mismas tendencias que ya ve el usuario en pantalla. */
function groupTestsByYear_(tests) {
  var byYear = {};
  tests.forEach(function (t) {
    var year = new Date(t.created_at).getFullYear();
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(t);
  });
  var years = Object.keys(byYear).map(Number).sort(function (a, b) { return a - b; });
  return { byYear: byYear, years: years };
}

function average_(values) {
  return values.reduce(function (a, b) { return a + b; }, 0) / values.length;
}

/** Puerto exacto de computeYearlyInsulationTrend_ (app.js) — mismo
 *  algoritmo, corriendo en el servidor para poder dibujar la gráfica como
 *  imagen embebida en el PDF (Charts.newLineChart no existe en el
 *  navegador). Series por combinación de devanado, NO promediadas entre
 *  sí — ver comentario original en app.js sobre por qué. */
function computeYearlyInsulationTrend_(byYear, years) {
  var combos = ['AT-BT', 'AT-Tierra', 'BT-Tierra'];
  var dar = {}, ip = {};
  combos.forEach(function (c) { dar[c] = {}; ip[c] = {}; });
  var any = false;
  years.forEach(function (y) {
    var darPerCombo = {}, ipPerCombo = {};
    combos.forEach(function (c) { darPerCombo[c] = []; ipPerCombo[c] = []; });
    byYear[y].forEach(function (t) {
      if (t.test_type !== 'AISLAMIENTO') return;
      var calc = t.calculated_results;
      if (!calc || !calc.measurements) return;
      combos.forEach(function (c) {
        var m = calc.measurements[c];
        if (!m) return;
        if (typeof m.dar === 'number' && !isNaN(m.dar)) darPerCombo[c].push(m.dar);
        if (typeof m.ip === 'number' && !isNaN(m.ip)) ipPerCombo[c].push(m.ip);
      });
    });
    combos.forEach(function (c) {
      if (darPerCombo[c].length) { dar[c][y] = average_(darPerCombo[c]); any = true; } else { dar[c][y] = null; }
      if (ipPerCombo[c].length) { ip[c][y] = average_(ipPerCombo[c]); any = true; } else { ip[c][y] = null; }
    });
  });
  return any ? { dar: dar, ip: ip } : null;
}

/** Puerto exacto de computeYearlyOilTrend_ (app.js) — ver ahí para el
 *  porqué de leer raw_readings y no calculated_results. */
function computeYearlyOilTrend_(byYear, years) {
  var rigidezValues = {}, acidezValues = {};
  var any = false;
  years.forEach(function (y) {
    var rigidezPerTest = [], acidezPerTest = [];
    byYear[y].forEach(function (t) {
      if (t.test_type !== 'ACEITE_DIELECTRICO') return;
      var raw = t.raw_readings;
      if (!raw || !raw.fisicoquimico_realizado) return;
      if (typeof raw.rigidez_dielectrica_kv === 'number' && !isNaN(raw.rigidez_dielectrica_kv)) rigidezPerTest.push(raw.rigidez_dielectrica_kv);
      if (typeof raw.numero_acido_mg_koh_g === 'number' && !isNaN(raw.numero_acido_mg_koh_g)) acidezPerTest.push(raw.numero_acido_mg_koh_g);
    });
    if (rigidezPerTest.length) { rigidezValues[y] = average_(rigidezPerTest); any = true; } else { rigidezValues[y] = null; }
    if (acidezPerTest.length) { acidezValues[y] = average_(acidezPerTest); any = true; } else { acidezValues[y] = null; }
  });
  return any ? { rigidez: rigidezValues, acidez: acidezValues } : null;
}

/** Nuevo (no existía en app.js) — tendencia anual de TTR o Resistencia de
 *  Devanados, SOLO en la posición de TAP nominal del equipo (para que la
 *  serie compare siempre el mismo punto de operación a través de los años,
 *  nunca TAPs distintos entre sí). `getTapPhases(calc)` resuelve la
 *  diferencia real de forma entre los dos tipos (TTR: `calc.taps` es un
 *  OBJETO keyed por string de TAP; Devanados: `calc.taps` es un ARREGLO,
 *  hay que buscar por `.tapPosition` — ver calculateTtr_/
 *  calculateWindingResistance_) y devuelve {faseKey: valorNumérico} o
 *  `null` si esa prueba no midió el TAP nominal. Igual que las 2 funciones
 *  de arriba: promedia si hay más de una prueba certificada el mismo año,
 *  un año sin dato queda `null` (hueco real, no un 0 inventado). */
function computeYearlyTapPhaseTrend_(byYear, years, testType, getTapPhases) {
  var result = {};
  var any = false;
  years.forEach(function (y) {
    var perPhase = {};
    byYear[y].forEach(function (t) {
      if (t.test_type !== testType) return;
      var calc = t.calculated_results;
      if (!calc) return;
      var phases = getTapPhases(calc);
      if (!phases) return;
      Object.keys(phases).forEach(function (pk) {
        var v = phases[pk];
        if (typeof v !== 'number' || isNaN(v)) return;
        if (!perPhase[pk]) perPhase[pk] = [];
        perPhase[pk].push(v);
      });
    });
    Object.keys(perPhase).forEach(function (pk) {
      if (!result[pk]) result[pk] = {};
      result[pk][y] = average_(perPhase[pk]);
      any = true;
    });
  });
  return any ? result : null;
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
function getHistoryTemplateFileId_() {
  return PropertiesService.getScriptProperties().getProperty('TEMPLATE_HISTORIAL_FILE_ID');
}

/** Solo LEE los links de las plantillas ya existentes — a diferencia de
 *  `crearPlantillasInformes_` (que las REGENERA desde cero cada vez que
 *  se llama, único punto de la app que hasta ahora exponía el link), esta
 *  acción (2026-09-15) no toca nada. Hacía falta: antes de esto, la única
 *  forma de ver el link de la plantilla eléctrica era regenerarla —
 *  arriesgando perder watermark/encabezado/pie que el cliente agrega a
 *  mano. Nunca lanza — si nunca se generó una plantilla, `data` viene con
 *  `null` en el campo correspondiente. */
function getReportTemplateUrls_(params, auth) {
  var elecId = getElectricalTemplateFileId_();
  var oilId = getOilTemplateFileId_();
  return jsonResponse_({
    status: 200,
    data: {
      electricoUrl: elecId ? 'https://docs.google.com/document/d/' + elecId + '/edit' : null,
      aceiteUrl: oilId ? 'https://docs.google.com/document/d/' + oilId + '/edit' : null
    }
  });
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
  body.setMarginTop(PROTOCOL_MARGIN_PT_).setMarginBottom(PROTOCOL_MARGIN_BOTTOM_PT_)
    .setMarginLeft(PROTOCOL_MARGIN_PT_).setMarginRight(PROTOCOL_MARGIN_PT_);
  body.setPageWidth(PROTOCOL_PAGE_WIDTH_PT_).setPageHeight(PROTOCOL_PAGE_HEIGHT_PT_);

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

  // Punto 11, ronda 6k (2026-09-16): "Área de Control de Calidad" (firmas)
  // ya NO se hornea acá — regenerateElectricalCombinedReport_ la arma
  // dinámicamente como una fila más de la tabla unificada (ver
  // buildFirmasUnifiedRows_), para que no quede como tabla de nivel
  // superior aparte con el hueco que eso agregaba. Si esta plantilla se
  // regenera desde cero, ya no hace falta correr después la acción admin
  // `removeElectricalTemplateBakedSignature`.

  var footer = doc.addFooter();
  var footerPar = footer.appendParagraph('M&A Ingeniería y Consultoría SAS · Informe generado vía Gestión de Pruebas el <<FECHA_GENERACION>>');
  footerPar.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  footerPar.editAsText().setFontSize(7).setForegroundColor(PDF_COLORS_.TEXT_MUTED);

  doc.saveAndClose();
  return doc.getId();
}

/** Acción de Administración, solo Administrador — corre UNA sola vez (o de
 *  nuevo si alguna vez se necesita rehacer la plantilla base). Genera SOLO
 *  la plantilla Eléctrica (la que de verdad se arma "desde cero" con
 *  DocumentApp) — Aceite e Historial ya NO se construyen aparte, se migran
 *  a partir de esta con migrateOilTemplateFromElectrical_/
 *  migrateHistoryTemplateFromElectrical_ (ronda 9/Informe de Historial), así
 *  que corrent esta acción NUNCA debe pisar sus TEMPLATE_ACEITE_FILE_ID/
 *  TEMPLATE_HISTORIAL_FILE_ID — antes de la ronda 10 (2026-09-29) sí lo
 *  hacía (llamaba a la ya borrada buildOilTemplateDoc_), un bug latente real
 *  que habría roto Aceite si esta acción se hubiera vuelto a correr. */
function crearPlantillasInformes_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede generar las plantillas de informes' });
  }
  var elecId = buildElectricalTemplateDoc_();
  var elecFile = DriveApp.getFileById(elecId);
  moveFileToPlantillasFolder_(elecFile);
  shareForEditAnyone_(elecFile);
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_ELECTRICO_FILE_ID', elecId);
  return jsonResponse_({
    status: 200,
    message: 'Plantilla Eléctrica generada — ábrela y agrega el watermark del logo a mano (Insertar imagen → Detrás del texto → transparencia 85-92% → centrada). Después, migra Aceite/Historial desde Administración para que reusen el mismo header/pie/watermark.',
    data: { electricoUrl: elecFile.getUrl() }
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
/**
 * Punto 11, ronda 4 (2026-09-16) — segunda pasada sobre la caja de título
 * (la que armó `restructureElectricalTemplateTitle_` en la ronda 2): la
 * caja de foto vacía ("Foto del equipo") quedó con 70pt de alto fijo —
 * en la verificación en vivo de esta ronda, con casi todo lo demás ya
 * compactado, esa caja vacía era uno de los pocos espacios grandes que
 * sobraban sin usarse. La baja a 26pt (sigue siendo una caja visible,
 * usable para una foto pequeña) y ajusta el interlineado del texto
 * CÓDIGO/VERSIÓN/FECHA/PÁGINA a sencillo (antes usaba el interlineado por
 * defecto de Google Docs, más alto que 1).
 *
 * Ubica la tabla del título por FORMA + CONTENIDO (1 fila, 2 celdas,
 * celda 0 empieza con 'PROTOCOLO DE PRUEBAS ELÉCTRICAS' — ya migrada por
 * restructureElectricalTemplateTitle_, esta función asume esa forma, no
 * la original de 1 celda). Nunca lanza si no la encuentra — plantilla
 * nunca migrada, o título editado a mano.
 */
function compactElectricalTemplateTitleBox_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede modificar la plantilla' });
  }
  var templateId = getElectricalTemplateFileId_();
  if (!templateId) {
    return jsonResponse_({ status: 400, message: 'No existe la plantilla del informe eléctrico.' });
  }
  var doc = DocumentApp.openById(templateId);
  var body = doc.getBody();
  var titleTable = null;
  for (var i = 0; i < body.getNumChildren(); i++) {
    var child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.TABLE) continue;
    var t = child.asTable();
    if (t.getNumRows() === 1 && t.getRow(0).getNumCells() === 2 &&
      t.getRow(0).getCell(0).getText().trim().indexOf('PROTOCOLO DE PRUEBAS ELÉCTRICAS') === 0) {
      titleTable = t;
      break;
    }
  }
  if (!titleTable) {
    return jsonResponse_({ status: 404, message: 'No se encontró la caja de título ya migrada — corre primero "Reestructurar título" desde Administración.' });
  }

  var controlCell = titleTable.getRow(0).getCell(1);
  var photoTable = null;
  for (var j = 0; j < controlCell.getNumChildren(); j++) {
    var cchild = controlCell.getChild(j);
    if (cchild.getType() === DocumentApp.ElementType.TABLE) {
      photoTable = cchild.asTable();
    } else if (cchild.getType() === DocumentApp.ElementType.PARAGRAPH) {
      cchild.asParagraph().setLineSpacing(1).setSpacingBefore(0).setSpacingAfter(0);
    }
  }
  if (photoTable && photoTable.getNumRows() > 0) {
    photoTable.getRow(0).setMinimumHeight(26);
  }

  doc.saveAndClose();
  return jsonResponse_({ status: 200, message: 'Caja de título compactada (foto e interlineado).' });
}

/** Diagnóstico TEMPORAL (2026-09-16) — lista TODOS los hijos del body de la
 *  plantilla (tipo + primeros 80 caracteres de texto), para investigar por
 *  qué la caja de título "PROTOCOLO DE PRUEBAS ELÉCTRICAS" apareció 2 veces
 *  en un informe real (una al inicio, otra a mitad de la página 2, antes
 *  de las firmas) — nunca debería repetirse, es contenido del BODY, no del
 *  header de Docs. BORRAR junto con su entrada en POST_ACTIONS en cuanto
 *  se confirme la causa. */
function debugInspectTemplateBody_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo Administrador' });
  }
  var templateId = getElectricalTemplateFileId_();
  var doc = DocumentApp.openById(templateId);
  var body = doc.getBody();
  var out = [];
  var n = body.getNumChildren();
  for (var i = 0; i < n; i++) {
    var child = body.getChild(i);
    var typeName = child.getType().toString();
    var entry = { index: i, type: typeName };
    if (typeName === 'TABLE') {
      var t = child.asTable();
      entry.numRows = t.getNumRows();
      entry.numCells0 = t.getRow(0).getNumCells();
      entry.text = t.getText().substring(0, 80);
    } else {
      entry.text = (child.getText ? child.getText() : '').substring(0, 80);
    }
    out.push(entry);
  }
  return jsonResponse_({ status: 200, data: { totalChildren: n, children: out } });
}


/**
 * Punto 11, ronda 5 (2026-09-16) — corrige el ORDEN de la plantilla real:
 * el diagnóstico (`debugInspectTemplateBody_`) confirmó que la tabla de
 * título ("PROTOCOLO DE PRUEBAS ELÉCTRICAS...") quedó ubicada DESPUÉS del
 * marcador `<<TABLA_RESULTADOS_ELECTRICOS>>` en vez de antes — por eso el
 * título aparecía al FINAL del informe real (justo antes de las firmas)
 * en vez de al principio: `insertUnifiedResultsTable_`/
 * `insertOuterResultsTable_` siempre insertan la tabla de resultados
 * justo en la posición del marcador, así que cualquier cosa que ya esté
 * DESPUÉS del marcador en la plantilla queda DESPUÉS de los resultados
 * en cada informe generado.
 *
 * No reconstruye el título (perdería la caja de foto/CÓDIGO-VERSIÓN ya
 * migrada) — usa `Table.copy()` + `Body.insertTable(index, table)` para
 * MOVER la tabla existente a la posición correcta, preservando su
 * contenido tal cual. Ubica ambos elementos por CONTENIDO (nunca por
 * índice adivinado, mismo criterio que el resto del proyecto). Nunca
 * lanza si no encuentra alguno de los 2, o si el orden ya es correcto —
 * segura de correr más de una vez.
 */
function fixElectricalTemplateTitleOrder_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede modificar la plantilla' });
  }
  var templateId = getElectricalTemplateFileId_();
  if (!templateId) {
    return jsonResponse_({ status: 400, message: 'No existe la plantilla del informe eléctrico.' });
  }
  var doc = DocumentApp.openById(templateId);
  var body = doc.getBody();
  var titleTable = null, titleIdx = -1;
  var placeholderIdx = -1;
  for (var i = 0; i < body.getNumChildren(); i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.TABLE) {
      var t = child.asTable();
      if (t.getNumRows() === 1 && t.getRow(0).getNumCells() === 2 &&
        t.getRow(0).getCell(0).getText().trim().indexOf('PROTOCOLO DE PRUEBAS ELÉCTRICAS') === 0) {
        titleTable = t; titleIdx = i;
      }
    } else if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      if (child.asParagraph().getText().trim() === '<<TABLA_RESULTADOS_ELECTRICOS>>') {
        placeholderIdx = i;
      }
    }
  }
  if (!titleTable || placeholderIdx === -1) {
    return jsonResponse_({ status: 404, message: 'No se encontraron ambos elementos (título ya migrado + marcador de tabla) — revisa la plantilla a mano.' });
  }
  if (titleIdx < placeholderIdx) {
    return jsonResponse_({ status: 200, message: 'El orden ya es correcto (título antes del marcador) — no se cambió nada.' });
  }

  var titleCopy = titleTable.copy();
  body.removeChild(titleTable);
  // El índice del marcador pudo correrse al borrar el título (si el
  // título estaba ANTES del marcador en la lista de hijos, aunque ya
  // descartamos ese caso arriba) — se recalcula por seguridad.
  var placeholderParAfterRemoval = null;
  for (var j = 0; j < body.getNumChildren(); j++) {
    var c2 = body.getChild(j);
    if (c2.getType() === DocumentApp.ElementType.PARAGRAPH && c2.asParagraph().getText().trim() === '<<TABLA_RESULTADOS_ELECTRICOS>>') {
      placeholderParAfterRemoval = j;
      break;
    }
  }
  body.insertTable(placeholderParAfterRemoval, titleCopy);
  doc.saveAndClose();
  return jsonResponse_({ status: 200, message: 'Orden corregido: la caja de título se movió antes del marcador de la tabla de resultados.' });
}

/** Acción admin de una sola vez (Punto 11, ronda 6k, 2026-09-16) — quita de
 *  la plantilla ELÉCTRICA en vivo (nunca la de Aceite, que sigue usando
 *  appendSignatureSection_ horneada sin cambios) la caja-título "ÁREA DE
 *  CONTROL DE CALIDAD" + la tabla PROBADO POR/CERTIFICADO POR/APROBADO POR
 *  que `appendSignatureSection_` había horneado ahí al crear la plantilla.
 *  Ahora esa sección se arma dinámicamente como una fila más de la tabla
 *  unificada (ver buildFirmasUnifiedRows_ y regenerateElectricalCombinedReport_)
 *  — dejar las 2 tablas viejas en la plantilla habría duplicado la
 *  sección (la vieja con placeholders <<PROBADO_POR_NOMBRE>> sin
 *  reemplazar + la nueva real). Idempotente: si ya no encuentra nada,
 *  informa y no toca nada. */
function removeElectricalTemplateBakedSignature_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede modificar la plantilla' });
  }
  var templateId = getElectricalTemplateFileId_();
  if (!templateId) {
    return jsonResponse_({ status: 400, message: 'No existe la plantilla del informe eléctrico.' });
  }
  var doc = DocumentApp.openById(templateId);
  var body = doc.getBody();
  var titleIdx = -1, sigIdx = -1;
  for (var i = 0; i < body.getNumChildren(); i++) {
    var child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.TABLE) continue;
    var t = child.asTable();
    if (t.getNumRows() === 1 && t.getRow(0).getNumCells() === 1 &&
      t.getRow(0).getCell(0).getText().trim() === 'ÁREA DE CONTROL DE CALIDAD') {
      titleIdx = i;
    } else if (t.getNumRows() === 2 && t.getRow(0).getNumCells() === 3 &&
      t.getRow(0).getCell(0).getText().trim() === 'PROBADO POR') {
      sigIdx = i;
    }
  }
  if (titleIdx === -1 && sigIdx === -1) {
    return jsonResponse_({ status: 200, message: 'Ya no hay firma horneada en la plantilla — no se cambió nada.' });
  }
  // Borrar de mayor a menor índice para no invalidar el índice del otro al
  // eliminar el primero.
  var indices = [titleIdx, sigIdx].filter(function (x) { return x !== -1; }).sort(function (a, b) { return b - a; });
  indices.forEach(function (idx) { body.removeChild(body.getChild(idx)); });
  doc.saveAndClose();
  return jsonResponse_({ status: 200, message: 'Firma horneada (título + tabla PROBADO POR/CERTIFICADO POR/APROBADO POR) eliminada de la plantilla — ahora se genera dinámicamente dentro de la tabla unificada.' });
}

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

/** Tamaño A4 (210 x 297 mm) y márgenes de 8 mm — reemplaza el Oficio
 *  (216 x 330 mm) del mismo día (2026-09-15), a pedido del "prompt
 *  maestro" del cliente: la referencia real tiene densidad alta y
 *  necesita aprovechar casi todo el ancho de la hoja. 1 mm = 2.834645669
 *  pt — 210mm=595.28pt, 297mm=841.89pt. Margen superior/izq/der bajado de
 *  8mm a 6mm (2026-09-16, ronda 4 — "primera configuración a probar" que
 *  pidió el cliente para el intento de 1 sola página; explícitamente NO
 *  0mm). El margen INFERIOR se dejó aparte (`PROTOCOL_MARGIN_BOTTOM_PT_`)
 *  — con el pie de página real que el cliente ya agregó a la plantilla
 *  (imagen + iconos, más alto que el texto simple de antes), 6mm no
 *  alcanzaba: el cuerpo se solapaba con el pie en vez de terminar antes
 *  — se ve en la verificación en vivo de esta ronda (una tabla partida a
 *  la mitad justo donde empieza el pie). El margen inferior de
 *  DocumentApp (dónde termina el CUERPO) es independiente del margen del
 *  PIE mismo (dónde empieza el pie, ver Format → Encabezado y pie de
 *  página en Docs — eso no se puede controlar por API, solo a mano) —
 *  agrandar el margen inferior del cuerpo es la única forma de reservar
 *  espacio real para un pie más alto desde el código. */
var PROTOCOL_PAGE_WIDTH_PT_ = 595.28;
var PROTOCOL_PAGE_HEIGHT_PT_ = 841.89;
// Punto 11, ronda 6i (2026-09-16): 6mm -> 5mm — dentro del rango 5-6mm
// que el propio cliente autorizó como último recurso ("prompt maestro"
// #3: "márgenes 5-6mm no 0mm"). Confirmado que el margen SOLO se aplica
// de verdad al volver a correr la acción admin `setReportTemplatesPageSize`
// contra la plantilla en vivo — cambiar la constante sin eso no tiene
// ningún efecto (así se perdieron las rondas 6f/6g hasta detectarlo).
var PROTOCOL_MARGIN_PT_ = 14.17;
// Ronda 6g: 12mm -> 9mm (ya confirmado con efecto real, único ajuste que sí
// movió el corte de página junto con el espaciado de párrafo). Ronda 6i:
// 9mm -> 7mm, siguiente paso dentro del mismo margen de seguridad frente a
// los 6mm que causaron el overlap original con el pie de página del cliente.
// Ronda 8f (2026-09-19): 7mm -> 6mm, el piso que el cliente autorizó
// (5-6mm, "no 0mm") — confirmado visualmente sin overlap con el pie de
// página real a 7mm; se prueba el último mm antes de tocar contenido de
// nuevo para cerrar el footer duplicado en una página 2 casi vacía.
var PROTOCOL_MARGIN_BOTTOM_PT_ = 17.01;

/** Punto 11 (2026-09-15, a pedido del cliente) — fija tamaño A4 y
 *  márgenes de 8 mm en las 2 plantillas YA EXISTENTES, igual criterio que
 *  restructureElectricalTemplateTitle_: edita los documentos reales con
 *  DocumentApp.openById (nunca una copia, nunca los regenera), así que el
 *  watermark/encabezado/pie/título con foto que ya tienen NO se pierde.
 *  `Body.setPageWidth`/`setPageHeight`/`setMargin*` son los únicos
 *  métodos que existen para esto — no hay un "tamaño con nombre"
 *  (Carta/Oficio/A4/Legal) en la API de DocumentApp, solo puntos.
 *  Cambiar el tamaño/márgenes DESPUÉS de que el cliente ya insertó
 *  imágenes de encabezado/pie puede correrlas de lugar — por eso es una
 *  acción aparte, no algo que se aplique solo. */
function setReportTemplatesPageSize_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede modificar las plantillas' });
  }
  var results = {};
  [['electrico', getElectricalTemplateFileId_()], ['aceite', getOilTemplateFileId_()]].forEach(function (pair) {
    var key = pair[0], fileId = pair[1];
    if (!fileId) { results[key] = 'no existe'; return; }
    var doc = DocumentApp.openById(fileId);
    var body = doc.getBody();
    body.setPageWidth(PROTOCOL_PAGE_WIDTH_PT_).setPageHeight(PROTOCOL_PAGE_HEIGHT_PT_);
    body.setMarginTop(PROTOCOL_MARGIN_PT_).setMarginBottom(PROTOCOL_MARGIN_BOTTOM_PT_)
      .setMarginLeft(PROTOCOL_MARGIN_PT_).setMarginRight(PROTOCOL_MARGIN_PT_);
    doc.saveAndClose();
    results[key] = 'actualizado a A4 (210 x 297 mm), márgenes 5 mm (6 mm abajo, para el pie de página)';
  });
  return jsonResponse_({ status: 200, message: 'Tamaño de página y márgenes actualizados.', data: results });
}

/**
 * Ronda 9 (2026-09-26) — a pedido explícito del usuario ("podemos copiar
 * la plantilla de prueba que tiene ya los encabezados, pie de página y
 * marca de agua y ajustar a este"): en vez de reconstruir el encabezado/
 * pie/watermark del Aceite desde cero (`buildOilTemplateDoc_`, que nunca
 * tuvo watermark agregado a mano), se copia la plantilla ELÉCTRICA ya
 * migrada — la misma que se usó todo el día de hoy, con su caja de
 * título CÓDIGO/VERSIÓN/FECHA/PÁGINA + foto ya restructurada
 * (`restructureElectricalTemplateTitle_`/`compactElectricalTemplateTitleBox_`,
 * rondas 2 y 4) y su watermark agregado a mano — y se ajustan SOLO 2
 * cosas por texto: el título del protocolo y el marcador de la tabla de
 * resultados. Todo lo demás (header/footer/watermark/caja de título)
 * queda intacto, tal como lo dejó el cliente. Idempotente: correrla de
 * nuevo sobre una plantilla ya migrada simplemente no encuentra el texto
 * viejo para reemplazar (ambos `replaceText` son no-ops), nunca falla.
 */
function migrateOilTemplateFromElectrical_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede modificar las plantillas' });
  }
  var elecTemplateId = getElectricalTemplateFileId_();
  if (!elecTemplateId) {
    return jsonResponse_({ status: 400, message: 'No existe la plantilla Eléctrica todavía — genérala primero desde Administración.' });
  }
  var copy = DriveApp.getFileById(elecTemplateId).makeCopy('PLANTILLA_INFORME_ACEITE_' + Date.now());
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();
  body.replaceText('PROTOCOLO DE PRUEBAS ELÉCTRICAS', TEST_TYPE_PROTOCOL_TITLE_.ACEITE_DIELECTRICO);
  body.replaceText('<<TABLA_RESULTADOS_ELECTRICOS>>', '<<TABLA_RESULTADOS_ACEITE>>');
  doc.saveAndClose();
  var file = DriveApp.getFileById(copy.getId());
  moveFileToPlantillasFolder_(file);
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_ACEITE_FILE_ID', copy.getId());
  return jsonResponse_({
    status: 200,
    message: 'Plantilla de Aceite migrada desde la Eléctrica (header/pie/watermark reusados) — la plantilla vieja sigue en Drive, sin borrar, simplemente ya no está en uso.',
    data: { aceiteUrl: file.getUrl() }
  });
}

/** Mismo patrón que migrateOilTemplateFromElectrical_ — Informe de
 *  Historial (2026-09-29): reusa header/pie/watermark del Eléctrico, solo
 *  cambia el título y el marcador de contenido (acá no es una "tabla de
 *  resultados" sino una sección de gráficas de tendencia + datos del
 *  cliente/equipo, ver generateYearlyHistoryReportPdf_). */
function migrateHistoryTemplateFromElectrical_(params, auth) {
  if (auth.role !== 'Administrador') {
    return jsonResponse_({ status: 403, message: 'Solo un Administrador puede modificar las plantillas' });
  }
  var elecTemplateId = getElectricalTemplateFileId_();
  if (!elecTemplateId) {
    return jsonResponse_({ status: 400, message: 'No existe la plantilla Eléctrica todavía — genérala primero desde Administración.' });
  }
  var copy = DriveApp.getFileById(elecTemplateId).makeCopy('PLANTILLA_INFORME_HISTORIAL_' + Date.now());
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();
  body.replaceText('PROTOCOLO DE PRUEBAS ELÉCTRICAS', TEST_TYPE_PROTOCOL_TITLE_.HISTORIAL);
  body.replaceText('<<TABLA_RESULTADOS_ELECTRICOS>>', '<<CONTENIDO_HISTORIAL>>');
  doc.saveAndClose();
  var file = DriveApp.getFileById(copy.getId());
  moveFileToPlantillasFolder_(file);
  PropertiesService.getScriptProperties().setProperty('TEMPLATE_HISTORIAL_FILE_ID', copy.getId());
  return jsonResponse_({
    status: 200,
    message: 'Plantilla de Historial migrada desde la Eléctrica (header/pie/watermark reusados) — la plantilla vieja sigue en Drive, sin borrar, simplemente ya no está en uso.',
    data: { historialUrl: file.getUrl() }
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
  // Punto 11, ronda 3 (2026-09-15): `equipos` reemplaza a `instrumentLines`
  // — ahora es la fuente de la sección "EQUIPOS UTILIZADOS" (tabla propia
  // con columnas Marca/Modelo, N° Serie, Fecha Calibración), no de texto
  // corrido dentro de "Datos de la prueba".
  var equipos = [];
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
    equipos.push({
      equipo: 'TTR', marcaModelo: ttrRow.instrument_used || '—',
      numeroSerie: (ttrCal && ttrCal.numero_serie) || '—',
      fechaCalibracion: (ttrCal && ttrCal.fecha_ultima_calibracion) ? fmtDatePdf_(ttrCal.fecha_ultima_calibracion) : '—'
    });
    pushNormaUnica_(normas, 'IEEE C57.12.90');
    presentLabels.push('relación de transformación (TTR)');
  }

  var wrCalc = null, wrInstrumento = null;
  if (present.indexOf('RESISTENCIA_DEVANADOS') !== -1) {
    var wrRow = latest.RESISTENCIA_DEVANADOS;
    wrCalc = safeParseJson_(wrRow.calculated_results_json);
    var wrCal = findMatchingCalibracionServer_(wrRow.instrument_used);
    wrInstrumento = 'Instrumento: ' + (wrRow.instrument_used || '—') + (wrCal ? ' (' + wrCal.estado + ')' : '');
    equipos.push({
      equipo: 'Micro-óhmetro', marcaModelo: wrRow.instrument_used || '—',
      numeroSerie: (wrCal && wrCal.numero_serie) || '—',
      fechaCalibracion: (wrCal && wrCal.fecha_ultima_calibracion) ? fmtDatePdf_(wrCal.fecha_ultima_calibracion) : '—'
    });
    pushNormaUnica_(normas, 'IEEE C57.12.90');
    presentLabels.push('resistencia de devanados');
  }

  var aisCalc = null, aisRaw = null, aisInstrumento = null, aisTension = null, aisEsSimple = false;
  if (present.indexOf('AISLAMIENTO') !== -1) {
    var aisRow = latest.AISLAMIENTO;
    aisCalc = safeParseJson_(aisRow.calculated_results_json);
    aisRaw = safeParseJson_(aisRow.raw_readings_json);
    var aisCal = findMatchingCalibracionServer_(aisRow.instrument_used);
    aisInstrumento = 'Instrumento: ' + (aisRow.instrument_used || '—') + (aisCal ? ' (' + aisCal.estado + ')' : '');
    aisTension = aisRaw && aisRaw.tension_prueba_v ? (aisRaw.tension_prueba_v + ' V') : null;
    aisEsSimple = aisCalc.metodo === 'simple';
    equipos.push({
      equipo: 'Megóhmetro', marcaModelo: aisRow.instrument_used || '—',
      numeroSerie: (aisCal && aisCal.numero_serie) || '—',
      fechaCalibracion: (aisCal && aisCal.fecha_ultima_calibracion) ? fmtDatePdf_(aisCal.fecha_ultima_calibracion) : '—'
    });
    pushNormaUnica_(normas, 'IEEE C57.152');
    presentLabels.push('resistencia de aislamiento');
  }

  // Punto 11, ronda 2: numeración secuencial de secciones (1, 2, 3...) sin
  // huecos — un informe con solo Aislamiento numera esa sección "3.", no
  // "8." (el número que tendría si TTR/Devanados estuvieran presentes).
  var n = 1;
  // Sección 1 — Cliente/Equipo y Datos de la Prueba, ambos numerados como
  // UNA sola sección "1." (mismo número para los 2 — la referencia real
  // los trata como una sola sección con 2 mitades). Punto 11, ronda 4
  // (2026-09-16): dejaron de ir EMPAREJADAS al 50% (como en la ronda 3) —
  // Cliente/Equipo tiene 12 datos, Datos de la Prueba solo 6, así que
  // emparejadas la fila externa quedaba a la altura de la más alta (12) y
  // el lado corto dejaba la mitad de su columna en blanco, un desperdicio
  // real de espacio vertical detectado en la verificación en vivo de esta
  // ronda. Ahora van una debajo de otra, cada una a ancho completo — y
  // como ninguna necesita ya la mitad de página, ambas volvieron a 2
  // pares etiqueta/valor por fila (ver los comentarios en
  // buildClientEquipoUnifiedRows_/buildDatosGeneralesUnifiedRows_), así
  // que la altura total de la Sección 1 (6+3=9 filas) es MENOR que antes
  // (12+6=18 filas repartidas en 2 columnas, con media columna vacía).
  // Punto 11, ronda 7 (2026-09-17) — JSON de diseño del cliente: Sección 1
  // pasa de 2 tablas etiqueta/valor apiladas a UNA sola tabla de 3
  // columnas reales (cliente/equipo | foto de placa | datos de la prueba),
  // ver buildSection1ThreeColRows_. La foto (si el equipo tiene una
  // `plate_photo_file_id` subida) se inserta aparte, vía `afterBuild`,
  // sobre la celda ya fusionada verticalmente.
  var section1Rows = numberSection_(buildSection1ThreeColRows_(
    site, transformer, fmtDatePdf_(signedTest.created_at), tecnicoResponsable,
    ambienteTempText, ambienteHumedadText, estadoEquipoText, normas.join(' / ')
  ), n);
  n++;
  var outerRows = [outerNestedFullRow_(section1Rows, function (nestedTable) {
    var photoCell = nestedTable.getRow(1).getCell(2);
    var photoBlob = getTransformerPlatePhotoBlob_(transformer.plate_photo_file_id);
    if (photoBlob) {
      var pimg = photoCell.appendImage(photoBlob);
      var pratio = pimg.getHeight() / pimg.getWidth();
      pimg.setWidth(80);
      pimg.setHeight(Math.round(80 * pratio));
      // La imagen es un elemento INLINE dentro de su propio párrafo — para
      // centrarla hay que alinear ESE párrafo (cellAlign_ centraría el
      // párrafo vacío original de la celda, no el de la imagen).
      pimg.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    }
    // Ronda 7b (2026-09-17) — a pedido del cliente ("sin texto alternativo
    // visible que rompa la estética"): si el equipo no tiene foto de
    // placa, la celda queda vacía (ya no dice "Sin foto"), consistente
    // con el resto del documento donde nunca se inventa/anuncia un dato
    // ausente con texto de relleno.
  })];

  // Sección 2+3 (ronda 3): Objetivo y Alcance | Equipos Utilizados, lado a
  // lado — nuevas, a pedido del "prompt maestro" del 2026-09-15.
  outerRows.push(outerNestedPairRow_(
    numberSection_(buildObjetivoAlcanceRows_(presentLabels), n++),
    numberSection_(buildEquiposUtilizadosRows_(equipos), n++)
  ));

  // Punto 11, ronda 6 (2026-09-16) — REESTRUCTURACIÓN de emparejamiento a
  // pedido explícito del cliente, mirando de nuevo la referencia real que
  // había compartido: TTR va junto a AT (no junto a su gráfica), BT junto
  // a Aislamiento (no junto a la leyenda DAR/IP), y las 2 gráficas
  // (TTR + curva de aislamiento) más los criterios de evaluación
  // (Devanados + DAR/IP) pasan a ser 2 secciones propias, emparejadas
  // entre sí, DESPUÉS de los resultados. Reemplaza el emparejamiento de
  // las rondas 2-5 (TTR+gráfica, AT+BT, Aislamiento+leyenda) por completo.
  var ttrRowsFinal = null, atRowsFinal = null, btRowsFinal = null, aisRowsFinal = null;
  var atVerdict = null;

  if (ttrCalc) {
    ttrRowsFinal = buildTtrUnifiedSection_(ttrCalc, esMonofasico, ttrInstrumento, ttrWarning);
    ttrRowsFinal.push(nestedVerdictRow_('Veredicto TTR', ttrCalc.overallVerdict));
    allVerdicts.push(ttrCalc.overallVerdict);
    allNotes = allNotes.concat(collectTtrUnifiedNotes_(ttrCalc));
  }

  // AT y BT — Punto 4 (2026-09-13): primario y secundario son cada uno
  // opcional, se prueba solo AT, solo BT, o ambos. 2026-10-01:
  // calculateWindingResistance_ ahora SÍ expone `primaryVerdict` (cascada de
  // 3 niveles, incluye OBSERVADO) — se usa directo en vez de re-derivarlo
  // con `every(... === 'APROBADO')`, que colapsaba OBSERVADO a RECHAZADO.
  if (wrCalc) {
    if (wrCalc.taps && wrCalc.taps.length > 0) {
      atRowsFinal = buildWindingSideUnifiedRows_('ALTA TENSIÓN (AT)', wrCalc.taps, esMonofasico, transformer.at_devanado_material, wrInstrumento, WINDING_PHASE_ORDER_);
      atVerdict = legacyPrimaryVerdictFallback_(wrCalc);
      atRowsFinal.push(nestedVerdictRow_('Veredicto AT', atVerdict));
      allVerdicts.push(atVerdict);
      allNotes = allNotes.concat(collectWindingSideUnifiedNotes_('AT', wrCalc.taps));
    }
    if (wrCalc.secondary) {
      btRowsFinal = buildWindingSideUnifiedRows_('BAJA TENSIÓN (BT)', [wrCalc.secondary], esMonofasico, transformer.bt_devanado_material, wrInstrumento, WINDING_SECONDARY_PHASE_ORDER_);
      btRowsFinal.push(nestedVerdictRow_('Veredicto BT', wrCalc.secondary.verdict));
      allVerdicts.push(wrCalc.secondary.verdict);
      allNotes = allNotes.concat(collectWindingSideUnifiedNotes_('BT', [wrCalc.secondary]));
    }
  }

  if (aisCalc) {
    aisRowsFinal = buildInsulationUnifiedRows_(aisCalc, aisInstrumento, aisTension);
    aisRowsFinal.push(nestedVerdictRow_('Veredicto Aislamiento', aisCalc.overallVerdict));
    allVerdicts.push(aisCalc.overallVerdict);
    allNotes = allNotes.concat(collectInsulationUnifiedNotes_(aisCalc));
  }

  // TTR | AT — emparejados. Si falta uno de los 2, el que sí está va solo,
  // a ancho completo (nunca se fuerza un emparejamiento con nada).
  if (ttrRowsFinal && atRowsFinal) {
    numberSection_(ttrRowsFinal, n++);
    numberSection_(atRowsFinal, n++);
    outerRows.push(outerNestedPairRow_(ttrRowsFinal, atRowsFinal));
  } else if (ttrRowsFinal) {
    outerRows.push(outerNestedFullRow_(numberSection_(ttrRowsFinal, n++)));
  } else if (atRowsFinal) {
    outerRows.push(outerNestedFullRow_(numberSection_(atRowsFinal, n++)));
  }

  // BT | Aislamiento — emparejados, mismo criterio.
  if (btRowsFinal && aisRowsFinal) {
    numberSection_(btRowsFinal, n++);
    numberSection_(aisRowsFinal, n++);
    outerRows.push(outerNestedPairRow_(btRowsFinal, aisRowsFinal));
  } else if (btRowsFinal) {
    outerRows.push(outerNestedFullRow_(numberSection_(btRowsFinal, n++)));
  } else if (aisRowsFinal) {
    outerRows.push(outerNestedFullRow_(numberSection_(aisRowsFinal, n++)));
  }

  // Gráficos de Resultados (TTR + curva de aislamiento) | Criterios de
  // Evaluación (Devanados + DAR/IP) — emparejados entre sí. Cada uno se
  // arma solo si aplica (monofásico no tiene gráfica de TTR; Aislamiento
  // Simple no tiene curva ni DAR/IP).
  //
  // Punto 11, ronda 6 (2026-09-16) — bug real encontrado en la
  // verificación en vivo: apilar las 2 imágenes DENTRO de una tabla
  // anidada (`unifiedImageRow_`) las dejaba mal si esa tabla anidada
  // necesitaba partirse entre páginas — Google Docs las dibujaba fuera de
  // su celda, montadas sobre el encabezado de la página siguiente. Se
  // resolvió sacándolas de la tabla anidada: ahora van DIRECTO en la
  // celda de la tabla EXTERNA (`outerImagesPairRow_`), el mismo mecanismo
  // que ya usaban `outerImageFullRow_`/`outerPairTableImageRow_` en
  // rondas anteriores — nunca mostraron este bug.
  var willHaveTtrChart = !!(ttrCalc && !esMonofasico && ttrCalc.taps && Object.keys(ttrCalc.taps).length > 0);
  var willHaveCurveChart = !!(aisCalc && !aisEsSimple);
  // Punto 11, ronda 6s (2026-09-16) — 70pt (ronda 6e) resultó ilegible a
  // pedido del cliente ("la gráfica no se detalla bien"). La ronda 6o
  // encontró la causa REAL de los huecos entre secciones (altura mínima
  // de fila reseteada por el merge + párrafos vacíos sin encoger, ver
  // `applyOuterAndNestedMerges_`) — con ese fix, el documento ya no
  // depende de imágenes diminutas para caber en 1 página, así que se
  // suben a un tamaño legible. Verificar que se siga cabiendo en 1
  // página con este tamaño antes de dar por cerrado.
  // Ronda 8j (2026-09-19) — a pedido del usuario ("las gráficas se ven
  // mal, no se entienden bien"): 250x55pt deformaba la gráfica nativa
  // (460x240, relación 1.92:1) a una relación de 4.5:1, aplastándola
  // verticalmente. Con el espacio liberado por el rebalanceo de la
  // Sección 1 (ronda 8i, 12→9 filas) alcanza para respetar la relación de
  // aspecto real. Verificar que se siga cabiendo en 1 página con este
  // tamaño antes de dar por cerrado.
  // Ronda 8k (2026-09-19) — 230x120 (relación real 1.92:1) desbordó de
  // nuevo a página 2 (confirmado, mismo síntoma de siempre: solo el pie
  // repetido) — el espacio libre tras la ronda 8i no alcanzaba para la
  // relación de aspecto exacta. Se baja a 155x80 (relación 1.94:1, casi
  // igual de fiel) — sigue siendo mucho menos deformado que el 250x55
  // original (4.5:1) sin volver a desbordar.
  // Ronda 8l (2026-09-19) — a pedido del usuario, las 2 gráficas pasan de
  // apiladas a lado a lado (ver el nuevo bloque `images-pair` más abajo,
  // tabla 1x2 sin bordes) — con el ancho de celda ahora fijo en 270pt
  // (mismo total que TTR_WINDING_COL_WIDTHS_PT_, ver ronda 8m), cada
  // gráfica dispone de ~131pt de ancho real. 128x67 mantiene la relación
  // de aspecto nativa (460x240 = 1.92:1; 128/67 = 1.91:1) — el usuario
  // había sugerido 125x100 (relación 1.25:1), que hubiera vuelto a
  // deformarlas, esta vez estirándolas de más a lo alto.
  var chartImages = [];
  if (willHaveTtrChart) {
    var ttrChartBlob = buildTtrDeviationChart_(ttrCalc, esMonofasico, null);
    if (ttrChartBlob) chartImages.push({ blob: ttrChartBlob, widthPt: 128, heightPt: 67 });
  }
  if (willHaveCurveChart) {
    var curveBlob = buildInsulationCurveChart_(aisCalc, aisRaw, null);
    if (curveBlob) chartImages.push({ blob: curveBlob, widthPt: 128, heightPt: 67 });
  }
  var devanadosCriteriaNeeded = !!(atRowsFinal || btRowsFinal);
  var aislamientoCriteriaNeeded = !!aisCalc;
  var criteriaRows = null;
  if (devanadosCriteriaNeeded || aislamientoCriteriaNeeded) {
    criteriaRows = [];
    if (devanadosCriteriaNeeded) criteriaRows = criteriaRows.concat(buildWindingCriteriaTable3Tier_());
    if (aislamientoCriteriaNeeded) criteriaRows = criteriaRows.concat(buildInsulationCriteriaRows_(aisEsSimple));
    criteriaRows.cellPadding = 0.5;
    // Ronda 8m (2026-09-19) — HALLAZGO REAL: `Array.concat()` devuelve un
    // arreglo NUEVO, que no hereda propiedades puestas a mano (colWidths)
    // en los arreglos originales — el colWidths que cada build*_ dejaba
    // en su propio `rows` (visto arriba) se perdía acá silenciosamente,
    // dejando esta tabla combinada SIN anchos explícitos pese a que el
    // código parecía fijarlos. Se vuelve a poner después del concat.
    criteriaRows.colWidths = CRITERIA_COL_WIDTHS_PT_;
  }
  if (chartImages.length && criteriaRows) {
    var chartsNum = n++;
    numberSection_(criteriaRows, n++);
    outerRows.push(outerImagesPairRow_(chartsNum + '. GRÁFICOS DE RESULTADOS', chartImages, criteriaRows));
  } else if (chartImages.length) {
    outerRows.push(outerImagesPairRow_(n++ + '. GRÁFICOS DE RESULTADOS', chartImages, null));
  } else if (criteriaRows) {
    outerRows.push(outerNestedFullRow_(numberSection_(criteriaRows, n++)));
  }

  // Observaciones + Conclusión General — emparejadas lado a lado (ronda
  // 3, 2026-09-15); antes iban apiladas a todo el ancho, una debajo de
  // la otra.
  // 2026-10-01: cascada de 3 niveles (antes `every(... === 'APROBADO')`
  // colapsaba cualquier OBSERVADO —p. ej. devanados con 3% de desbalance—
  // directo a RECHAZADO en la conclusión combinada).
  var conclusionVerdict = !allVerdicts.length ? 'RECHAZADO'
    : allVerdicts.some(function (v) { return String(v).indexOf('RECHAZADO') === 0; }) ? 'RECHAZADO'
    : allVerdicts.some(function (v) { return String(v).indexOf('OBSERVADO') === 0; }) ? 'OBSERVADO'
    : 'APROBADO';
  outerRows.push(outerNestedPairRow_(
    numberSection_(buildObservacionesRows_(presentLabels, estadoEquipoText, normas.join(' / '), conclusionVerdict), n++),
    numberSection_(buildConclusionRows_(conclusionVerdict), n++)
  ));

  // "ÁREA DE CONTROL DE CALIDAD" (firmas) — Punto 11, ronda 6k (2026-09-16):
  // ya NO vive horneada en la plantilla (ver buildFirmasUnifiedRows_) — es
  // una fila más de esta misma tabla unificada, para no dejar el hueco
  // entre tablas de nivel superior que impedía cerrar 1 sola página.
  // PROBADO POR = mismo criterio que TÉCNICO RESPONSABLE arriba
  // (operador_nombre, no la cuenta de login compartida). CERTIFICADO POR
  // (2026-09-13, a pedido del cliente) queda FIJO en el mismo ingeniero
  // que ya firma "APROBADO POR" — deja de mostrar quién certificó en la
  // app (revisado_por), la fecha real de certificación sí se conserva.
  // Punto 11, ronda 7 (2026-09-17) — QR de autenticidad (JSON de diseño
  // del cliente, 4to bloque de la Sección 12): `verificationId` se genera
  // ACÁ (antes de armar el PDF) porque el QR tiene que quedar YA
  // insertado en el documento antes de exportarlo — pero el registro en
  // DOCUMENTOS (con este mismo id) recién se puede escribir más abajo,
  // después de conocer `saved.fileId`. Se reusa el MISMO id en los 2
  // lugares (nunca 2 generateId_() distintos) para que el QR apunte
  // exactamente al registro que se guarda. La página pública de
  // verificación (verificarInformeElectrico_, sin login — ver doGet) lee
  // por ese id; si no existe o no es un CERTIFICADOS eléctrico, muestra
  // "no válido" — así de eso depende que el QR sirva para detectar un
  // certificado falso/alterado.
  var verificationId = generateId_();
  // Ronda 7c: `shortenUrl_` (is.gd) falla siempre desde Apps Script
  // ("Error, database insert failed" — bloquea las IPs salientes de
  // UrlFetchApp, confirmado en vivo) — se deja de llamar para no sumar
  // latencia por una llamada condenada a fallar; se prioriza tamaño/
  // resolución del QR en vez de acortar la URL.
  var verificationUrl = ScriptApp.getService().getUrl() + '?verificar=' + verificationId;
  var qrBlob = getQrCodeBlob_(verificationUrl);

  var firmaRows = numberSection_(buildFirmasUnifiedRows_(
    { nombre: tecnicoResponsable, fecha: signedTest.created_at },
    { nombre: ENGINEER_SIGNATURE_NAME_, fecha: signedTest.revisado_at }
  ), n++);
  outerRows.push(outerNestedFullRow_(firmaRows, function (nestedTable) {
    var dataRowRef = nestedTable.getRow(2);
    // Ronda 8o (2026-09-19) — a pedido explícito del usuario: las 4
    // celdas de la fila de datos quedan centradas verticalmente (antes
    // arriba, dejando un hueco visible debajo cuando el QR —la celda más
    // alta de la fila— sobraba espacio respecto a las demás).
    for (var fc = 0; fc < dataRowRef.getNumCells(); fc++) {
      dataRowRef.getCell(fc).setVerticalAlignment(DocumentApp.VerticalAlignment.CENTER);
    }

    function fillNameDateCell_(cell, nombre, fecha) {
      var nameLine = cell.appendParagraph(nombre || '—');
      nameLine.editAsText().setBold(true).setFontSize(10).setFontFamily(PROTOCOL_FONT_FAMILY_);
      nameLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
      var dateLine = cell.appendParagraph(fmtDatePdf_(fecha));
      dateLine.editAsText().setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED).setFontFamily(PROTOCOL_FONT_FAMILY_);
      dateLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
      // appendParagraph deja un párrafo vacío inicial en la celda (el
      // mismo que styleUnifiedCell_ suele limpiar para celdas con texto
      // puesto por initialCells) — acá la celda arrancó vacía a propósito
      // (ver buildFirmasUnifiedRows_), así que hay que quitarlo a mano.
      if (cell.getNumChildren() > 2 && cell.getChild(0).getType() === DocumentApp.ElementType.PARAGRAPH && cell.getChild(0).asParagraph().getText() === '') {
        cell.removeChild(cell.getChild(0));
      }
    }
    fillNameDateCell_(dataRowRef.getCell(0), tecnicoResponsable, signedTest.created_at);
    fillNameDateCell_(dataRowRef.getCell(1), ENGINEER_SIGNATURE_NAME_, signedTest.revisado_at);

    var sigCell = dataRowRef.getCell(2);
    var engineerBlob = getEngineerSignatureBlob_();
    if (engineerBlob) {
      var simg = sigCell.appendImage(engineerBlob);
      var sratio = simg.getHeight() / simg.getWidth();
      // Ronda 8o (2026-09-19) — a pedido explícito del usuario: el QR
      // (100pt) le ganaba demasiado peso visual a la firma (45pt desde
      // ronda 6s, cuando el gráfico de arriba todavía obligaba a
      // mantenerla chica). Con el espacio liberado desde entonces
      // (rebalanceo Sección 1 + gráficas lado a lado, rondas 8i/8l) hay
      // margen real para subirla — 80pt, manteniendo su relación de
      // aspecto real (nunca un 120x60 fijo, que la habría estirado).
      // Verificar que se siga cabiendo en 1 página con este tamaño antes
      // de dar por cerrado.
      simg.setWidth(80);
      simg.setHeight(Math.round(80 * sratio));
      simg.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    }
    var snameLine = sigCell.appendParagraph(ENGINEER_SIGNATURE_NAME_);
    snameLine.editAsText().setBold(true).setFontSize(10).setFontFamily(PROTOCOL_FONT_FAMILY_);
    snameLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
    var stitleLine = sigCell.appendParagraph(ENGINEER_SIGNATURE_TITLE_);
    stitleLine.editAsText().setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED).setFontFamily(PROTOCOL_FONT_FAMILY_);
    stitleLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);

    // Ronda 8d (2026-09-19) — HALLAZGO REAL: una sub-tabla anidada DENTRO
    // de la celda "Autenticidad" (imagen a la izquierda, texto a la
    // derecha) reportaba el `appendImage` como exitoso a nivel
    // DocumentApp (blob válido de 1347 bytes, image/png, ancho/alto
    // 120x120 correctos, celda con sus hijos — confirmado con un
    // diagnóstico puntual) pero la imagen NUNCA aparecía en el PDF ya
    // exportado. Un límite real de Docs con imágenes anidadas 3 niveles
    // (tabla externa → tabla de firmas → sub-tabla), distinto del bug de
    // partido de página de la ronda 6. Arreglado sin la sub-tabla: la
    // tabla de firmas ahora tiene 5 columnas físicas de verdad (ver
    // buildFirmasUnifiedRows_/SECTION12_FIVE_COL_WIDTHS_PT_) — imagen y
    // texto son cada uno su propia celda de la MISMA tabla, sin nivel de
    // anidación extra.
    // Ronda 8j (2026-09-19) — a pedido explícito del usuario: sin texto al
    // lado (celda 4 fusionada con la 3, ver buildFirmasUnifiedRows_) y
    // tamaño reducido para verse uniforme con la firma/demás datos de la
    // fila. Ronda 7 había confirmado 45-75pt NO escaneables (decode real
    // sobre el PDF exportado) y 120pt como piso — 100pt es una prueba
    // intermedia, DEBE reverificarse con el mismo test de decode antes de
    // dar esto por bueno; si falla, subir hasta el siguiente tamaño que sí
    // decodifique, nunca asumir por la vista.
    var qrImgCell = dataRowRef.getCell(3);
    if (qrBlob) {
      var qimg = qrImgCell.appendImage(qrBlob);
      qimg.setWidth(100);
      qimg.setHeight(100);
      qimg.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    } else {
      var noQr = qrImgCell.appendParagraph('—');
      noQr.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
    }
  }));

  var tablePlaceholderPar = findMarkerParagraph_(body, '<<TABLA_RESULTADOS_ELECTRICOS>>');
  if (!tablePlaceholderPar) throw new Error('La plantilla no tiene el marcador de la tabla de resultados — regenera las plantillas desde Administración.');
  var tableResult = insertOuterResultsTable_(body, tablePlaceholderPar, outerRows);
  body.removeChild(tablePlaceholderPar);
  appendUnifiedNoteFootnote_(body, tableResult.table, allNotes);

  var fileName = 'Informe_Electrico_' + transformer.serial_number + '_' + fmtTimestampForFilename_(new Date());
  var saved = finalizeReportPdf_(doc, folderId, fileName, { outerMarkerText: tableResult.outerMarkerText, outerMergeSpecs: tableResult.outerMergeSpecs, nestedRegistry: tableResult.nestedRegistry });

  getSheet_('TRANSFORMADORES').getRange(transformer._row, colIndex_('TRANSFORMADORES', 'electrical_report_file_id')).setValue(saved.fileId);

  // Reusa `verificationId` (el mismo que ya quedó embebido en el QR del
  // PDF) — nunca un id nuevo acá, o el QR apuntaría a un registro que no
  // existe.
  appendRow_('DOCUMENTOS', {
    id: verificationId,
    site_id: transformer.site_id,
    category: 'CERTIFICADOS',
    file_name: fileName,
    file_id: saved.fileId,
    mime_type: 'application/pdf',
    uploaded_by: uploadedBy || 'desconocido',
    created_at: new Date().toISOString(),
    transformer_id: transformer.id,
    verdict: conclusionVerdict,
    certified_by: ENGINEER_SIGNATURE_NAME_
  });

  return saved;
}

// ---------------------------------------------------------------------------
// Punto 12, ronda 9 (2026-09-26) — Protocolo único de Aceite Dieléctrico,
// migrado de "plantilla fija + replaceText" a la misma arquitectura de
// tabla única que ya usa Eléctrico (regenerateElectricalCombinedReport_):
// un solo PDF con las secciones REALMENTE activas (1, 2 o 3 de
// Fisicoquímico/DGA/PCB), header/footer/watermark reusados de la MISMA
// plantilla ya migrada del Eléctrico (ver migrateOilTemplateFromElectrical_
// más abajo), firmas + QR de autenticidad con el mismo mecanismo
// (buildFirmasUnifiedRows_, DOCUMENTOS, verificarInformeElectrico_ — ese
// último ya era genérico por categoría/transformer_id, nunca exclusivo de
// Eléctrico pese al nombre). A pedido explícito del usuario: SIN fotos de
// muestra, y SOLO con los 7 parámetros de Fisicoquímico que YA se
// capturan hoy (nunca se agregaron campos nuevos al formulario) — la
// sección "Tendencia histórica" de la referencia visual queda para una
// ronda aparte (cruza pruebas pasadas del mismo equipo, pieza bastante más
// grande que el resto de este protocolo).
// ---------------------------------------------------------------------------

// Ronda 9 (2026-09-26) — HALLAZGO REAL en la verificación en vivo: estas 2
// tablas (Fisicoquímico/PCB) van a TODO EL ANCHO (outerNestedFullRow_),
// no emparejadas — un primer intento sumando solo 270pt (mismo total que
// un bloque emparejado) dejaba la mitad derecha de la página en blanco.
// Ronda 10 (2026-09-29) — CORREGIDO: se habían recalculado sumando 560pt
// (prestado del total del Eléctrico, ver el mismo hallazgo ya corregido
// en OIL_FULL_WIDTH_COLS_PT_/OIL_FIRMAS_COL_WIDTHS_PT_ más abajo), pero
// el total real que gobierna la tabla maestra de Aceite es 540pt — mismo
// reescalado proporcional que ya se le aplicó a Firmas. Verificado con
// PDF real que ambas tablas ya alinean con el resto.
var OIL_RESULTS_COL_WIDTHS_PT_ = [145, 125, 53, 53, 96, 34, 34];
// DGA también va a todo el ancho, sin emparejar — mismo criterio, columnas
// parejas (GAS ocupa cols 0-3 fusionadas, VALOR cols 4-6 fusionadas, ver
// buildOilDgaRows_), reescalado a 540pt igual que arriba (ronda 10).
var OIL_DGA_COL_WIDTHS_PT_ = [67, 67, 68, 68, 90, 90, 90];

/** Ronda 9 (2026-09-26) — HALLAZGO REAL en la verificación en vivo: con
 *  las 3 secciones de Aceite activas a la vez (13 secciones numeradas en
 *  total), el informe desbordaba a 2 páginas por SOLO la fila de firmas
 *  — mismo síntoma que la saga de la ronda 8 del Eléctrico. Causa
 *  análoga a la ronda 8i (Sección 1 desperdiciaba espacio): 1 campo por
 *  fila era el doble de alto de lo necesario. Se empaquetan 2 campos por
 *  fila (etiqueta|valor|etiqueta|valor en las 7 columnas físicas) — cada
 *  grilla pasa a la mitad de filas. `fields` es un arreglo de [etiqueta,
 *  valor]; un número impar de campos deja el último con la mitad derecha
 *  vacía, nunca un dato inventado. */
function buildOilDenseInfoRows_(bannerText, fields) {
  var rows = [unifiedBannerRow_(bannerText)];
  var merges = [{ startColumnIndex: 1, columnSpan: 2 }, { startColumnIndex: 4, columnSpan: 3 }];
  for (var i = 0; i < fields.length; i += 2) {
    var left = fields[i];
    var right = fields[i + 1] || ['', ''];
    rows.push(unifiedLabelRow_([left[0], left[1], '', right[0], right[1], '', ''], [0, 3], merges));
  }
  rows.colWidths = [45, 30, 30, 45, 40, 40, 40];
  return rows;
}

/** Cliente y equipo — igual criterio que Sección 1 del Eléctrico pero SIN
 *  columna de foto (el equipo de Aceite no necesita la placa nameplate en
 *  este protocolo — ver Sección de muestra para lo que sí es propio de
 *  Aceite). Ancho total 270pt (NESTED_HALF_WIDTH_PT_), para emparejarse
 *  sin "zigzag" con la grilla de Muestra al lado (mismo hallazgo de la
 *  ronda 8m). */
function buildOilClientEquipoRows_(site, transformer) {
  return buildOilDenseInfoRows_('DATOS DEL CLIENTE Y DEL EQUIPO', [
    ['CLIENTE', site.client_name || '—'],
    ['NIT', site.nit || '—'],
    ['CIUDAD', site.ciudad || '—'],
    ['PROYECTO', site.project_name || '—'],
    ['FABRICANTE', transformer.manufacturer || '—'],
    ['N° DE SERIE', transformer.serial_number || '—'],
    ['POTENCIA NOMINAL', transformer.rated_power_kva ? (String(transformer.rated_power_kva) + ' kVA') : '—'],
    ['TENSIÓN PRIMARIA', transformer.hv_nominal_voltage ? (String(transformer.hv_nominal_voltage) + ' V') : '—'],
    ['TENSIÓN SECUNDARIA', transformer.lv_nominal_voltage ? (String(transformer.lv_nominal_voltage) + ' V') : '—'],
    ['AÑO DE FABRICACIÓN', transformer.manufacture_year ? String(transformer.manufacture_year) : '—']
  ]);
}

/** Información de la muestra — mismos 4 campos que ya captura el
 *  formulario de Aceite hoy (fecha, técnico, muestra tomada por, fecha de
 *  muestreo) — nunca se inventan campos nuevos (código de muestra, punto
 *  de muestreo, temperatura del aceite, condiciones ambientales, entidad
 *  externa) que trae la referencia visual pero que el formulario no
 *  captura todavía. */
function buildOilMuestraRows_(testMeta, rawReadings) {
  return buildOilDenseInfoRows_('INFORMACIÓN DE LA MUESTRA', [
    ['FECHA DE PRUEBA', fmtDatePdf_(testMeta.created_at)],
    ['TÉCNICO RESPONSABLE', testMeta.operador_nombre || testMeta.tested_by || '—'],
    ['MUESTRA TOMADA POR', rawReadings.sample_taken_by || '—'],
    ['FECHA DE MUESTREO', rawReadings.sample_date ? fmtDatePdf_(rawReadings.sample_date) : '—']
  ]);
}

/** Tabla de resultados Fisicoquímico — ENSAYO/MÉTODO/UNIDAD/RESULTADO/
 *  LÍMITE DE REFERENCIA/ESTADO (ESTADO fusiona las 2 últimas columnas
 *  físicas para tener más espacio, mismo criterio que Aislamiento/
 *  Criterios del Eléctrico). ESTADO queda '—' para los 3 parámetros sin
 *  umbral numérico (Examen visual/Color/Densidad) — nunca CUMPLE/NO
 *  CUMPLE inventado sin un umbral real detrás. */
function buildOilFisicoquimicoRows_(rawReadings) {
  var merges = [{ startColumnIndex: 5, columnSpan: 2 }];
  var rows = [unifiedBannerRow_('RESULTADOS DEL ANÁLISIS FISICOQUÍMICO')];
  rows.push(unifiedRow_(['ENSAYO', 'MÉTODO', 'UNIDAD', 'RESULTADO', 'LÍMITE DE REFERENCIA', 'ESTADO', ''], 'header', merges));
  OIL_FISICOQUIMICO_PARAMS_.forEach(function (p) {
    var raw = rawReadings[p.key];
    var v = p.isText ? raw : optionalNumber_(raw);
    var resultText = p.isText ? (raw || '—') : (v !== undefined ? String(v) : '—');
    var estado = '—';
    if (!p.isText && v !== undefined && p.check) estado = p.check(v) ? 'CUMPLE' : 'NO CUMPLE';
    rows.push(unifiedRow_([p.label, p.metodo, p.unidad, resultText, p.limiteText || '—', estado, ''], 'data', merges));
  });
  rows.colWidths = OIL_RESULTS_COL_WIDTHS_PT_;
  return rows;
}

/** Interpretación de resultados — construida a partir de los MISMOS
 *  umbrales ya evaluados en `calculateOilAnalysis_` (nunca un umbral
 *  nuevo): lista, en español, cuáles parámetros reales quedaron fuera de
 *  rango. Si ninguno lo está, un párrafo de conformidad. */
function buildOilFisicoquimicoInterpretacionText_(rawReadings, section) {
  if (!section || !section.complete && section.verdict === 'Sin datos') {
    return 'No hay datos suficientes de ningún parámetro fisicoquímico para interpretar el resultado.';
  }
  var fueraDeRango = [];
  OIL_FISICOQUIMICO_PARAMS_.forEach(function (p) {
    if (p.isText || !p.check) return;
    var v = optionalNumber_(rawReadings[p.key]);
    if (v !== undefined && !p.check(v)) fueraDeRango.push(p.label.toLowerCase());
  });
  if (fueraDeRango.length === 0) {
    return 'El aceite dieléctrico presenta valores dentro de los límites de referencia establecidos para los parámetros evaluados, sin evidencia de deterioro significativo de sus propiedades dieléctricas o químicas.';
  }
  return 'El aceite dieléctrico presenta valores fuera de los límites de referencia establecidos en ' +
    joinSpanishList_(fueraDeRango) + '. Estas condiciones pueden indicar deterioro del aceite, pérdida de ' +
    'sus propiedades dieléctricas o químicas, y un mayor riesgo de fallas por humedad, envejecimiento ' +
    'acelerado del aislamiento o reducción de la vida útil del transformador.';
}

/** Recomendaciones Fisicoquímico — texto estándar ligado a la severidad
 *  YA calculada (1=OK, 2=REQUIERE TERMOVACÍO, 3=REQUIERE REGENERACIÓN/
 *  CAMBIO — ver calculateOilAnalysis_), nunca a un parámetro puntual —
 *  mismo criterio que "Objetivo y Alcance" del Eléctrico: texto fijo de
 *  buena práctica, no un dato medido. */
function buildOilFisicoquimicoRecomendacionesText_(section) {
  var v = section ? String(section.verdict || '') : '';
  if (v.indexOf('REQUIERE REGENERACIÓN') === 0) {
    return [
      'Realizar regeneración o cambio del aceite dieléctrico — los valores obtenidos superan el límite ' +
      'aceptable de acidez o están por debajo del límite de tensión interfacial.',
      'Evitar la operación prolongada del equipo sin corregir el estado del aceite.',
      'Una vez finalizado el tratamiento, tomar una nueva muestra y repetir el análisis fisicoquímico.',
      'Si persisten valores fuera de norma, realizar evaluación complementaria del aceite y del sistema de aislamiento sólido.'
    ];
  }
  if (v.indexOf('REQUIERE TERMOVACÍO') === 0) {
    return [
      'Realizar tratamiento de termovacío del aceite dieléctrico para reducir el contenido de humedad y gases disueltos.',
      'Efectuar filtración y desgasificación con equipos de alta eficiencia.',
      'Verificar y corregir posibles fuentes de ingreso de humedad (sellos, respiradero, conservador, empaques).',
      'Una vez finalizado el tratamiento, tomar una nueva muestra y repetir el análisis fisicoquímico.'
    ];
  }
  return [
    'Mantener la identificación del equipo con su resultado fisicoquímico.',
    'Conservar la trazabilidad de los análisis realizados.',
    'Continuar con el programa de mantenimiento y monitoreo del aceite.'
  ];
}

/** Criterios de referencia (Fisicoquímico) — tabla estática de los 4
 *  umbrales REALES ya usados por calculateOilAnalysis_ (nunca un valor
 *  nuevo) — mismo criterio que "CALIFICACIÓN DAR/IP" del Eléctrico. */
function buildOilCriteriosReferenciaRows_() {
  var rows = [unifiedBannerRow_('CRITERIOS DE EVALUACIÓN (REFERENCIA)')];
  var merges = [{ startColumnIndex: 0, columnSpan: 4 }, { startColumnIndex: 4, columnSpan: 3 }];
  var header = new Array(UNIFIED_TABLE_COLS_).fill('');
  header[0] = 'PARÁMETRO'; header[4] = 'LÍMITE DE REFERENCIA';
  rows.push(unifiedRow_(header, 'header', merges));
  OIL_FISICOQUIMICO_PARAMS_.filter(function (p) { return p.limiteText; }).forEach(function (p) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = p.label; cells[4] = p.limiteText;
    rows.push(unifiedRow_(cells, 'legend', merges));
  });
  rows.cellPadding = 0.5;
  rows.colWidths = CRITERIA_COL_WIDTHS_PT_;
  return rows;
}

/** DGA — sin matriz de interpretación automática todavía (decisión ya
 *  tomada, ver calculateOilAnalysis_: "Solo captura de datos") — la tabla
 *  solo muestra los valores capturados, sin ESTADO ni veredicto. */
function buildOilDgaRows_(rawReadings) {
  var rows = [unifiedBannerRow_('CROMATOGRAFÍA DE GASES DISUELTOS (DGA)')];
  var merges = [{ startColumnIndex: 0, columnSpan: 4 }, { startColumnIndex: 4, columnSpan: 3 }];
  rows.push(unifiedRow_(['GAS', '', '', '', 'VALOR (PPM)', '', ''], 'header', merges));
  OIL_DGA_GASES_.forEach(function (g) {
    var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
    cells[0] = g.label; cells[4] = String(numOrDash_(rawReadings[g.key]));
    rows.push(unifiedRow_(cells, 'data', merges));
  });
  var noteCells = new Array(UNIFIED_TABLE_COLS_).fill('');
  noteCells[0] = 'Método ASTM D3612-02(2017), Método C — solo captura de datos, sin matriz de interpretación automática todavía.';
  var noteRow = unifiedRow_(noteCells, 'data', [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }]);
  noteRow.fontSizeOverride = 6.5;
  rows.push(noteRow);
  rows.colWidths = OIL_DGA_COL_WIDTHS_PT_;
  return rows;
}

/** Tabla de resultados PCB — 1 sola fila (Total PCB, suma de los 7
 *  Aroclores YA calculada por calculateOilAnalysis_) — Método/Límite de
 *  cuantificación/Incertidumbre son datos FIJOS de la metodología de
 *  laboratorio (OIL_PCB_METODO_/OIL_PCB_LOQ_PPM_/OIL_PCB_INCERTIDUMBRE_),
 *  no una medición por muestra — igual criterio que el método ASTM por
 *  parámetro de Fisicoquímico. */
function buildOilPcbRows_(section) {
  var merges = [{ startColumnIndex: 5, columnSpan: 2 }];
  var rows = [unifiedBannerRow_('RESULTADO DE ANÁLISIS CUANTITATIVO DE PCB')];
  rows.push(unifiedRow_(['PARÁMETRO', 'MÉTODO', 'UNIDAD', 'RESULTADO', 'LÍMITE / INCERTIDUMBRE', 'ESTADO', ''], 'header', merges));
  var contaminado = section.totalPcbPpm >= section.limitePpm;
  var limiteText = '< ' + section.limitePpm + ' ppm  ·  ' + OIL_PCB_INCERTIDUMBRE_;
  rows.push(unifiedRow_([
    'Bifenilos Policlorados (PCB)', OIL_PCB_METODO_, 'ppm (mg/kg)', section.totalPcbPpm.toFixed(2),
    limiteText, contaminado ? 'NO CUMPLE' : 'CUMPLE', ''
  ], 'data', merges));
  rows.colWidths = OIL_RESULTS_COL_WIDTHS_PT_;
  return rows;
}

/** Clasificación regulatoria real (Res. 0222 de 2011) — tabla estática,
 *  ver OIL_PCB_CLASIFICACION_. La fila que corresponde al resultado real
 *  se resalta (mismo criterio visual que un veredicto). */
function buildOilPcbClasificacionRows_(section) {
  var rows = [unifiedBannerRow_('CLASIFICACIÓN — RESOLUCIÓN 0222 DE 2011 (MINAMBIENTE)')];
  rows[0].fontSizeOverride = 8;
  var merges = [{ startColumnIndex: 0, columnSpan: 2 }, { startColumnIndex: 2, columnSpan: 2 }, { startColumnIndex: 4, columnSpan: 3 }];
  var header = unifiedRow_(['CONCENTRACIÓN', '', 'CLASIFICACIÓN', '', 'DESCRIPCIÓN', '', ''], 'header', merges);
  header.fontSizeOverride = 6.5;
  rows.push(header);
  OIL_PCB_CLASIFICACION_.forEach(function (band) {
    var cells = [band.rango + ' ppm', '', band.clasificacion, '', band.descripcion, '', ''];
    var row = unifiedRow_(cells, 'legend', merges);
    row.fontSizeOverride = 6;
    rows.push(row);
  });
  rows.cellPadding = 0.5;
  rows.colWidths = CRITERIA_COL_WIDTHS_PT_;
  return rows;
}

/** Interpretación técnica PCB — construida a partir del resultado real
 *  (`section.totalPcbPpm`) contra las bandas REALES de
 *  OIL_PCB_CLASIFICACION_, nunca un umbral inventado. */
function buildOilPcbInterpretacionText_(section) {
  var ppm = section.totalPcbPpm;
  var clasif = ppm < 50 ? 'NO PCB' : (ppm < 500 ? 'PCB - Grupo 3' : (ppm < 100000 ? 'PCB - Grupo 2' : 'PCB - Grupo 1'));
  if (clasif === 'NO PCB') {
    return 'El resultado obtenido de ' + ppm.toFixed(2) + ' ppm de PCB en el aceite dieléctrico indica que el ' +
      'equipo se clasifica como NO PCB, de acuerdo con la Resolución 0222 de 2011, al presentar una ' +
      'concentración inferior a 50 ppm. No se evidencia presencia significativa de PCB en el aceite ' +
      'analizado, y el equipo puede continuar en operación, manteniendo las medidas de gestión y control ' +
      'establecidas en el programa ambiental de la empresa.';
  }
  return 'El resultado obtenido de ' + ppm.toFixed(2) + ' ppm de PCB en el aceite dieléctrico clasifica el ' +
    'equipo como ' + clasif + ', de acuerdo con la Resolución 0222 de 2011, al superar el límite de 50 ppm. ' +
    'Se recomienda activar la gestión ambiental correspondiente y evitar la manipulación no controlada del ' +
    'aceite hasta definir su disposición conforme a la normatividad aplicable.';
}

/** Recomendaciones PCB — texto estándar ligado al resultado (contaminado/
 *  no contaminado), mismo criterio que Fisicoquímico. */
function buildOilPcbRecomendacionesText_(section) {
  var contaminado = section.totalPcbPpm >= section.limitePpm;
  if (contaminado) {
    return [
      'Activar la gestión ambiental correspondiente según la Resolución 0222 de 2011.',
      'Evitar la manipulación no controlada del aceite.',
      'Identificar el equipo en el inventario de equipos con PCB.',
      'Consultar los procedimientos de manejo, almacenamiento, transporte y disposición final con un gestor autorizado, según la normatividad aplicable.'
    ];
  }
  return [
    'Mantener la identificación del equipo con su resultado de PCB.',
    'Conservar la trazabilidad de los análisis realizados.',
    'Continuar con el programa de mantenimiento y monitoreo del aceite.',
    'Gestionar el equipo conforme a los procedimientos ambientales de la empresa.'
  ];
}

/** Ronda 10 (2026-09-26) — HALLAZGO REAL, confirmado por el usuario con
 *  el PDF real y verificado con un informe de prueba: "2. INFORMACIÓN DE
 *  LA MUESTRA" (emparejada, 270pt) quedaba más angosta que las tablas de
 *  ancho completo de al lado ("3. RESULTADOS...", "6. RECOMENDACIONES",
 *  etc.), dejando un hueco visible a la derecha. La tabla EXTERNA (2
 *  columnas) se auto-dimensiona a partir de TODAS sus filas — las filas
 *  emparejadas (Sección 1/2, y 4/5, 9/10) declaran 270+270=540pt en
 *  total, así que ESE es el ancho real que gobierna la tabla maestra en
 *  Aceite, no 560pt (que sí es el total correcto para el Eléctrico,
 *  donde SECTION1_THREE_COL_WIDTHS_PT_/SECTION12_FIVE_COL_WIDTHS_PT_ son
 *  las que de verdad gobiernan ahí — cada informe tiene su propio total
 *  real, no hay una constante universal). Cualquier fila de ancho
 *  completo tiene que declarar el MISMO total (540pt) para no dejar
 *  hueco. Un bloque fusionado no muestra columnas visibles, así que la
 *  proporción individual entre las 7 no importa, solo la SUMA. */
var OIL_FULL_WIDTH_COLS_PT_ = [77, 77, 77, 77, 77, 77, 78];
/** Firmas de Aceite — mismas proporciones relativas que
 *  SECTION12_FIVE_COL_WIDTHS_PT_ (Probado/Revisado/Aprobado/QR) pero
 *  reescaladas a 540pt en vez de 566pt (mismo motivo que
 *  OIL_FULL_WIDTH_COLS_PT_ arriba — 540 es el total real que gobierna la
 *  tabla maestra de Aceite). Un array propio, nunca se toca
 *  SECTION12_FIVE_COL_WIDTHS_PT_ — esa sigue siendo la correcta para el
 *  Eléctrico, que gobierna su tabla maestra con 560pt, no 540pt. */
var OIL_FIRMAS_COL_WIDTHS_PT_ = [135, 135, 135, 68, 67];

/** Bloque de texto (interpretación o recomendaciones) dentro de la tabla
 *  única — una sola celda fusionada, igual criterio que "Objetivo y
 *  Alcance"/"Observaciones" del Eléctrico. `lines` puede ser un string
 *  (párrafo) o un arreglo (lista numerada, unida con saltos de línea
 *  reales dentro de la misma celda). `fullWidth` (default false): true
 *  cuando este bloque va SOLO a todo el ancho (Recomendaciones) — ronda 9
 *  encontró en la verificación en vivo que reusar el ancho de 270pt
 *  (pensado para ir emparejado, como Interpretación con Criterios) en un
 *  bloque de ancho completo dejaba una mitad de la página en blanco. */
function buildOilTextBlockRows_(bannerText, lines, fullWidth) {
  var rows = [unifiedBannerRow_(bannerText)];
  var fullMerge = [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }];
  var text = Array.isArray(lines) ? lines.map(function (l, i) { return (i + 1) + '. ' + l; }).join('\n') : lines;
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = text;
  rows.push(unifiedRow_(cells, 'data', fullMerge));
  rows.colWidths = fullWidth ? OIL_FULL_WIDTH_COLS_PT_ : TTR_WINDING_COL_WIDTHS_PT_;
  return rows;
}

/** Conclusión general — mismo tratamiento visual que buildConclusionRows_
 *  del Eléctrico (celda única, coloreada), pero SIN asumir que "aprobado"
 *  siempre empieza con el texto "APROBADO": los veredictos reales de
 *  Aceite incluyen "No contaminado" (PCB), "APROBADO (datos parciales)"
 *  (Fisicoquímico), o "REGISTRADO" (solo DGA) — se usa verdictColor_, que
 *  YA clasifica cualquiera de estos correctamente. Va a todo el ancho
 *  (nunca emparejada — a diferencia de la del Eléctrico, que siempre va
 *  al lado de Observaciones), por eso usa OIL_FULL_WIDTH_COLS_PT_, no
 *  TTR_WINDING_COL_WIDTHS_PT_. */
function buildOilConclusionRows_(overallVerdict) {
  var rows = [unifiedBannerRow_('CONCLUSIÓN GENERAL')];
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = String(overallVerdict || '—');
  var row = unifiedRow_(cells, 'legend', [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }]);
  var vcolors = verdictColor_(overallVerdict);
  row.coloredCols = [{ col: 0, bg: vcolors.bg, fg: vcolors.text }];
  row.fontSizeOverride = 9;
  rows.push(row);
  rows.colWidths = OIL_FULL_WIDTH_COLS_PT_;
  return rows;
}

/** Protocolo único de Aceite Dieléctrico — reemplaza generateOilTestReportPdf_
 *  (ronda 9, 2026-09-26). Mismo criterio de "tabla única" que
 *  regenerateElectricalCombinedReport_: 1, 2 o 3 secciones (Fisicoquímico/
 *  DGA/PCB) según qué esté realmente activo, reusando la MISMA plantilla
 *  con header/footer/watermark ya migrados (ver
 *  migrateOilTemplateFromElectrical_) y el MISMO mecanismo de firmas+QR
 *  de autenticidad (buildFirmasUnifiedRows_/DOCUMENTOS/
 *  verificarInformeElectrico_ — genérico por categoría, nunca exclusivo
 *  de Eléctrico pese al nombre). `rawReadings`/`calculated`/`testMeta`
 *  traen exactamente la misma forma que ya arma certifyTest_. */
function regenerateOilCombinedReport_(transformer, site, rawReadings, calculated, testMeta, folderId) {
  var templateId = getOilTemplateFileId_();
  if (!templateId) throw new Error('No existe la plantilla del informe de aceite — genera las plantillas primero desde Administración.');

  var copy = DriveApp.getFileById(templateId).makeCopy('tmp_informe_aceite_' + Date.now());
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();

  var n = 1;
  var outerRows = [];
  var sections = calculated.sections || {};

  outerRows.push(outerNestedPairRow_(
    numberSection_(buildOilClientEquipoRows_(site, transformer), n++),
    numberSection_(buildOilMuestraRows_(testMeta, rawReadings), n++)
  ));

  if (sections.fisicoquimico) {
    var fq = sections.fisicoquimico;
    var fqRows = numberSection_(buildOilFisicoquimicoRows_(rawReadings), n++);
    fqRows.push(nestedVerdictRow_('Veredicto Fisicoquímico', fq.verdict));
    outerRows.push(outerNestedFullRow_(fqRows));

    outerRows.push(outerNestedPairRow_(
      numberSection_(buildOilTextBlockRows_('INTERPRETACIÓN DE RESULTADOS', buildOilFisicoquimicoInterpretacionText_(rawReadings, fq)), n++),
      numberSection_(buildOilCriteriosReferenciaRows_(), n++)
    ));
    outerRows.push(outerNestedFullRow_(numberSection_(buildOilTextBlockRows_('RECOMENDACIONES', buildOilFisicoquimicoRecomendacionesText_(fq), true), n++)));
  }

  if (sections.dga) {
    outerRows.push(outerNestedFullRow_(numberSection_(buildOilDgaRows_(rawReadings), n++)));
  }

  if (sections.pcb) {
    var pcb = sections.pcb;
    var pcbRows = numberSection_(buildOilPcbRows_(pcb), n++);
    pcbRows.push(nestedVerdictRow_('Veredicto PCB', pcb.verdict));
    outerRows.push(outerNestedFullRow_(pcbRows));

    outerRows.push(outerNestedPairRow_(
      numberSection_(buildOilPcbClasificacionRows_(pcb), n++),
      numberSection_(buildOilTextBlockRows_('INTERPRETACIÓN TÉCNICA', buildOilPcbInterpretacionText_(pcb)), n++)
    ));
    outerRows.push(outerNestedFullRow_(numberSection_(buildOilTextBlockRows_('RECOMENDACIONES', buildOilPcbRecomendacionesText_(pcb), true), n++)));
  }

  // Ronda 9c/9d (2026-09-26) — HALLAZGO REAL confirmado por el usuario con
  // el PDF real: cuando el protocolo se va a 2 páginas (los 3 análisis a
  // la vez — caso raro, según el usuario), la fila de FIRMAS quedaba
  // PARTIDA entre la página 1 y la 2 — Docs renderiza el texto de esa
  // fila en la página 1 (montado sobre el pie de página) y las imágenes
  // (firma/QR) en la página 2 (montadas sobre el encabezado) — mismo bug
  // ya documentado en la ronda 6 del Eléctrico para filas con imágenes
  // que no caben enteras, nunca antes disparado en Aceite porque hasta
  // ahora nunca había desbordado a 2 páginas. Unir Conclusión+Firmas en
  // una sola tabla anidada (intento de la ronda 9c) NO alcanzó — Docs
  // sigue partiendo fila por fila DENTRO de esa tabla igual. El usuario
  // pidió explícitamente resolverlo separando estas 2 secciones a su
  // propia página cuando son los 3 análisis — la única forma real de
  // lograr esto con DocumentApp es un salto de página EXPLÍCITO
  // (`body.insertPageBreak`), que solo puede ir a nivel de BODY, nunca
  // dentro de una tabla — así que esto exige una SEGUNDA tabla externa
  // separada (ver más abajo, `isTripleCase`), no una fila más de la
  // misma. En cualquier otro caso (1 o 2 secciones — la gran mayoría,
  // según el usuario) todo sigue en una sola tabla continua, sin cambios.
  var isTripleCase = !!(sections.fisicoquimico && sections.dga && sections.pcb);
  var verificationId = generateId_();
  var verificationUrl = ScriptApp.getService().getUrl() + '?verificar=' + verificationId;
  var qrBlob = getQrCodeBlob_(verificationUrl);
  var probadoPorNombre = testMeta.operador_nombre || testMeta.tested_by || '—';

  var conclusionRows = numberSection_(buildOilConclusionRows_(calculated.overallVerdict), n++);
  var firmaRows = numberSection_(buildFirmasUnifiedRows_(
    { nombre: probadoPorNombre, fecha: testMeta.created_at },
    { nombre: ENGINEER_SIGNATURE_NAME_, fecha: testMeta.revisado_at }
  ), n++);
  var conclusionAndFirmaRows = conclusionRows.concat(firmaRows);
  // Ronda 8m ya había encontrado esto mismo con `criteriaRows`: `concat()`
  // devuelve un arreglo NUEVO que no hereda `colWidths` de los originales
  // — se vuelve a poner a mano. El de Firmas (OIL_FIRMAS_COL_WIDTHS_PT_,
  // 5 columnas físicas reales) se preserva porque SÍ importan sus
  // proporciones internas; el de Conclusión no (es una sola celda
  // fusionada, cualquier reparto de columnas se ve igual).
  conclusionAndFirmaRows.colWidths = OIL_FIRMAS_COL_WIDTHS_PT_;
  var conclusionAndFirmaRow = outerNestedFullRow_(conclusionAndFirmaRows, function (nestedTable) {
    // Ronda 9g/9h (2026-09-26) — 2 intentos con un párrafo vacío entre el
    // salto de página y esta tabla (`setSpacingBefore`, después
    // `setFontSize` para el alto de línea) NO tuvieron efecto — Google
    // Docs colapsa/ignora cualquier párrafo de solo espacio en blanco
    // justo antes de una tabla. Un 3er intento (padding en la celda del
    // banner "CONCLUSIÓN GENERAL") sí bajó la tabla, pero dejó una caja
    // azul vacía fea encima del texto (el padding se ve con el MISMO
    // fondo de color de la celda, ver captura real). El espacio en
    // blanco tiene que vivir en la celda EXTERIOR (blanca, sin fondo) que
    // contiene esta tabla anidada, no dentro de la celda de color —
    // `nestedTable.getParent()` es esa celda exterior (la de la tabla
    // MAESTRA, la misma que ya se deja con padding 0 en
    // `zeroOuterCellPadding_` — acá se le agrega el padding de vuelta,
    // solo arriba, solo para esta tabla puntual).
    if (isTripleCase) {
      var outerCell = nestedTable.getParent().asTableCell();
      outerCell.setPaddingTop(57);
    }
    // Firmas ya no empieza en la fila 0 de esta tabla anidada — Conclusión
    // ocupa las filas 0 (banner) y 1 (dato); Firmas pasa a 2 (banner), 3
    // (encabezado), 4 (dato) — antes, sola en su propia tabla, la fila de
    // dato estaba en el índice 2.
    var dataRowRef = nestedTable.getRow(4);
    for (var fc = 0; fc < dataRowRef.getNumCells(); fc++) {
      dataRowRef.getCell(fc).setVerticalAlignment(DocumentApp.VerticalAlignment.CENTER);
    }
    function fillNameDateCell_(cell, nombre, fecha) {
      var nameLine = cell.appendParagraph(nombre || '—');
      nameLine.editAsText().setBold(true).setFontSize(10).setFontFamily(PROTOCOL_FONT_FAMILY_);
      nameLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
      var dateLine = cell.appendParagraph(fmtDatePdf_(fecha));
      dateLine.editAsText().setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED).setFontFamily(PROTOCOL_FONT_FAMILY_);
      dateLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
      if (cell.getNumChildren() > 2 && cell.getChild(0).getType() === DocumentApp.ElementType.PARAGRAPH && cell.getChild(0).asParagraph().getText() === '') {
        cell.removeChild(cell.getChild(0));
      }
    }
    fillNameDateCell_(dataRowRef.getCell(0), probadoPorNombre, testMeta.created_at);
    fillNameDateCell_(dataRowRef.getCell(1), ENGINEER_SIGNATURE_NAME_, testMeta.revisado_at);

    var sigCell = dataRowRef.getCell(2);
    var engineerBlob = getEngineerSignatureBlob_();
    if (engineerBlob) {
      var simg = sigCell.appendImage(engineerBlob);
      var sratio = simg.getHeight() / simg.getWidth();
      simg.setWidth(80);
      simg.setHeight(Math.round(80 * sratio));
      simg.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    }
    var snameLine = sigCell.appendParagraph(ENGINEER_SIGNATURE_NAME_);
    snameLine.editAsText().setBold(true).setFontSize(10).setFontFamily(PROTOCOL_FONT_FAMILY_);
    snameLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
    var stitleLine = sigCell.appendParagraph(ENGINEER_SIGNATURE_TITLE_);
    stitleLine.editAsText().setFontSize(8).setForegroundColor(PDF_COLORS_.TEXT_MUTED).setFontFamily(PROTOCOL_FONT_FAMILY_);
    stitleLine.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);

    var qrImgCell = dataRowRef.getCell(3);
    if (qrBlob) {
      var qimg = qrImgCell.appendImage(qrBlob);
      qimg.setWidth(100);
      qimg.setHeight(100);
      qimg.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    } else {
      var noQr = qrImgCell.appendParagraph('—');
      noQr.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
    }
  });

  var tablePlaceholderPar = findMarkerParagraph_(body, '<<TABLA_RESULTADOS_ACEITE>>');
  if (!tablePlaceholderPar) throw new Error('La plantilla de Aceite no tiene el marcador de la tabla de resultados — corre "Migrar plantilla de Aceite" desde Administración.');

  var tableResults = [];
  if (isTripleCase) {
    // Tabla 1: todo hasta Recomendaciones de PCB (sin Conclusión/Firmas).
    var mainResult = insertOuterResultsTable_(body, tablePlaceholderPar, outerRows);
    body.removeChild(tablePlaceholderPar);
    tableResults.push(mainResult);

    // Salto de página EXPLÍCITO (a pedido del usuario, solo para este
    // caso raro) + Tabla 2: Conclusión + Firmas, arrancando limpias en la
    // página siguiente — nunca más partidas a la mitad. `insertPageBreak`
    // es a nivel BODY, después de la tabla 1 (que termina justo antes del
    // marcador que se acaba de borrar); se necesita un marcador temporal
    // nuevo para poder reusar insertOuterResultsTable_ tal cual.
    var pageBreakIndex = body.getChildIndex(mainResult.table) + 1;
    body.insertPageBreak(pageBreakIndex);
    // Ronda 9e/9f (2026-09-26) — 2 intentos de agregar un párrafo de
    // separación ENTRE el salto de página y la tabla (spacingBefore,
    // luego fontSize de línea) no funcionaron — ver el porqué en el
    // comentario de `conclusionAndFirmaRow` más arriba: el ~1cm pedido se
    // aplica ahí, como padding de la celda del banner, no acá.
    var tailMarkerPar = body.insertParagraph(pageBreakIndex + 1, '<<TABLA_ACEITE_CIERRE>>');
    tailMarkerPar.editAsText().setFontSize(1);
    var tailResult = insertOuterResultsTable_(body, tailMarkerPar, [conclusionAndFirmaRow]);
    body.removeChild(tailMarkerPar);
    // Ronda 9k (2026-09-26) — a pedido explícito del usuario, confirmado
    // con el PDF real: se veía un rectángulo gris (el borde de ESTA
    // tabla EXTERNA, la de cierre) con el lado de arriba montado sobre
    // el encabezado — como esta tabla externa solo tiene 1 fila (la de
    // Conclusión+Firmas), su borde completo queda pegado arriba de esa
    // única fila, antes del padding de separación. La tabla anidada de
    // adentro (la que de verdad importa visualmente — las cajas de
    // "CONCLUSIÓN GENERAL"/"ÁREA DE CONTROL DE CALIDAD") ya tiene su
    // propio borde, así que quitarle el borde a esta envolvente no
    // pierde nada.
    tailResult.table.setBorderWidth(0);
    tableResults.push(tailResult);
  } else {
    outerRows.push(conclusionAndFirmaRow);
    var singleResult = insertOuterResultsTable_(body, tablePlaceholderPar, outerRows);
    body.removeChild(tablePlaceholderPar);
    tableResults.push(singleResult);
  }

  var fileName = 'Informe_Aceite_' + transformer.serial_number + '_' + fmtTimestampForFilename_(new Date());
  var saved = finalizeReportPdf_(doc, folderId, fileName, tableResults.map(function (tr) {
    return { outerMarkerText: tr.outerMarkerText, outerMergeSpecs: tr.outerMergeSpecs, nestedRegistry: tr.nestedRegistry };
  }));

  appendRow_('DOCUMENTOS', {
    id: verificationId,
    site_id: transformer.site_id,
    category: 'CERTIFICADOS',
    file_name: fileName,
    file_id: saved.fileId,
    mime_type: 'application/pdf',
    uploaded_by: probadoPorNombre,
    created_at: new Date().toISOString(),
    transformer_id: transformer.id,
    verdict: calculated.overallVerdict,
    certified_by: ENGINEER_SIGNATURE_NAME_
  });

  return saved;
}

/** Ancho total real (pt) del Informe de Historial — la plantilla es una
 *  copia de la Eléctrica (ver migrateHistoryTemplateFromElectrical_), así
 *  que hereda sus mismos márgenes; 560pt es el mismo total que gobierna la
 *  Sección 1 del Eléctrico (SECTION1_THREE_COL_WIDTHS_PT_). Un array
 *  PROPIO, nunca se reusa OIL_FULL_WIDTH_COLS_PT_ (540, el total real de
 *  Aceite) — mismo criterio ya aprendido con el bug de desalineación de
 *  Aceite: cada informe tiene su propio total real, nunca se asume el de
 *  otro. */
var HISTORY_INFO_COL_WIDTHS_PT_ = [80, 80, 80, 80, 80, 80, 80];

/** Grilla etiqueta/valor de "Datos del cliente y del equipo" del Informe de
 *  Historial — mismo patrón que buildOilDenseInfoRows_ (2 campos por fila)
 *  pero con su PROPIO ancho total (ver HISTORY_INFO_COL_WIDTHS_PT_ arriba):
 *  no se reusa buildOilDenseInfoRows_ directamente porque esa función tiene
 *  hardcodeado el ancho de 270pt (pensado para ir emparejada con otra
 *  grilla al lado), y acá esta sección va sola, a todo el ancho. */
function buildHistoryInfoRows_(bannerText, fields) {
  var rows = [unifiedBannerRow_(bannerText)];
  var merges = [{ startColumnIndex: 1, columnSpan: 2 }, { startColumnIndex: 4, columnSpan: 3 }];
  for (var i = 0; i < fields.length; i += 2) {
    var left = fields[i];
    var right = fields[i + 1] || ['', ''];
    rows.push(unifiedLabelRow_([left[0], left[1], '', right[0], right[1], '', ''], [0, 3], merges));
  }
  rows.colWidths = HISTORY_INFO_COL_WIDTHS_PT_;
  return rows;
}

/** Bloque de texto a todo el ancho del Informe de Historial — mismo
 *  criterio que buildOilTextBlockRows_(..., true), pero con el ancho propio
 *  de este informe (ver HISTORY_INFO_COL_WIDTHS_PT_). Usado solo para el
 *  aviso de "sin TAP nominal definido" y el de "sin datos suficientes". */
function buildHistoryTextBlockRows_(bannerText, text) {
  var rows = [unifiedBannerRow_(bannerText)];
  var fullMerge = [{ startColumnIndex: 0, columnSpan: UNIFIED_TABLE_COLS_ }];
  var cells = new Array(UNIFIED_TABLE_COLS_).fill('');
  cells[0] = text;
  rows.push(unifiedRow_(cells, 'data', fullMerge));
  rows.colWidths = HISTORY_INFO_COL_WIDTHS_PT_;
  return rows;
}

/**
 * Informe de Historial de Pruebas (2026-09-29) — PRIMER "informe standalone"
 * de la app, distinto de los 2 patrones que ya existían (panel embebido sin
 * PDF / PDF de certificación por protocolo): agrega TODAS las pruebas
 * Certificadas de un transformador, sin importar el año, y arma un PDF con
 * las mismas 2 tendencias que ya se ven en pantalla (Aislamiento DAR/IP,
 * Aceite rigidez/acidez — ver renderYearlyBehaviorChart_ en app.js) MÁS 2
 * tendencias nuevas que no existían en ningún lado (TTR y Resistencia de
 * Devanados, ambas fijas en la posición de TAP nominal del equipo, para
 * comparar siempre el mismo punto de operación entre años).
 *
 * A propósito NO lleva QR de autenticidad ni bloque de Firmas: no es un
 * evento de certificación nuevo (no hay un ingeniero aprobando un resultado
 * puntual acá), es una agregación de lectura de resultados que YA fueron
 * certificados individualmente — cada uno de esos informes originales ya
 * tiene su propio QR. Se guarda en DOCUMENTOS como categoría GENERALES (no
 * CERTIFICADOS) por el mismo motivo: verificarInformeElectrico_ exige
 * category === 'CERTIFICADOS', y este informe no debe ser "verificable" por
 * QR porque no tiene ninguno.
 */
function generateYearlyHistoryReportPdf_(transformer, site, folderId, auth) {
  var templateId = getHistoryTemplateFileId_();
  if (!templateId) throw new Error('No existe la plantilla del informe de historial — corre "Migrar plantilla de Historial" desde Administración.');

  var tests = findAllCertifiedTestsByTransformer_(transformer.id);
  if (tests.length === 0) throw new Error('Este equipo todavía no tiene ninguna prueba certificada — no hay historial que mostrar.');

  var grouped = groupTestsByYear_(tests);
  var byYear = grouped.byYear, years = grouped.years;
  // `transformer` acá es la fila cruda (findTransformerRow_, no
  // transformerRowToJson_) — tap_config_json todavía sin parsear, a
  // diferencia de lo que ve el frontend (transformer.tap_config).
  var tapConfig = safeParseJson_(transformer.tap_config_json);
  var nominalTap = transformer.posicion_tap_nominal || (tapConfig && tapConfig.neutralPosition) || null;

  var copy = DriveApp.getFileById(templateId).makeCopy('tmp_informe_historial_' + Date.now());
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();

  var n = 1;
  var outerRows = [];
  var periodoText = years[0] === years[years.length - 1] ? String(years[0]) : (years[0] + ' – ' + years[years.length - 1]);

  outerRows.push(outerNestedFullRow_(numberSection_(buildHistoryInfoRows_('DATOS DEL CLIENTE Y DEL EQUIPO', [
    ['CLIENTE', site.client_name || '—'],
    ['NIT', site.nit || '—'],
    ['PROYECTO', site.project_name || '—'],
    ['FABRICANTE', transformer.manufacturer || '—'],
    ['N° DE SERIE', transformer.serial_number || '—'],
    ['POSICIÓN DE TAP NOMINAL', nominalTap ? ('TAP ' + nominalTap) : 'No definida'],
    ['PERIODO CUBIERTO', periodoText],
    ['TOTAL DE PRUEBAS CERTIFICADAS', String(tests.length)]
  ]), n++)));

  var insulationTrend = computeYearlyInsulationTrend_(byYear, years);
  if (insulationTrend) {
    var insulationColors = [PDF_COLORS_.ACCENT, PDF_COLORS_.DANGER, PDF_COLORS_.WARNING];
    var darChart = buildYearlyTrendChart_('DAR POR COMBINACIÓN DE DEVANADO', years, insulationTrend.dar, insulationColors);
    var ipChart = buildYearlyTrendChart_('IP POR COMBINACIÓN DE DEVANADO', years, insulationTrend.ip, insulationColors);
    outerRows.push(outerImagesPairRow_(
      n++ + '. RESISTENCIA DE AISLAMIENTO — TENDENCIA ANUAL',
      [{ blob: darChart, widthPt: 260, heightPt: 200 }, { blob: ipChart, widthPt: 260, heightPt: 200 }],
      null
    ));
  }

  var oilTrend = computeYearlyOilTrend_(byYear, years);
  if (oilTrend) {
    var rigidezChart = buildYearlyTrendChart_('RIGIDEZ DIELÉCTRICA PROMEDIO (kV)', years, { 'Rigidez (kV)': oilTrend.rigidez }, [PDF_COLORS_.ACCENT]);
    var acidezChart = buildYearlyTrendChart_('NÚMERO DE ACIDEZ PROMEDIO (mg KOH/g)', years, { 'Acidez (mg KOH/g)': oilTrend.acidez }, [PDF_COLORS_.DANGER]);
    outerRows.push(outerImagesPairRow_(
      n++ + '. ACEITE DIELÉCTRICO — TENDENCIA ANUAL',
      [{ blob: rigidezChart, widthPt: 260, heightPt: 200 }, { blob: acidezChart, widthPt: 260, heightPt: 200 }],
      null
    ));
  }

  if (nominalTap != null) {
    var tapPhaseColors = [PDF_COLORS_.ACCENT, PDF_COLORS_.DANGER, PDF_COLORS_.WARNING];
    var ttrTrend = computeYearlyTapPhaseTrend_(byYear, years, 'TTR', function (calc) {
      var tap = calc.taps && calc.taps[String(nominalTap)];
      if (!tap || !tap.phases) return null;
      var out = {};
      Object.keys(tap.phases).forEach(function (pk) { out[pk] = tap.phases[pk].measuredRatio; });
      return out;
    });
    var windingTrend = computeYearlyTapPhaseTrend_(byYear, years, 'RESISTENCIA_DEVANADOS', function (calc) {
      var taps = calc.taps || [];
      var entry = null;
      for (var i = 0; i < taps.length; i++) { if (taps[i].tapPosition === nominalTap) { entry = taps[i]; break; } }
      if (!entry || !entry.phases) return null;
      var out = {};
      Object.keys(entry.phases).forEach(function (pk) { out[pk] = entry.phases[pk].resistanceOhm; });
      return out;
    });
    if (ttrTrend || windingTrend) {
      var images = [];
      if (ttrTrend) images.push({ blob: buildYearlyTrendChart_('TTR — RELACIÓN MEDIDA EN TAP ' + nominalTap, years, ttrTrend, tapPhaseColors), widthPt: 260, heightPt: 200 });
      if (windingTrend) images.push({ blob: buildYearlyTrendChart_('RESISTENCIA DE DEVANADOS EN TAP ' + nominalTap + ' (Ω)', years, windingTrend, tapPhaseColors), widthPt: 260, heightPt: 200 });
      outerRows.push(outerImagesPairRow_(n++ + '. TTR Y RESISTENCIA DE DEVANADOS EN TAP NOMINAL — TENDENCIA ANUAL', images, null));
    }
  } else {
    outerRows.push(outerNestedFullRow_(numberSection_(buildHistoryTextBlockRows_('TTR Y RESISTENCIA DE DEVANADOS EN TAP NOMINAL',
      'No fue posible determinar la posición de TAP nominal de este equipo — configúrela desde "Editar equipo" para incluir esta tendencia en el próximo informe.'
    ), n++)));
  }

  if (outerRows.length === 1) {
    outerRows.push(outerNestedFullRow_(numberSection_(buildHistoryTextBlockRows_('TENDENCIAS',
      'No hay suficientes datos numéricos en las pruebas certificadas de este equipo para construir ninguna gráfica de tendencia todavía.'
    ), n++)));
  }

  var contentPlaceholderPar = findMarkerParagraph_(body, '<<CONTENIDO_HISTORIAL>>');
  if (!contentPlaceholderPar) throw new Error('La plantilla de Historial no tiene su marcador — corre "Migrar plantilla de Historial" desde Administración.');
  var tableResult = insertOuterResultsTable_(body, contentPlaceholderPar, outerRows);
  body.removeChild(contentPlaceholderPar);

  var fileName = 'Informe_Historial_' + transformer.serial_number + '_' + fmtTimestampForFilename_(new Date());
  var saved = finalizeReportPdf_(doc, folderId, fileName, { outerMarkerText: tableResult.outerMarkerText, outerMergeSpecs: tableResult.outerMergeSpecs, nestedRegistry: tableResult.nestedRegistry });

  appendRow_('DOCUMENTOS', {
    id: generateId_(),
    site_id: transformer.site_id,
    category: 'GENERALES',
    file_name: fileName,
    file_id: saved.fileId,
    mime_type: 'application/pdf',
    uploaded_by: (auth && auth.username) || 'sistema',
    created_at: new Date().toISOString()
  });

  return saved;
}

/** Acción POST — sin restricción de rol a propósito: no certifica nada
 *  nuevo, solo agrega resultados que YA fueron certificados por un
 *  Supervisor/Administrador; un Técnico puede generarlo igual que puede ver
 *  el panel "Comportamiento anual" en pantalla. */
function generateYearlyHistoryReport_(params, auth) {
  return withLock_(function () {
    if (!params.transformer_id) return jsonResponse_({ status: 400, message: 'transformer_id es obligatorio' });
    var transformer = findTransformerRow_(params.transformer_id);
    if (!transformer) return jsonResponse_({ status: 404, message: 'Transformador no encontrado' });
    var site = findSiteRow_(transformer.site_id);
    if (!site) return jsonResponse_({ status: 404, message: 'Cliente/Proyecto no encontrado' });
    var folders = ensureSiteFolders_(site);
    try {
      var saved = generateYearlyHistoryReportPdf_(transformer, site, folders.documentosFolderId, auth);
      return jsonResponse_({ status: 200, message: 'Informe de historial generado', data: { report_url: saved.url } });
    } catch (e) {
      return jsonResponse_({ status: 400, message: e.message || 'No se pudo generar el informe de historial' });
    }
  });
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
  // Ronda 9c (2026-09-26) — Aceite, caso de los 3 análisis a la vez:
  // `unifiedTableMerge` puede venir como un ARREGLO (más de una tabla
  // externa en el mismo documento, ver regenerateOilCombinedReport_ — un
  // salto de página forzado entre "Conclusión + Firmas" y el resto exige
  // 2 tablas externas separadas, no 1 continua) — Eléctrico sigue
  // pasando un solo objeto, sin cambios.
  var merges = Array.isArray(unifiedTableMerge) ? unifiedTableMerge : (unifiedTableMerge ? [unifiedTableMerge] : []);
  merges.forEach(function (m) {
    try { applyOuterAndNestedMerges_(doc.getId(), m.outerMarkerText, m.outerMergeSpecs, m.nestedRegistry); }
    catch (mergeErr) { /* No relanzar — el PDF igual se genera, solo sin fusionar celdas. */ }
  });
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
  debugInspectTemplateBody: debugInspectTemplateBody_,
  fixElectricalTemplateTitleOrder: fixElectricalTemplateTitleOrder_,
  removeElectricalTemplateBakedSignature: removeElectricalTemplateBakedSignature_,
  compactElectricalTemplateTitleBox: compactElectricalTemplateTitleBox_,
  setReportTemplatesPageSize: setReportTemplatesPageSize_,
  migrateOilTemplateFromElectrical: migrateOilTemplateFromElectrical_,
  migrateHistoryTemplateFromElectrical: migrateHistoryTemplateFromElectrical_,
  generateYearlyHistoryReport: generateYearlyHistoryReport_,
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
  listCalibraciones: listCalibraciones_,
  getReportTemplateUrls: getReportTemplateUrls_
};
