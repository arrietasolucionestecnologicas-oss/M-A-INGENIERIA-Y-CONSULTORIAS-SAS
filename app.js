'use strict';

/* ============================================================
   M&A Gestión de Pruebas — app.js
   Lógica de UI + cliente HTTP contra el backend Apps Script
   (backend-apps-script/Código.gs).
   ============================================================ */

// ---------------------------------------------------------------
// Configuración de conexión
// ---------------------------------------------------------------

/** Backend propio de M&A (transformadores/pruebas). Termina en /exec. */
const API_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbz1frJeBe7KpN83DQaVjtPBfzWtdujl6mngBAmAe3XCLRBW6_5cEShkVPRwgk98UtbKAw/exec";

/** Servicio de autenticación: login, cambio de contraseña, creación de usuarios. */
const CONTROL_ACCESO_URL = "https://script.google.com/macros/s/AKfycby4K-qxW87hfd9Fy1wKHeyF8bic_Qo8clKfJ-ZuPg9zElNuc7XOe8qTgW8sUmJ9mnKjDA/exec";

/** Identificador de esta app dentro de Control de Acceso (fila en la hoja Config). */
const APP_ID = "MYA_PRUEBAS";

const TOLERANCE_PERCENT = 0.5;
const UNBALANCE_THRESHOLD = 5.0;

/** Debe reflejar exactamente los umbrales de calculateOilAnalysis_ en Código.gs. */
const OIL_ACIDEZ_MAX = 0.15;
const OIL_TENSION_INTERFACIAL_MIN = 24;
const OIL_RIGIDEZ_MIN = 30;
const OIL_HUMEDAD_MAX = 35;
const OIL_PCB_LIMITE_PPM = 50; // Res. 222 de 2011, MinAmbiente

const OIL_DGA_GASES = [
  { key: 'h2', label: 'Hidrógeno (H₂)' },
  { key: 'o2', label: 'Oxígeno (O₂)' },
  { key: 'n2', label: 'Nitrógeno (N₂)' },
  { key: 'ch4', label: 'Metano (CH₄)' },
  { key: 'co', label: 'Monóxido de carbono (CO)' },
  { key: 'co2', label: 'Dióxido de carbono (CO₂)' },
  { key: 'c2h2', label: 'Acetileno (C₂H₂)' },
  { key: 'c2h4', label: 'Etileno (C₂H₄)' },
  { key: 'c2h6', label: 'Etano (C₂H₆)' }
];

const OIL_PCB_AROCLORES = ['aroclor_1016', 'aroclor_1221', 'aroclor_1232', 'aroclor_1242', 'aroclor_1248', 'aroclor_1254', 'aroclor_1260'];

// ---------------------------------------------------------------
// Estado global de la aplicación
// ---------------------------------------------------------------

var state = {
  token: null,
  username: null,
  role: null,
  allowedApps: [],
  pendingOldUsuario: null,
  pendingOldPassword: null,
  sites: [],
  currentSiteId: null,
  currentSite: null,
  transformers: [],
  currentTransformerId: null,
  currentTransformer: null,
  currentTests: [],
  pendingContextTarget: null,
  ttr: { currentTap: null, readings: {} },
  matrix: { taps: [] },
  wr: { currentTap: null, readings: {} },
  oil: { rigidez: null, humedad: null, acidez: null, tension: null },
  insulation: { windingTemperatureC: 20, phases: {} }
};

/** "12,5" -> 12.5. parseFloat NUNCA debe usarse directo sobre un input de usuario: se detiene en la coma y trunca el valor sin avisar. */
function parseDecimal_(value) {
  if (value === null || value === undefined) return NaN;
  return parseFloat(String(value).trim().replace(',', '.'));
}

// ---------------------------------------------------------------
// Cliente HTTP contra Apps Script
//
// Dos particularidades del Web App que este cliente absorbe:
//  1. El transporte SIEMPRE responde 200 (Apps Script no permite fijar un
//     código de estado real) — el estado real viaja en body.status.
//  2. El POST usa Content-Type: text/plain;charset=utf-8 para evitar el
//     preflight de CORS al llamar desde GitHub Pages hacia script.google.com;
//     Código.gs parsea el cuerpo como JSON sin depender del content-type.
// ---------------------------------------------------------------

function ApiError(status, message) {
  this.name = 'ApiError';
  this.status = status;
  this.message = message;
}
ApiError.prototype = Object.create(Error.prototype);
ApiError.prototype.constructor = ApiError;

function callApi(action, method, payload) {
  if (!state.token) {
    return Promise.reject(new ApiError(0, 'No hay una sesión activa (token ausente)'));
  }

  var body = Object.assign({ action: action, token: state.token }, payload || {});
  var request;

  if (method === 'GET') {
    var qs = Object.keys(body)
      .filter(function (k) { return body[k] !== undefined && body[k] !== null && typeof body[k] !== 'object'; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(body[k]); })
      .join('&');
    request = fetch(API_WEBHOOK_URL + '?' + qs, { method: 'GET' });
  } else {
    request = fetch(API_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
  }

  return request
    .then(function (res) { return res.json(); })
    .then(function (json) {
      if (json.status === 402) {
        showView('suspended');
        throw new ApiError(402, json.message || 'Servicio suspendido');
      }
      if (json.status === 403) {
        // Token inválido/expirado: no es un problema de facturación, así que se
        // regresa al login (no a la pantalla de "suspendido") con un aviso genérico.
        state.token = null;
        showView('login');
        var loginErr = document.getElementById('loginError');
        if (loginErr) setStatus_(loginErr, 'Tu sesión no es válida o expiró. Vuelve a iniciar sesión.', false, true);
        throw new ApiError(403, json.message || 'Sesión inválida');
      }
      if (json.status >= 400) {
        throw new ApiError(json.status, json.message || ('Error ' + json.status));
      }
      return json.data;
    })
    .catch(function (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, 'No se pudo contactar el backend: ' + err.message);
    });
}

/** Cliente para Control de Acceso (login, changePassword, createUser). Contrato distinto: {ok, ...}, no {status, ...}. */
function callAuthApi(action, payload) {
  var body = Object.assign({ action: action }, payload || {});
  return fetch(CONTROL_ACCESO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  }).then(function (res) { return res.json(); });
}

function mapAuthError_(code) {
  var map = {
    credenciales_incompletas: 'Completa usuario y contraseña',
    credenciales_invalidas: 'Usuario o contraseña incorrectos',
    usuario_inactivo: 'Este usuario está inactivo',
    servicio_suspendido: 'Servicio suspendido',
    datos_incompletos: 'Faltan datos obligatorios',
    password_muy_corta: 'La contraseña debe tener al menos 8 caracteres',
    usuario_ya_existe: 'Ese nombre de usuario ya existe',
    no_autorizado: 'No tienes permiso para esta acción',
    token_invalido: 'Tu sesión expiró, vuelve a iniciar sesión',
    usuario_no_encontrado: 'Usuario no encontrado',
    body_invalido: 'Solicitud inválida',
    accion_no_soportada: 'Acción no soportada'
  };
  return map[code] || code || 'Error desconocido';
}

// ---------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate_(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day: 'numeric' });
}

function verdictPillClass_(verdict) {
  if (verdict === 'APROBADO' || verdict === 'No contaminado') return 'success';
  if (verdict === 'RECHAZADO' || verdict === 'REQUIERE REGENERACIÓN / CAMBIO' || (verdict && verdict.indexOf('Contaminado') === 0)) return 'danger';
  if (verdict === 'OBSERVADO' || verdict === 'REQUIERE TERMOVACÍO') return 'warning';
  return 'neutral'; // incluye 'REGISTRADO' (solo DGA, sin veredicto propio)
}

function setStatus_(el, message, ok, isError) {
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || '';
  el.className = 'status-line' + (isError ? ' error' : (ok ? ' ok' : ''));
}

/** Aviso no bloqueante (patrón local-first): informa el resultado de un guardado
 *  en segundo plano sin interrumpir al técnico. Se retira solo, sin botón de cerrar. */
function showToast_(message, type, duration) {
  var stack = document.getElementById('toastStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toastStack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'success');
  toast.textContent = message;
  stack.appendChild(toast);
  requestAnimationFrame(function () { toast.classList.add('show'); });
  var ms = duration || (type === 'error' ? 5000 : 2800);
  setTimeout(function () {
    toast.classList.remove('show');
    setTimeout(function () { toast.remove(); }, 300);
  }, ms);
}

/** Distingue un fallo de red/conexión de un error de validación del servidor,
 *  y deja explícito que las lecturas ingresadas NO se perdieron (se puede reintentar). */
function formatNetworkAwareError_(err) {
  if (err && err.status === 0) {
    return '⚠ Sin conexión con el servidor. Tus datos NO se perdieron: revisa la señal y presiona el botón de nuevo para reintentar. (' + err.message + ')';
  }
  return err ? err.message : 'Error desconocido';
}

/** Persistencia de borrador en localStorage: protege las lecturas de campo ante
 *  pérdida de conexión, recarga accidental o cierre de pestaña durante una visita. */
function saveDraft_(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { /* almacenamiento no disponible; se ignora */ }
}
function loadDraft_(key) {
  try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function clearDraft_(key) {
  try { localStorage.removeItem(key); } catch (e) { /* almacenamiento no disponible; se ignora */ }
}

/** Persistencia de sesión en `sessionStorage` (NO `localStorage`): sobrevive a
 *  un refresh de página pero muere al cerrar el navegador/pestaña — a
 *  diferencia del caché de listas, esto SÍ debe tener vida corta. */
function saveSession_() {
  try {
    sessionStorage.setItem('mya_session', JSON.stringify({
      token: state.token, username: state.username, role: state.role, allowedApps: state.allowedApps
    }));
  } catch (e) { /* almacenamiento no disponible; se ignora */ }
}
function loadSession_() {
  try { var v = sessionStorage.getItem('mya_session'); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function clearSession_() {
  try { sessionStorage.removeItem('mya_session'); } catch (e) { /* almacenamiento no disponible; se ignora */ }
}

// ---------------------------------------------------------------
// Navegación entre vistas
// ---------------------------------------------------------------

function showView(name) {
  // Requisitos de datos: Equipos exige un Cliente/Proyecto activo; las pruebas
  // exigen un equipo activo. En vez de bloquear con un alert() y redirigir a
  // otra pantalla, se pide el dato que falta en un modal y se continúa aquí
  // mismo apenas se resuelve.
  if (viewNeedsSite_(name) && !state.currentSiteId) {
    openContextModal_('site', name);
    return;
  }
  if (viewNeedsTransformer_(name) && !state.currentTransformer) {
    openContextModal_(state.currentSiteId ? 'equipment' : 'site', name);
    return;
  }

  var isFullscreen = name === 'login' || name === 'suspended' || name === 'change-password';
  document.getElementById('app-shell').style.display = isFullscreen ? 'none' : 'grid';
  document.getElementById('screen-login').hidden = name !== 'login';
  document.getElementById('screen-suspended').hidden = name !== 'suspended';
  document.getElementById('screen-change-password').hidden = name !== 'change-password';

  if (name === 'login') {
    state.token = null;
    state.username = null;
    state.role = null;
    state.currentSiteId = null;
    state.currentSite = null;
    state.currentTransformer = null;
    clearSession_();
    removeAdminNavAndPanel();
    removeRestrictedModuleNav_();
  }

  ['sites', 'dashboard', 'detail', 'ttr-form', 'winding-form', 'oil-form', 'insulation-form', 'calibrations', 'documents', 'commercial', 'general-dashboard', 'admin'].forEach(function (v) {
    var el = document.getElementById('view-' + v);
    if (el) el.hidden = (name !== v);
  });

  document.querySelectorAll('.nav-item[data-view], .bottom-nav-item[data-view]').forEach(function (el) {
    el.classList.toggle('active', el.dataset.view === name);
  });
  closeActionSheet_('testActionSheet');
  closeActionSheet_('moreActionSheet');
  window.scrollTo(0, 0);

  if (name === 'ttr-form') { renderTtrFormContext(); renderMatrixRows(); refreshTtr(); }
  if (name === 'winding-form') { renderWindingFormContext(); refreshWinding(); }
  if (name === 'oil-form') { renderOilFormContext(); refreshOil(); }
  if (name === 'insulation-form') { renderInsulationFormContext(); refreshInsulation(); }
}

function viewNeedsSite_(name) {
  return name === 'dashboard';
}
function viewNeedsTransformer_(name) {
  return name === 'ttr-form' || name === 'winding-form' || name === 'oil-form' || name === 'insulation-form';
}

// ---------------------------------------------------------------
// Modal de contexto: pide Cliente/Proyecto y/o Equipo cuando faltan,
// sin sacar al técnico de donde estaba (reemplaza el redirect a una
// pantalla separada).
// ---------------------------------------------------------------

function openContextModal_(mode, targetView) {
  closeActionSheet_('testActionSheet');
  closeActionSheet_('moreActionSheet');
  state.pendingContextTarget = targetView;
  document.getElementById('contextModalTitle').textContent =
    mode === 'site' ? 'Selecciona Cliente / Proyecto' : 'Selecciona el equipo';
  var body = document.getElementById('contextModalBody');
  document.getElementById('contextModal').classList.add('open');
  document.getElementById('contextModalBackdrop').classList.add('open');

  var trfCacheKey = 'mya_cache_transformers_' + state.currentSiteId;
  var cached = mode === 'site' ? loadDraft_('mya_cache_sites') : loadDraft_(trfCacheKey);
  if (cached) {
    if (mode === 'site') { state.sites = cached; renderContextSiteBody_(); }
    else { state.transformers = cached; renderContextEquipmentBody_(); }
  } else {
    body.innerHTML = '<div class="empty-note">Cargando…</div>';
  }

  var loader = mode === 'site'
    ? callApi('listSites', 'GET', {}).then(function (sites) {
        state.sites = sites || [];
        saveDraft_('mya_cache_sites', state.sites);
        renderContextSiteBody_();
      })
    : callApi('listTransformers', 'GET', { site_id: state.currentSiteId }).then(function (transformers) {
        state.transformers = transformers || [];
        saveDraft_(trfCacheKey, state.transformers);
        renderContextEquipmentBody_();
      });

  loader.catch(function (err) {
    if (err.status !== 402 && err.status !== 403 && !cached) {
      body.innerHTML = '<div class="empty-note">' + formatNetworkAwareError_(err) + '</div>';
    }
  });
}

function closeContextModal_() {
  document.getElementById('contextModal').classList.remove('open');
  document.getElementById('contextModalBackdrop').classList.remove('open');
  state.pendingContextTarget = null;
}

function renderContextSiteBody_() {
  var body = document.getElementById('contextModalBody');
  var listHtml = state.sites.map(function (s) {
    return '<button type="button" class="modal-list-item" onclick="selectContextSite_(\'' + s.id + '\')">' +
      '<strong>' + escapeHtml_(s.client_name) + '</strong><span>' + escapeHtml_(s.project_name) + '</span></button>';
  }).join('');

  body.innerHTML =
    '<div class="field"><label>Cliente</label><input class="mono" id="ctxSiteClient" placeholder="Electrocosta"></div>' +
    '<div class="field"><label>Proyecto / Subestación</label><input class="mono" id="ctxSiteProject" placeholder="Subestación Norte"></div>' +
    '<button class="btn primary" style="width:100%; margin-top:6px;" id="ctxSiteCreateBtn">Crear y continuar</button>' +
    '<span class="status-line" id="ctxSiteStatus" hidden></span>' +
    (state.sites.length ? '<div class="modal-divider">o selecciona uno existente</div><div class="modal-list">' + listHtml + '</div>' : '');

  document.getElementById('ctxSiteCreateBtn').addEventListener('click', handleContextCreateSite_);
}

function handleContextCreateSite_() {
  var client = document.getElementById('ctxSiteClient').value.trim();
  var project = document.getElementById('ctxSiteProject').value.trim();
  var statusEl = document.getElementById('ctxSiteStatus');
  if (!client || !project) { setStatus_(statusEl, 'Cliente y proyecto son obligatorios', false, true); return; }
  setStatus_(statusEl, 'Creando…', false);
  callApi('createSite', 'POST', { client_name: client, project_name: project, address: '' })
    .then(function (data) {
      return callApi('listSites', 'GET', {}).then(function (sites) {
        state.sites = sites || [];
        saveDraft_('mya_cache_sites', state.sites);
        selectContextSite_(data.id);
      });
    })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(statusEl, formatNetworkAwareError_(err), false, true);
    });
}

function selectContextSite_(id) {
  var site = state.sites.filter(function (s) { return s.id === id; })[0];
  if (!site) return;
  state.currentSiteId = id;
  state.currentSite = site;
  var target = state.pendingContextTarget;
  if (viewNeedsTransformer_(target) && !state.currentTransformer) {
    openContextModal_('equipment', target);
  } else {
    closeContextModal_();
    showView(target || 'dashboard');
  }
}

function renderContextEquipmentBody_() {
  var body = document.getElementById('contextModalBody');
  var listHtml = state.transformers.map(function (t) {
    return '<button type="button" class="modal-list-item" onclick="selectContextTransformer_(\'' + t.id + '\')">' +
      '<strong>' + escapeHtml_(t.serial_number) + '</strong><span>' + escapeHtml_(t.manufacturer || '—') + '</span></button>';
  }).join('');

  body.innerHTML =
    '<div class="field"><label>Número de serie</label><input class="mono" id="ctxTrfSerial" placeholder="TRF-1187-B"></div>' +
    '<div class="field"><label>Fases</label><select id="ctxTrfPhase"><option value="TRIFASICO">Trifásico</option><option value="MONOFASICO">Monofásico</option></select></div>' +
    '<button class="btn primary" style="width:100%; margin-top:6px;" id="ctxTrfCreateBtn">Crear y continuar</button>' +
    '<span class="status-line" id="ctxTrfStatus" hidden></span>' +
    '<div class="field-note" style="margin-top:2px;">Puedes completar el resto de los datos de placa luego, desde Equipos.</div>' +
    (state.transformers.length ? '<div class="modal-divider">o selecciona uno existente</div><div class="modal-list">' + listHtml + '</div>' : '');

  document.getElementById('ctxTrfCreateBtn').addEventListener('click', handleContextCreateTransformer_);
}

function handleContextCreateTransformer_() {
  var serial = document.getElementById('ctxTrfSerial').value.trim();
  var phase = document.getElementById('ctxTrfPhase').value;
  var statusEl = document.getElementById('ctxTrfStatus');
  if (!serial) { setStatus_(statusEl, 'El número de serie es obligatorio', false, true); return; }
  setStatus_(statusEl, 'Verificando número de serie…', false);

  checkSerialExists_(serial)
    .then(function (existing) {
      if (existing && existing.site_id === state.currentSiteId) {
        setStatus_(statusEl, 'Este equipo ya existe — abriéndolo…', true);
        selectContextTransformer_(existing.id);
        return Promise.reject({ __handled: true });
      }
      if (existing) {
        return resolveSiteLabel_(existing.site_id).then(function (label) {
          setStatus_(statusEl, 'Ese número de serie ya está registrado en ' + label + '. No se puede duplicar.', false, true);
          return Promise.reject({ __handled: true });
        });
      }
      setStatus_(statusEl, 'Creando…', false);
      return callApi('createTransformer', 'POST', {
        site_id: state.currentSiteId,
        serial_number: serial,
        phase_type: phase,
        tap_config: { nominalVoltage: 0, stepPercentage: 2.5, numPositions: 5, neutralPosition: 3, positions: buildDefaultTapPositions_(0) }
      });
    })
    .then(function (data) {
      return callApi('listTransformers', 'GET', { site_id: state.currentSiteId }).then(function (transformers) {
        state.transformers = transformers || [];
        saveDraft_('mya_cache_transformers_' + state.currentSiteId, state.transformers);
        selectContextTransformer_(data.id);
      });
    })
    .catch(function (err) {
      if (err && err.__handled) return;
      if (!err || (err.status !== 402 && err.status !== 403)) setStatus_(statusEl, formatNetworkAwareError_(err || {}), false, true);
    });
}

function selectContextTransformer_(id) {
  var target = state.pendingContextTarget;
  closeContextModal_();
  openTransformer(id).then(function () {
    if (target && target !== 'detail' && target !== 'dashboard') showView(target);
  });
}

// ---------------------------------------------------------------
// Login real contra Control de Acceso + flujo DebeCambiar
// ---------------------------------------------------------------

function handleLoginSubmit(e) {
  e.preventDefault();
  var usuario = document.getElementById('loginUsuario').value.trim();
  var password = document.getElementById('loginPassword').value;
  if (!usuario || !password) return;

  var btn = document.getElementById('loginSubmitBtn');
  var errEl = document.getElementById('loginError');
  btn.disabled = true;
  setStatus_(errEl, '', false);

  callAuthApi('login', { usuario: usuario, password: password })
    .then(function (json) {
      if (!json.ok) {
        setStatus_(errEl, mapAuthError_(json.error), false, true);
        return;
      }

      state.token = json.token;
      state.username = usuario;
      state.role = json.role;
      state.allowedApps = json.allowedApps || [];

      document.getElementById('sidebarUserName').textContent = state.username;
      document.getElementById('sidebarRole').textContent = state.role;
      document.getElementById('dashboardTenantLabel').textContent = state.username + ' · ' + state.role;

      if (json.debeCambiar) {
        state.pendingOldUsuario = usuario;
        state.pendingOldPassword = password;
        showView('change-password');
        return;
      }

      saveSession_();
      renderAdminNavAndPanel();
      renderRestrictedModuleNav_();
      return loadSitesAndShow_();
    })
    .catch(function (err) {
      setStatus_(errEl, 'No se pudo contactar el servicio de autenticación: ' + err.message, false, true);
    })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Cliente / Proyecto (Sitios)
// ---------------------------------------------------------------

/** Caché-luego-red: si hay datos guardados de una visita anterior los muestra
 *  de inmediato (sensación instantánea), y siempre refresca contra el backend
 *  en segundo plano para no quedarse con datos desactualizados. */
function loadSitesAndShow_() {
  var cached = loadDraft_('mya_cache_sites');
  if (cached) { state.sites = cached; renderSites(); }
  showView('sites');

  return callApi('listSites', 'GET', {})
    .then(function (sites) {
      state.sites = sites || [];
      saveDraft_('mya_cache_sites', state.sites);
      renderSites();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return; // ya se mostró la pantalla correspondiente
      if (!cached) alert('No se pudieron cargar los clientes/proyectos: ' + err.message);
    });
}

function renderSites() {
  var tbody = document.getElementById('sitesRows');
  var chip = document.getElementById('sitesTenantChip');
  if (chip) chip.textContent = state.username + ' · ' + state.role;
  if (!tbody) return;

  if (state.sites.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">No hay clientes/proyectos todavía. Crea el primero arriba para empezar.</td></tr>';
    return;
  }

  tbody.innerHTML = state.sites.map(function (s) {
    var isNew = String(s.id).indexOf('tmp_') === 0;
    var actionsCell;
    if (s._pending) {
      actionsCell = '<span class="pill neutral">Sincronizando&hellip;</span>';
    } else if (s._error) {
      actionsCell = '<button type="button" class="pill danger pill-btn" title="' + escapeHtml_(s._errorMessage || 'Reintentar') + '" onclick="event.stopPropagation(); retryPendingSite_(\'' + s.id + '\')">Pendiente &middot; reintentar</button>';
    } else {
      var editBtn = '<button type="button" class="btn" style="min-height:36px; padding:4px 10px;" title="Editar" onclick="event.stopPropagation(); openEditSiteModal_(\'' + s.id + '\')">Editar</button>';
      var deleteBtn = state.role === 'Administrador'
        ? '<button type="button" class="matrix-remove" title="Eliminar" onclick="event.stopPropagation(); handleDeleteSite_(\'' + s.id + '\')">&times;</button>'
        : '';
      actionsCell = editBtn + deleteBtn;
    }
    var rowOpen = (isNew || s._pending) ? '<tr>' : '<tr class="rowlink" onclick="selectSite(\'' + s.id + '\')">';
    return rowOpen +
      '<td>' + escapeHtml_(s.client_name) + '</td>' +
      '<td>' + escapeHtml_(s.project_name) + '</td>' +
      '<td>' + escapeHtml_(s.ciudad || '—') + '</td>' +
      '<td class="mono">' + escapeHtml_(s.nit || '—') + '</td>' +
      '<td>' + escapeHtml_(s.address || '—') + '</td>' +
      '<td style="display:flex; align-items:center; justify-content:flex-end; gap:8px;">' + actionsCell + '</td>' +
      '</tr>';
  }).join('');
}

/** Algoritmo estándar DIAN de dígito de verificación (módulo 11, pesos fijos por posición) —
 *  debe replicar EXACTAMENTE calcularDigitoVerificacionNit_ en Código.gs. */
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

function normalizeNit_(raw) {
  if (!raw) return { ok: true, value: '' };
  var cleaned = String(raw).replace(/[.\s]/g, '');
  var match = cleaned.match(/^(\d+)(?:-(\d))?$/);
  if (!match) return { ok: false, message: 'NIT inválido: solo números (y opcionalmente "-" con el dígito de verificación)' };
  var base = match[1];
  var providedDv = match[2];
  var computedDv = calcularDigitoVerificacionNit_(base);
  if (providedDv !== undefined && Number(providedDv) !== computedDv) {
    return { ok: false, message: 'El DV no coincide: para ' + base + ' debería ser -' + computedDv };
  }
  return { ok: true, value: base + '-' + computedDv };
}

/** Vista previa en vivo del dígito de verificación mientras el técnico escribe el NIT. */
function updateNitPreview_(inputEl, hintElId) {
  var hint = document.getElementById(hintElId);
  if (!hint) return;
  var result = normalizeNit_(inputEl.value);
  if (!inputEl.value) { hint.textContent = ''; return; }
  hint.textContent = result.ok ? ('Se guardará como ' + result.value) : result.message;
  hint.style.color = result.ok ? 'var(--success-text)' : 'var(--danger)';
}

function openEditSiteModal_(id) {
  var site = state.sites.filter(function (s) { return s.id === id; })[0];
  if (!site) return;
  document.getElementById('editSiteForm').dataset.siteId = id;
  document.getElementById('editSiteClient').value = site.client_name || '';
  document.getElementById('editSiteProject').value = site.project_name || '';
  document.getElementById('editSiteAddress').value = site.address || '';
  document.getElementById('editSiteNit').value = site.nit || '';
  document.getElementById('editSiteCiudad').value = site.ciudad || '';
  setStatus_(document.getElementById('editSiteStatus'), '', false);
  document.getElementById('editSiteNitHint').textContent = '';
  document.getElementById('editSiteModal').classList.add('open');
  document.getElementById('editSiteModalBackdrop').classList.add('open');
}

function closeEditSiteModal_() {
  document.getElementById('editSiteModal').classList.remove('open');
  document.getElementById('editSiteModalBackdrop').classList.remove('open');
}

function handleEditSiteSubmit(e) {
  e.preventDefault();
  var id = document.getElementById('editSiteForm').dataset.siteId;
  var statusEl = document.getElementById('editSiteStatus');
  var nitResult = normalizeNit_(document.getElementById('editSiteNit').value.trim());
  if (!nitResult.ok) { setStatus_(statusEl, nitResult.message, false, true); return; }
  setStatus_(statusEl, '', false);

  var payload = {
    id: id,
    client_name: document.getElementById('editSiteClient').value.trim(),
    project_name: document.getElementById('editSiteProject').value.trim(),
    address: document.getElementById('editSiteAddress').value.trim(),
    nit: nitResult.value,
    ciudad: document.getElementById('editSiteCiudad').value.trim()
  };

  // Local-first: se aplica el cambio en la fila ya mismo; el POST real corre en segundo plano.
  var rec = state.sites.filter(function (s) { return s.id === id; })[0];
  if (rec) {
    Object.assign(rec, payload);
    rec._pending = true; rec._error = false; rec._errorMessage = '';
    saveDraft_('mya_cache_sites', state.sites);
    renderSites();
  }
  closeEditSiteModal_();

  callApi('updateSite', 'POST', payload)
    .then(function () { return callApi('listSites', 'GET', {}); })
    .then(function (sites) {
      state.sites = sites || [];
      saveDraft_('mya_cache_sites', state.sites);
      renderSites();
      showToast_('Cliente/Proyecto actualizado', 'success');
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      var r = state.sites.filter(function (s) { return s.id === id; })[0];
      if (r) { r._pending = false; r._error = true; r._errorMessage = formatNetworkAwareError_(err); r._retryAction = 'updateSite'; r._retryPayload = payload; }
      saveDraft_('mya_cache_sites', state.sites);
      renderSites();
      showToast_('No se pudo guardar el cambio. Quedó pendiente de sincronizar.', 'error');
    });
}

/** Solo Administrador (el backend también lo exige). Se rechaza si el sitio aún tiene equipos. */
function handleDeleteSite_(id) {
  var site = state.sites.filter(function (s) { return s.id === id; })[0];
  if (!site) return;
  if (!confirm('¿Eliminar "' + site.client_name + ' · ' + site.project_name + '"? Esta acción no se puede deshacer.')) return;
  callApi('deleteSite', 'POST', { id: id })
    .then(function () {
      clearDraft_('mya_cache_sites');
      return loadSitesAndShow_();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      alert('No se pudo eliminar: ' + err.message);
    });
}

function selectSite(id) {
  var site = state.sites.filter(function (s) { return s.id === id; })[0];
  if (!site) return;
  state.currentSiteId = id;
  state.currentSite = site;
  var subtitle = document.getElementById('dashboardSiteSubtitle');
  if (subtitle) subtitle.textContent = site.client_name + ' · ' + site.project_name;
  loadDashboardAndShow_();
}

function handleCreateSiteSubmit(e) {
  e.preventDefault();
  var clientName = document.getElementById('newSiteClient').value.trim();
  var projectName = document.getElementById('newSiteProject').value.trim();
  var address = document.getElementById('newSiteAddress').value.trim();
  var ciudad = document.getElementById('newSiteCiudad').value.trim();
  if (!clientName || !projectName) return;

  var status = document.getElementById('createSiteStatus');
  var nitResult = normalizeNit_(document.getElementById('newSiteNit').value.trim());
  if (!nitResult.ok) { setStatus_(status, nitResult.message, false, true); return; }
  setStatus_(status, '', false);

  // Local-first: la fila aparece de inmediato con un id temporal; el POST real
  // corre en segundo plano y un toast informa el resultado sin bloquear la UI.
  var payload = { client_name: clientName, project_name: projectName, address: address, nit: nitResult.value, ciudad: ciudad };
  var tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  state.sites.push(Object.assign({ id: tempId, created_at: new Date().toISOString(), _pending: true }, payload));
  saveDraft_('mya_cache_sites', state.sites);
  renderSites();
  document.getElementById('createSiteForm').reset();

  callApi('createSite', 'POST', payload)
    .then(function () { return callApi('listSites', 'GET', {}); })
    .then(function (sites) {
      state.sites = sites || [];
      saveDraft_('mya_cache_sites', state.sites);
      renderSites();
      showToast_('Cliente/Proyecto guardado correctamente', 'success');
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) {
        state.sites = state.sites.filter(function (s) { return s.id !== tempId; });
        saveDraft_('mya_cache_sites', state.sites);
        renderSites();
        return;
      }
      var rec = state.sites.filter(function (s) { return s.id === tempId; })[0];
      if (rec) { rec._pending = false; rec._error = true; rec._errorMessage = formatNetworkAwareError_(err); rec._retryAction = 'createSite'; rec._retryPayload = payload; }
      saveDraft_('mya_cache_sites', state.sites);
      renderSites();
      showToast_('No se pudo guardar "' + clientName + '". Quedó pendiente de sincronizar.', 'error');
    });
}

/** Reintenta el guardado en segundo plano de un Sitio marcado como pendiente/error
 *  (creación con id temporal, o edición sobre un id real) sin pedir datos de nuevo. */
function retryPendingSite_(id) {
  var rec = state.sites.filter(function (s) { return s.id === id; })[0];
  if (!rec || !rec._retryAction) return;
  rec._pending = true; rec._error = false; rec._errorMessage = '';
  renderSites();

  var action = rec._retryAction;
  var payload = rec._retryPayload;

  callApi(action, 'POST', payload)
    .then(function () { return callApi('listSites', 'GET', {}); })
    .then(function (sites) {
      state.sites = sites || [];
      saveDraft_('mya_cache_sites', state.sites);
      renderSites();
      showToast_('Cliente/Proyecto sincronizado', 'success');
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      var r = state.sites.filter(function (s) { return s.id === id; })[0];
      if (r) { r._pending = false; r._error = true; r._errorMessage = formatNetworkAwareError_(err); }
      saveDraft_('mya_cache_sites', state.sites);
      renderSites();
      showToast_('Sigue sin poder sincronizarse. ' + formatNetworkAwareError_(err), 'error');
    });
}

function loadDashboardAndShow_() {
  if (!state.currentSiteId) return showView('sites');

  var cacheKey = 'mya_cache_transformers_' + state.currentSiteId;
  var cached = loadDraft_(cacheKey);
  if (cached) { state.transformers = cached; renderDashboard(); }
  showView('dashboard');

  return callApi('listTransformers', 'GET', { site_id: state.currentSiteId })
    .then(function (transformers) {
      state.transformers = transformers || [];
      saveDraft_(cacheKey, state.transformers);
      renderDashboard();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return; // ya se mostró la pantalla correspondiente
      if (!cached) alert('No se pudieron cargar los transformadores: ' + err.message);
    });
}

/** Lee un <input type=file> como base64 (sin el prefijo data:...;base64,) para enviarlo al backend. */
function readFileAsBase64_(fileInput) {
  var file = fileInput.files && fileInput.files[0];
  if (!file) return Promise.resolve(null);
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var result = reader.result;
      var base64 = result.substring(result.indexOf(',') + 1);
      resolve({ base64: base64, mimeType: file.type || 'application/octet-stream' });
    };
    reader.onerror = function () { reject(new Error('No se pudo leer el archivo')); };
    reader.readAsDataURL(file);
  });
}

/** Un transformador es un activo físico único: si el número de serie ya está
 *  registrado, nunca debe crearse un duplicado — hay que reabrir el existente. */
function checkSerialExists_(serial) {
  if (!serial) return Promise.resolve(null);
  return callApi('listTransformers', 'GET', { serial_number: serial })
    .then(function (matches) { return (matches && matches[0]) || null; });
}

function resolveSiteLabel_(siteId) {
  var cached = state.sites.filter(function (s) { return s.id === siteId; })[0];
  if (cached) return Promise.resolve(cached.client_name + ' · ' + cached.project_name);
  return callApi('listSites', 'GET', {}).then(function (sites) {
    state.sites = sites || [];
    var found = state.sites.filter(function (s) { return s.id === siteId; })[0];
    return found ? (found.client_name + ' · ' + found.project_name) : 'otro cliente/proyecto';
  });
}

function handleCreateTransformerSubmit(e) {
  e.preventDefault();
  if (!state.currentSiteId) { alert('Selecciona primero un Cliente/Proyecto.'); return; }

  var serial = document.getElementById('newTrfSerial').value.trim();
  var manufacturer = document.getElementById('newTrfManufacturer').value.trim();
  var phaseType = document.getElementById('newTrfPhaseType').value;
  var vectorGroup = document.getElementById('newTrfVectorGroup').value.trim() || null;
  var hv = parseDecimal_(document.getElementById('newTrfHv').value);
  var lv = parseDecimal_(document.getElementById('newTrfLv').value);
  var year = document.getElementById('newTrfYear').value.trim();
  var power = parseDecimal_(document.getElementById('newTrfPower').value);
  var cooling = document.getElementById('newTrfCooling').value || null;
  var impedance = parseDecimal_(document.getElementById('newTrfImpedance').value);
  var insulation = document.getElementById('newTrfInsulation').value.trim() || null;
  var btn = document.getElementById('createTransformerBtn');
  var status = document.getElementById('createTransformerStatus');
  var siteId = state.currentSiteId;
  btn.disabled = true;
  setStatus_(status, 'Verificando número de serie…', false);

  var nominalForTaps = isNaN(hv) ? 0 : hv;

  // La deduplicación por serial se queda síncrona/bloqueante (lectura rápida y
  // crítica para la integridad de datos); solo el POST de creación pasa a
  // segundo plano una vez descartado un duplicado.
  checkSerialExists_(serial)
    .then(function (existing) {
      if (existing && existing.site_id === state.currentSiteId) {
        setStatus_(status, 'Este equipo ya existe — abriéndolo…', true);
        btn.disabled = false;
        return openTransformer(existing.id).then(function () { return Promise.reject({ __handled: true }); });
      }
      if (existing) {
        return resolveSiteLabel_(existing.site_id).then(function (label) {
          setStatus_(status, 'Ese número de serie ya está registrado en ' + label + '. No se puede duplicar.', false, true);
          btn.disabled = false;
          return Promise.reject({ __handled: true });
        });
      }
      return readFileAsBase64_(document.getElementById('newTrfPlatePhoto'));
    })
    .then(function (photo) {
      setStatus_(status, '', false);
      var payload = {
        site_id: siteId,
        serial_number: serial,
        manufacturer: manufacturer,
        phase_type: phaseType,
        vector_group: vectorGroup,
        hv_nominal_voltage: isNaN(hv) ? null : hv,
        lv_nominal_voltage: isNaN(lv) ? null : lv,
        manufacture_year: year || null,
        rated_power_kva: isNaN(power) ? null : power,
        cooling_type: cooling,
        impedance_percent: isNaN(impedance) ? null : impedance,
        insulation_type: insulation,
        is_special_design: false,
        tap_config: {
          nominalVoltage: nominalForTaps,
          stepPercentage: 2.5,
          numPositions: 5,
          neutralPosition: 3,
          positions: buildDefaultTapPositions_(nominalForTaps)
        },
        file_base64: photo ? photo.base64 : null,
        file_mime_type: photo ? photo.mimeType : null
      };

      // Local-first: el equipo aparece de inmediato en el panel con id temporal;
      // el POST real (incluida la foto de placa) corre en segundo plano.
      var tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      state.transformers.push(Object.assign({
        id: tempId, updated_at: new Date().toISOString(), status: 'ACTIVO', _pending: true
      }, payload));
      saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
      renderDashboard();
      document.getElementById('createTransformerForm').reset();
      btn.disabled = false;

      callApi('createTransformer', 'POST', payload)
        .then(function () { return callApi('listTransformers', 'GET', { site_id: siteId }); })
        .then(function (transformers) {
          if (state.currentSiteId !== siteId) return; // el técnico ya cambió de sitio
          state.transformers = transformers || [];
          saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
          renderDashboard();
          showToast_('Equipo guardado correctamente', 'success');
        })
        .catch(function (err) {
          if (err.status === 402 || err.status === 403) {
            state.transformers = state.transformers.filter(function (t) { return t.id !== tempId; });
            saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
            if (state.currentSiteId === siteId) renderDashboard();
            return;
          }
          var rec = state.transformers.filter(function (t) { return t.id === tempId; })[0];
          if (rec) { rec._pending = false; rec._error = true; rec._errorMessage = formatNetworkAwareError_(err); rec._retryAction = 'createTransformer'; rec._retryPayload = payload; }
          saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
          if (state.currentSiteId === siteId) renderDashboard();
          showToast_('No se pudo guardar el equipo "' + serial + '". Quedó pendiente de sincronizar.', 'error');
        });
    })
    .catch(function (err) {
      if (err && err.__handled) return; // ya se mostró el mensaje de duplicado/reapertura
      btn.disabled = false;
      if (!err || (err.status !== 402 && err.status !== 403)) setStatus_(status, formatNetworkAwareError_(err || {}), false, true);
    });
}

/** Reintenta el guardado en segundo plano de un Equipo marcado como pendiente/error
 *  (creación con id temporal, o edición sobre un id real) sin pedir datos de nuevo. */
function retryPendingTransformer_(id) {
  var siteId = state.currentSiteId;
  var rec = state.transformers.filter(function (t) { return t.id === id; })[0];
  if (!rec || !rec._retryAction) return;
  rec._pending = true; rec._error = false; rec._errorMessage = '';
  renderDashboard();

  var action = rec._retryAction;
  var payload = rec._retryPayload;

  callApi(action, 'POST', payload)
    .then(function () { return callApi('listTransformers', 'GET', { site_id: siteId }); })
    .then(function (transformers) {
      if (state.currentSiteId !== siteId) return;
      state.transformers = transformers || [];
      saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
      renderDashboard();
      showToast_('Equipo sincronizado', 'success');
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      var r = state.transformers.filter(function (t) { return t.id === id; })[0];
      if (r) { r._pending = false; r._error = true; r._errorMessage = formatNetworkAwareError_(err); }
      saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
      if (state.currentSiteId === siteId) renderDashboard();
      showToast_('Sigue sin poder sincronizarse. ' + formatNetworkAwareError_(err), 'error');
    });
}

function openEditTransformerModal_() {
  var t = state.currentTransformer;
  if (!t) return;
  document.getElementById('editTrfSerial').value = t.serial_number || '';
  document.getElementById('editTrfManufacturer').value = t.manufacturer || '';
  document.getElementById('editTrfVectorGroup').value = t.vector_group || '';
  document.getElementById('editTrfPower').value = t.rated_power_kva || '';
  document.getElementById('editTrfHv').value = t.hv_nominal_voltage || '';
  document.getElementById('editTrfLv').value = t.lv_nominal_voltage || '';
  document.getElementById('editTrfCooling').value = t.cooling_type || '';
  document.getElementById('editTrfImpedance').value = t.impedance_percent || '';
  document.getElementById('editTrfInsulation').value = t.insulation_type || '';
  document.getElementById('editTrfYear').value = t.manufacture_year || '';
  setStatus_(document.getElementById('editTransformerStatus'), '', false);
  document.getElementById('editTransformerModal').classList.add('open');
  document.getElementById('editTransformerModalBackdrop').classList.add('open');
}

function closeEditTransformerModal_() {
  document.getElementById('editTransformerModal').classList.remove('open');
  document.getElementById('editTransformerModalBackdrop').classList.remove('open');
}

function handleEditTransformerSubmit(e) {
  e.preventDefault();
  var statusEl = document.getElementById('editTransformerStatus');
  var hv = parseDecimal_(document.getElementById('editTrfHv').value);
  var lv = parseDecimal_(document.getElementById('editTrfLv').value);
  var power = parseDecimal_(document.getElementById('editTrfPower').value);
  var impedance = parseDecimal_(document.getElementById('editTrfImpedance').value);
  var year = document.getElementById('editTrfYear').value.trim();
  var id = state.currentTransformerId;
  var siteId = state.currentSiteId;

  setStatus_(statusEl, '', false);
  var payload = {
    id: id,
    serial_number: document.getElementById('editTrfSerial').value.trim(),
    manufacturer: document.getElementById('editTrfManufacturer').value.trim(),
    vector_group: document.getElementById('editTrfVectorGroup').value.trim() || null,
    rated_power_kva: isNaN(power) ? null : power,
    hv_nominal_voltage: isNaN(hv) ? null : hv,
    lv_nominal_voltage: isNaN(lv) ? null : lv,
    cooling_type: document.getElementById('editTrfCooling').value || null,
    impedance_percent: isNaN(impedance) ? null : impedance,
    insulation_type: document.getElementById('editTrfInsulation').value.trim() || null,
    manufacture_year: year || null
  };

  // Local-first: se refleja el cambio de inmediato tanto en el detalle como en la
  // fila del panel; el POST real corre en segundo plano.
  Object.assign(state.currentTransformer, payload);
  renderDetail();
  var rec = state.transformers.filter(function (t) { return t.id === id; })[0];
  if (rec) {
    Object.assign(rec, payload);
    rec._pending = true; rec._error = false; rec._errorMessage = '';
    saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
    renderDashboard();
  }
  saveDraft_('mya_cache_transformer_' + id, state.currentTransformer);
  closeEditTransformerModal_();

  callApi('updateTransformer', 'POST', payload)
    .then(function () { return callApi('listTransformers', 'GET', { site_id: siteId }); })
    .then(function (transformers) {
      if (state.currentSiteId === siteId) {
        state.transformers = transformers || [];
        saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
        renderDashboard();
      }
      showToast_('Equipo actualizado', 'success');
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      var r = state.transformers.filter(function (t) { return t.id === id; })[0];
      if (r) { r._pending = false; r._error = true; r._errorMessage = formatNetworkAwareError_(err); r._retryAction = 'updateTransformer'; r._retryPayload = payload; }
      saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
      if (state.currentSiteId === siteId) renderDashboard();
      showToast_('No se pudo guardar el cambio. Quedó pendiente de sincronizar.', 'error');
    });
}

function buildDefaultTapPositions_(nominalVoltage) {
  var step = 2.5, neutral = 3, n = 5, positions = [];
  for (var p = 1; p <= n; p++) {
    positions.push({ position: p, voltage: Math.round(nominalVoltage * (1 - (p - neutral) * step / 100)) });
  }
  return positions;
}

function handleChangePasswordSubmit(e) {
  e.preventDefault();
  var newPassword = document.getElementById('newPassword').value;
  var confirmPassword = document.getElementById('confirmPassword').value;
  var errEl = document.getElementById('changePasswordError');
  var btn = document.getElementById('changePasswordBtn');

  if (newPassword !== confirmPassword) {
    setStatus_(errEl, 'Las contraseñas no coinciden', false, true);
    return;
  }

  btn.disabled = true;
  setStatus_(errEl, '', false);

  callAuthApi('changePassword', {
    usuario: state.pendingOldUsuario,
    oldPassword: state.pendingOldPassword,
    newPassword: newPassword
  })
    .then(function (json) {
      if (!json.ok) {
        setStatus_(errEl, mapAuthError_(json.error), false, true);
        return;
      }
      state.pendingOldPassword = null;
      state.pendingOldUsuario = null;
      saveSession_();
      renderAdminNavAndPanel();
      renderRestrictedModuleNav_();
      return loadSitesAndShow_();
    })
    .catch(function (err) {
      setStatus_(errEl, 'No se pudo cambiar la contraseña: ' + err.message, false, true);
    })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Panel de administración (RBAC) — solo se agrega al DOM para rol Administrador
// ---------------------------------------------------------------

function renderAdminNavAndPanel() {
  if (state.role !== 'Administrador') return;

  // Hoja "Más" (móvil): el ítem solo se crea para rol Administrador — nunca existe
  // en el DOM para otros roles, ni siquiera oculto.
  if (!document.getElementById('moreSheetAdminItem')) {
    var moreItem = document.createElement('button');
    moreItem.type = 'button';
    moreItem.className = 'action-sheet-item';
    moreItem.id = 'moreSheetAdminItem';
    moreItem.dataset.view = 'admin';
    moreItem.innerHTML = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.2" r="2.7" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 14c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" stroke="currentColor" stroke-width="1.4"/></svg>Gestión de usuarios';
    moreItem.addEventListener('click', function () { showView('admin'); });
    var moreSheetUserP = document.getElementById('moreSheetUser').closest('p');
    moreSheetUserP.insertAdjacentElement('afterend', moreItem);
  }

  if (document.getElementById('view-admin')) return;

  var previewLabel = document.getElementById('navLabelPreview');

  var navLabel = document.createElement('div');
  navLabel.className = 'nav-label';
  navLabel.textContent = 'Administración';

  var navItem = document.createElement('div');
  navItem.className = 'nav-item';
  navItem.dataset.view = 'admin';
  navItem.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.2" r="2.7" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 14c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" stroke="currentColor" stroke-width="1.4"/></svg>Gestión de usuarios';
  navItem.addEventListener('click', function () { showView('admin'); });

  previewLabel.parentNode.insertBefore(navLabel, previewLabel);
  previewLabel.parentNode.insertBefore(navItem, previewLabel);

  var section = document.createElement('section');
  section.id = 'view-admin';
  section.hidden = true;
  section.innerHTML =
    '<div class="topbar"><div><h1>Gestión de usuarios</h1><p>Crea técnicos y supervisores con acceso a Gestión de Pruebas</p></div>' +
    '<div class="tenant-chip">' + APP_ID + '</div></div>' +
    '<div class="view">' +
    '<div class="panel" style="max-width:480px;">' +
    '<div class="panel-head"><h2>Nuevo usuario</h2></div>' +
    '<form id="createUserForm" style="padding:16px 18px; display:flex; flex-direction:column; gap:13px;">' +
    '<div class="field"><label>Usuario</label><input class="mono" id="newUserUsuario" placeholder="tecnico.nombre" required></div>' +
    '<div class="field"><label>Contraseña temporal</label><input type="password" id="newUserPassword" required minlength="8"></div>' +
    '<div class="field"><label>Rol</label><select id="newUserRol"><option value="Tecnico">Técnico</option><option value="Supervisor">Supervisor</option></select></div>' +
    '<button class="btn primary" type="submit" id="createUserBtn">Crear usuario</button>' +
    '<span class="status-line" id="createUserStatus" hidden></span>' +
    '</form>' +
    '<div class="source-strip" style="display:flex; justify-content:space-between; padding:10px 18px; font-size:11.5px; color:var(--text-muted); background:var(--surface-alt);">' +
    '<span>El usuario nuevo deberá cambiar esta contraseña al entrar</span><span class="tag">Temporal</span></div>' +
    '</div></div>';

  document.querySelector('main').appendChild(section);
  document.getElementById('createUserForm').addEventListener('submit', handleCreateUserSubmit);
}

function removeAdminNavAndPanel() {
  var moreItem = document.getElementById('moreSheetAdminItem');
  if (moreItem) moreItem.remove();

  var navItem = document.querySelector('.nav-item[data-view="admin"]');
  if (navItem) {
    var label = navItem.previousElementSibling;
    if (label && label.classList.contains('nav-label')) label.remove();
    navItem.remove();
  }
  var section = document.getElementById('view-admin');
  if (section) section.remove();
}

// ---------------------------------------------------------------
// Módulos "Comercial" y "Panel General" (RBAC) — matriz completa en
// CLAUDE.md. "Sin acceso" para Técnico: igual que Administración, no se
// agregan al DOM en absoluto para ese rol (no solo display:none). Ambos
// son placeholders de navegación hoy — el contenido real se construye
// después, sin tener que reabrir la navegación ni la lógica de roles.
// ---------------------------------------------------------------

var RESTRICTED_MODULES_ = [
  { view: 'commercial', label: 'Comercial', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12.5 6 7l3 3 5-6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', title: 'Comercial', subtitle: 'Ofertas y licitaciones' },
  { view: 'general-dashboard', label: 'Panel General', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>', title: 'Panel General', subtitle: 'Dashboard consolidado de todas las operaciones' }
];

function renderRestrictedModuleNav_() {
  if (state.role === 'Tecnico') return;

  var moreAnchor = document.getElementById('moreSheetDocumentsItem');
  var sidebarAnchor = document.getElementById('navItemDocuments');

  RESTRICTED_MODULES_.forEach(function (mod) {
    // Hoja "Más" (móvil)
    if (moreAnchor && !document.getElementById('moreSheet_' + mod.view)) {
      var moreItem = document.createElement('button');
      moreItem.type = 'button';
      moreItem.className = 'action-sheet-item';
      moreItem.id = 'moreSheet_' + mod.view;
      moreItem.dataset.view = mod.view;
      moreItem.innerHTML = mod.icon + mod.label;
      moreItem.addEventListener('click', function () { showView(mod.view); });
      moreAnchor.insertAdjacentElement('afterend', moreItem);
      moreAnchor = moreItem; // el siguiente módulo se ancla justo después de este
    }

    // Barra lateral (escritorio)
    if (sidebarAnchor && !document.querySelector('.nav-item[data-view="' + mod.view + '"]')) {
      var navItem = document.createElement('div');
      navItem.className = 'nav-item';
      navItem.dataset.view = mod.view;
      navItem.innerHTML = mod.icon + mod.label;
      navItem.addEventListener('click', function () { showView(mod.view); });
      sidebarAnchor.insertAdjacentElement('afterend', navItem);
      sidebarAnchor = navItem; // el siguiente módulo se ancla justo después de este
    }

    // Vista placeholder (solo si no existe todavía)
    if (!document.getElementById('view-' + mod.view)) {
      var section = document.createElement('section');
      section.id = 'view-' + mod.view;
      section.hidden = true;
      section.innerHTML =
        '<div class="topbar"><div><h1>' + mod.title + '</h1><p>' + mod.subtitle + '</p></div></div>' +
        '<div class="view"><div class="panel"><div class="panel-head"><h2>Próximamente</h2></div>' +
        '<div class="empty-note">Este módulo está en diseño — se construirá cuando se valide el alcance completo con el cliente.</div>' +
        '</div></div>';
      document.querySelector('main').appendChild(section);
    }
  });
}

function removeRestrictedModuleNav_() {
  RESTRICTED_MODULES_.forEach(function (mod) {
    var moreItem = document.getElementById('moreSheet_' + mod.view);
    if (moreItem) moreItem.remove();
    var navItem = document.querySelector('.nav-item[data-view="' + mod.view + '"]');
    if (navItem) navItem.remove();
    var section = document.getElementById('view-' + mod.view);
    if (section) section.remove();
  });
}

function handleCreateUserSubmit(e) {
  e.preventDefault();
  var usuario = document.getElementById('newUserUsuario').value.trim();
  var password = document.getElementById('newUserPassword').value;
  var rol = document.getElementById('newUserRol').value;
  var btn = document.getElementById('createUserBtn');
  var status = document.getElementById('createUserStatus');

  btn.disabled = true;
  setStatus_(status, 'Creando…', false);

  callAuthApi('createUser', {
    token: state.token,
    usuario: usuario,
    password: password,
    rol: rol,
    appsPermitidas: APP_ID
  })
    .then(function (json) {
      if (!json.ok) {
        setStatus_(status, mapAuthError_(json.error), false, true);
        return;
      }
      setStatus_(status, 'Usuario "' + usuario + '" creado. Debe cambiar la contraseña al entrar.', true);
      document.getElementById('createUserForm').reset();
    })
    .catch(function (err) { setStatus_(status, 'No se pudo crear el usuario: ' + err.message, false, true); })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------

function renderDashboard() {
  var tbody = document.getElementById('dashboardRows');
  document.getElementById('statTransformerCount').textContent = state.transformers.length;
  document.getElementById('statSpecialCount').textContent = state.transformers.filter(function (t) { return t.is_special_design; }).length;

  if (state.transformers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-note">No hay transformadores registrados todavía para este cliente. Créalos con la acción <span class="mono">createTransformer</span>.</td></tr>';
    return;
  }

  tbody.innerHTML = state.transformers.map(function (t) {
    var phaseLabel = (t.phase_type === 'MONOFASICO' ? 'Monofásico' : 'Trifásico') + (t.vector_group ? ' &middot; ' + escapeHtml_(t.vector_group) : '');
    var specialTag = t.is_special_design ? ' <span class="tag">Especial</span>' : '';
    var isNew = String(t.id).indexOf('tmp_') === 0;
    var statusCell;
    if (t._pending) {
      statusCell = '<span class="pill neutral">Sincronizando&hellip;</span>';
    } else if (t._error) {
      statusCell = '<button type="button" class="pill danger pill-btn" title="' + escapeHtml_(t._errorMessage || 'Reintentar') + '" onclick="event.stopPropagation(); retryPendingTransformer_(\'' + t.id + '\')">Pendiente &middot; reintentar</button>';
    } else {
      var deleteBtn = state.role === 'Administrador'
        ? '<button type="button" class="matrix-remove" title="Eliminar" onclick="event.stopPropagation(); handleDeleteTransformer_(\'' + t.id + '\')">&times;</button>'
        : '';
      statusCell = '<span class="pill neutral">' + escapeHtml_(t.status || 'ACTIVO') + '</span>' + deleteBtn;
    }
    var rowOpen = (isNew || t._pending) ? '<tr>' : '<tr class="rowlink" onclick="openTransformer(\'' + t.id + '\')">';
    return rowOpen +
      '<td class="mono">' + escapeHtml_(t.serial_number) + '</td>' +
      '<td>' + escapeHtml_(t.manufacturer || '—') + '</td>' +
      '<td>' + phaseLabel + specialTag + '</td>' +
      '<td>' + fmtDate_(t.updated_at) + '</td>' +
      '<td style="display:flex; align-items:center; justify-content:flex-end; gap:8px;">' + statusCell + '</td>' +
      '</tr>';
  }).join('');
}

/** Solo Administrador (el backend también lo exige). Elimina el equipo y sus pruebas en cascada. */
function handleDeleteTransformer_(id) {
  var t = state.transformers.filter(function (x) { return x.id === id; })[0];
  if (!t) return;
  if (!confirm('¿Eliminar el equipo "' + t.serial_number + '" y todas sus pruebas registradas? Esta acción no se puede deshacer.')) return;
  callApi('deleteTransformer', 'POST', { id: id })
    .then(function () {
      clearDraft_('mya_cache_transformers_' + state.currentSiteId);
      return loadDashboardAndShow_();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      alert('No se pudo eliminar: ' + err.message);
    });
}

function openTransformer(id) {
  document.getElementById('detailTopTitle').textContent = 'Cargando…';
  showView('detail');

  var cacheKey = 'mya_cache_transformer_' + id;
  var testsCacheKey = 'mya_cache_tests_' + id;
  var cached = loadDraft_(cacheKey);
  if (cached) {
    state.currentTransformerId = id;
    state.currentTransformer = cached;
    state.currentTests = loadDraft_(testsCacheKey) || [];
    renderDetail();
    resetTtrStateFromTransformer();
    resetMatrixStateFromTransformer();
    resetWindingStateFromTransformer();
    resetOilStateFromTransformer();
    resetInsulationStateFromTransformer();
  }

  return Promise.all([
    callApi('getTransformer', 'GET', { id: id }),
    callApi('listTests', 'GET', { transformer_id: id })
  ]).then(function (results) {
    state.currentTransformerId = id;
    state.currentTransformer = results[0];
    state.currentTests = results[1] || [];
    saveDraft_(cacheKey, state.currentTransformer);
    saveDraft_(testsCacheKey, state.currentTests);
    renderDetail();
    resetTtrStateFromTransformer();
    resetMatrixStateFromTransformer();
    resetWindingStateFromTransformer();
    resetOilStateFromTransformer();
    resetInsulationStateFromTransformer();
  }).catch(function (err) {
    if (err.status === 402 || err.status === 403) return;
    if (!cached) {
      alert('No se pudo cargar el transformador: ' + err.message);
      showView('dashboard');
    }
  });
}

// ---------------------------------------------------------------
// Detalle del transformador
// ---------------------------------------------------------------

function renderDetail() {
  var t = state.currentTransformer;
  if (!t) return;

  document.getElementById('detailTopTitle').textContent = t.serial_number;
  document.getElementById('detailTitle').textContent = 'Transformador ' + t.serial_number;
  document.getElementById('detailStatusChip').textContent = 'Estado: ' + (t.status || 'ACTIVO');

  var phaseLabel = t.phase_type === 'MONOFASICO' ? 'Monofásico' : 'Trifásico';
  var powerLabel = t.rated_power_kva ? (t.rated_power_kva + ' kVA') : null;
  var siteLabel = state.currentSite ? (state.currentSite.client_name + ' · ' + state.currentSite.project_name) : null;
  document.getElementById('detailMeta').textContent =
    [siteLabel, phaseLabel, powerLabel].filter(Boolean).join(' · ');

  var badges = [];
  if (t.is_special_design) badges.push('<span class="tag">Diseño especial</span>');
  badges.push('<span class="pill neutral">Grupo: ' + escapeHtml_(t.vector_group || 'N/A') + '</span>');
  document.getElementById('detailBadges').innerHTML = badges.join('');

  var cfg = t.tap_config || {};
  document.getElementById('detailSpecGrid').innerHTML = [
    ['Tensión primaria', fmtVoltage_(t.hv_nominal_voltage)],
    ['Tensión secundaria', fmtVoltage_(t.lv_nominal_voltage)],
    ['Potencia nominal', t.rated_power_kva ? (t.rated_power_kva + ' kVA') : '—'],
    ['Año de fabricación', t.manufacture_year || '—'],
    ['Refrigeración', t.cooling_type || '—'],
    ['Impedancia', t.impedance_percent ? (t.impedance_percent + ' %') : '—'],
    ['Tipo de aislamiento', escapeHtml_(t.insulation_type || '—')],
    ['TAPs configurados', (cfg.positions || []).length],
    ['Paso por TAP', cfg.stepPercentage != null ? (cfg.stepPercentage + ' %') : '—'],
    ['Foto de placa', t.plate_photo_url ? ('<a href="' + t.plate_photo_url + '" target="_blank" rel="noopener">Ver foto</a>') : '—']
  ].map(function (pair) {
    return '<div class="cell"><div class="k">' + pair[0] + '</div><div class="v">' + pair[1] + '</div></div>';
  }).join('');

  document.getElementById('detailSpecialBanner').hidden = !usesCustomMatrix();

  var histBody = document.getElementById('testHistoryRows');
  if (state.currentTests.length === 0) {
    histBody.innerHTML = '<tr><td colspan="5" class="empty-note">Aún no hay pruebas registradas para este transformador.</td></tr>';
  } else {
    histBody.innerHTML = state.currentTests.slice().reverse().map(function (test) {
      return '<tr>' +
        '<td>' + fmtDate_(test.created_at) + '</td>' +
        '<td>' + escapeHtml_(test.test_type) + '</td>' +
        '<td>' + escapeHtml_(test.instrument_used || '—') + '</td>' +
        '<td>' + escapeHtml_(test.tested_by || '—') + '</td>' +
        '<td><span class="pill ' + verdictPillClass_(test.verdict) + '">' + escapeHtml_(test.verdict) + '</span></td>' +
        '</tr>';
    }).join('');
  }
}

function fmtVoltage_(v) {
  if (v === null || v === undefined || v === '') return '—';
  return Number(v).toLocaleString('es-CO') + ' V';
}

function usesCustomMatrix() {
  var t = state.currentTransformer;
  return !!(t && (t.is_special_design || t.vector_group === 'CUSTOM'));
}

function getTapConfig() {
  return (state.currentTransformer && state.currentTransformer.tap_config) ||
    { nominalVoltage: 0, stepPercentage: 0, numPositions: 0, neutralPosition: 1, positions: [] };
}

function getPhaseKeys() {
  var t = state.currentTransformer;
  if (t && t.phase_type === 'MONOFASICO') return ['H1H2-X1X2'];
  return ['H1H2-X1X2', 'H2H3-X2X3', 'H3H1-X3X1'];
}

function tapPositions() {
  return getTapConfig().positions.map(function (p) { return p.position; }).sort(function (a, b) { return a - b; });
}

function tapVoltageFor(position) {
  var found = getTapConfig().positions.filter(function (p) { return p.position === position; })[0];
  return found ? found.voltage : null;
}

// ---------------------------------------------------------------
// Formulario TTR
// ---------------------------------------------------------------

function renderTtrFormContext() {
  var t = state.currentTransformer;
  document.getElementById('ttrFormSubtitle').textContent = t.serial_number + ' · Relación de Transformación';
  document.getElementById('ttrTenantChip').textContent = state.username + ' · ' + state.role;
  document.getElementById('ttrVectorGroupLabel').textContent = t.vector_group || 'N/A';
  document.getElementById('tapCountLabel').textContent = tapPositions().length;
  document.getElementById('sessionRolePill').textContent = state.role || '—';
}

function resetTtrStateFromTransformer() {
  var positions = tapPositions();
  var draft = loadDraft_('mya_draft_ttr_' + state.currentTransformerId);
  if (draft) {
    state.ttr.readings = draft;
    state.ttr.currentTap = positions.length ? positions[0] : null;
    return;
  }
  state.ttr.currentTap = positions.length ? positions[0] : null;
  state.ttr.readings = {};
  if (state.ttr.currentTap !== null) seedTtrTapReadings_(state.ttr.currentTap);
}

function seedTtrTapReadings_(tap) {
  var readings = {};
  getPhaseKeys().forEach(function (k) { readings[k] = { measuredRatio: 0, excitationCurrentMa: 0, phaseDeviationDeg: 0 }; });
  state.ttr.readings[tap] = readings;
}

function selectTap(p) {
  state.ttr.currentTap = p;
  if (!state.ttr.readings[p]) seedTtrTapReadings_(p);
  renderTapChips();
  renderPhaseEntries();
  refreshTtr();
}

function renderTapChips() {
  var row = document.getElementById('tapChipRow');
  if (!row) return;
  row.innerHTML = tapPositions().map(function (p) {
    var cls = 'tap-chip' + (p === state.ttr.currentTap ? ' current' : '') + (state.ttr.readings[p] ? ' filled' : '');
    return '<div class="' + cls + '" onclick="selectTap(' + p + ')">TAP ' + p + '</div>';
  }).join('');
}

function renderPhaseEntries() {
  var wrap = document.getElementById('ttrPhaseEntries');
  if (!wrap || state.ttr.currentTap === null) return;
  var readings = state.ttr.readings[state.ttr.currentTap];
  wrap.innerHTML = getPhaseKeys().map(function (k) {
    var r = readings[k];
    return '<div class="phase-entry">' +
      '<div class="ph-name">' + k.replace('-', ' &ndash; ') + '</div>' +
      '<div class="field"><label>Relación medida</label><input class="mono" type="number" step="0.001" value="' + r.measuredRatio + '" oninput="updateReading(\'' + k + '\',\'measuredRatio\',this.value)"></div>' +
      '<div class="field"><label>I. excitación (mA)</label><input class="mono" type="number" step="1" value="' + r.excitationCurrentMa + '" oninput="updateReading(\'' + k + '\',\'excitationCurrentMa\',this.value)"></div>' +
      '<div class="field"><label>Desviación de fase (&deg;)</label><input class="mono" type="number" step="0.01" value="' + r.phaseDeviationDeg + '" oninput="updateReading(\'' + k + '\',\'phaseDeviationDeg\',this.value)"></div>' +
      '</div>';
  }).join('');
}

function updateReading(key, field, value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.ttr.readings[state.ttr.currentTap][key][field] = v;
  refreshTtr();
}

// ---- Matriz de derivaciones personalizada ----

function resetMatrixStateFromTransformer() {
  var t = state.currentTransformer;
  var existing = t && t.custom_tap_ratio_matrix && t.custom_tap_ratio_matrix.taps;
  if (existing && existing.length) {
    state.matrix.taps = JSON.parse(JSON.stringify(existing));
  } else {
    state.matrix.taps = tapPositions().map(function (p) {
      var phases = {};
      getPhaseKeys().forEach(function (k) { phases[k] = { theoreticalRatio: 0 }; });
      return { tapPosition: p, phases: phases };
    });
  }
}

function canEditMatrix_() {
  return state.role === 'Administrador' || state.role === 'Supervisor';
}

function renderMatrixRows() {
  var tbody = document.getElementById('matrixRows');
  if (!tbody) return;
  var disabled = !canEditMatrix_();
  tbody.innerHTML = state.matrix.taps.map(function (t) {
    var v = tapVoltageFor(t.tapPosition);
    var cells = getPhaseKeys().map(function (k) {
      var val = t.phases[k] ? t.phases[k].theoreticalRatio : 0;
      return '<td><input class="mono" type="number" step="0.001" value="' + val + '" ' + (disabled ? 'disabled' : '') +
        ' onchange="updateMatrixValue(' + t.tapPosition + ',\'' + k + '\',this.value)"></td>';
    }).join('');
    return '<tr>' +
      '<td class="mono">' + t.tapPosition + '</td>' +
      '<td class="mono">' + (v != null ? Math.round(v) : '—') + '</td>' +
      cells +
      '<td><button class="matrix-remove" ' + ((disabled || state.matrix.taps.length <= 1) ? 'disabled' : '') +
      ' onclick="removeTapRow(' + t.tapPosition + ')">&times;</button></td>' +
      '</tr>';
  }).join('');

  document.getElementById('matrixLock').hidden = !disabled;
  document.getElementById('addTapBtn').disabled = disabled;
  document.getElementById('saveMatrixBtn').disabled = disabled;
}

function updateMatrixValue(tapPosition, key, value) {
  var t = state.matrix.taps.filter(function (x) { return x.tapPosition === tapPosition; })[0];
  if (!t) return;
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  t.phases[key] = { theoreticalRatio: v };
}

function addTapRow() {
  var existing = state.matrix.taps.map(function (t) { return t.tapPosition; });
  var nextPos = existing.length ? Math.max.apply(null, existing) + 1 : 1;
  var phases = {};
  getPhaseKeys().forEach(function (k) { phases[k] = { theoreticalRatio: 0 }; });
  state.matrix.taps.push({ tapPosition: nextPos, phases: phases });
  renderMatrixRows();
}

function removeTapRow(tapPosition) {
  if (state.matrix.taps.length <= 1) return;
  state.matrix.taps = state.matrix.taps.filter(function (t) { return t.tapPosition !== tapPosition; });
  renderMatrixRows();
}

function saveMatrix() {
  if (!canEditMatrix_()) return;
  var btn = document.getElementById('saveMatrixBtn');
  var status = document.getElementById('matrixSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Guardando…', false);

  callApi('updateTransformer', 'POST', {
    id: state.currentTransformerId,
    custom_tap_ratio_matrix: { source: 'Cargada desde la interfaz · ' + (state.username || 'usuario'), taps: state.matrix.taps }
  }).then(function () {
    setStatus_(status, 'Matriz guardada', true);
    state.currentTransformer.custom_tap_ratio_matrix = { taps: JSON.parse(JSON.stringify(state.matrix.taps)) };
    refreshTtr();
  }).catch(function (err) {
    if (err.status !== 402 && err.status !== 403) setStatus_(status, formatNetworkAwareError_(err), false, true);
  }).then(function () { btn.disabled = false; });
}

// ---- Cálculo local (vista previa) y payloads ----

function computeTtrPreview(p) {
  var mrow = state.matrix.taps.filter(function (t) { return t.tapPosition === p; })[0];
  var readings = state.ttr.readings[p] || {};
  var rows = getPhaseKeys().map(function (k) {
    var theoretical = mrow && mrow.phases[k] ? mrow.phases[k].theoreticalRatio : null;
    var measured = readings[k] ? readings[k].measuredRatio : null;
    if (!theoretical || measured == null || measured === 0) {
      return { key: k, measured: measured, theoretical: theoretical, errorPercent: null, status: 'pending' };
    }
    var err = ((measured - theoretical) / theoretical) * 100;
    return { key: k, measured: measured, theoretical: theoretical, errorPercent: err, status: Math.abs(err) <= TOLERANCE_PERCENT ? 'APROBADO' : 'RECHAZADO' };
  });
  var verdict = rows.some(function (r) { return r.status === 'pending'; }) ? 'PENDIENTE'
    : (rows.every(function (r) { return r.status === 'APROBADO'; }) ? 'APROBADO' : 'RECHAZADO');
  return { rows: rows, verdict: verdict };
}

function renderTtrPreview() {
  var tap = state.ttr.currentTap;
  document.getElementById('previewTapLabel').textContent = tap == null ? '—' : tap;
  if (tap == null) return;

  var result = computeTtrPreview(tap);
  document.getElementById('ttrPreviewRows').innerHTML = result.rows.map(function (r) {
    var errText, errCls;
    if (r.status === 'pending') { errText = '&mdash;'; errCls = 'pending'; }
    else { errText = (r.errorPercent >= 0 ? '+' : '') + r.errorPercent.toFixed(2) + ' %'; errCls = r.status === 'APROBADO' ? 'ok' : 'bad'; }
    var measuredTxt = r.measured != null ? r.measured.toFixed(3) : '&mdash;';
    var theoTxt = r.theoretical != null ? r.theoretical.toFixed(3) : '&mdash;';
    return '<div class="preview-row"><span class="phase-name">' + r.key + '</span>' +
      '<span class="num">medido ' + measuredTxt + ' &middot; teórico ' + theoTxt + '</span>' +
      '<span class="err ' + errCls + '">' + errText + '</span></div>';
  }).join('');

  var banner = document.getElementById('ttrVerdictBanner');
  banner.className = 'verdict-banner' + (result.verdict === 'APROBADO' ? ' success' : result.verdict === 'RECHAZADO' ? ' danger' : '');
  banner.innerHTML = 'Veredicto del TAP ' + tap + ': ' + result.verdict + '<span class="tol">tolerancia &plusmn;0.5&nbsp;%</span>';
}

function buildTtrRequestBody() {
  var measurements = {};
  Object.keys(state.ttr.readings).forEach(function (tapStr) {
    var tap = state.ttr.readings[tapStr];
    var phaseObj = {};
    getPhaseKeys().forEach(function (k) {
      if (tap[k]) {
        phaseObj[k] = { measuredRatio: tap[k].measuredRatio, excitationCurrentMa: tap[k].excitationCurrentMa, phaseDeviationDeg: tap[k].phaseDeviationDeg };
      }
    });
    measurements[tapStr] = phaseObj;
  });
  return {
    transformer_id: state.currentTransformerId,
    instrument_used: document.getElementById('ttrInstrument').value,
    readings: { testVoltageV: parseDecimal_(document.getElementById('ttrVoltage').value) || null, measurements: measurements }
  };
}

function buildMatrixRequestBody() {
  return {
    id: state.currentTransformerId,
    custom_tap_ratio_matrix: { source: 'Cargada desde la interfaz', taps: state.matrix.taps }
  };
}

function refreshTtr() {
  renderTtrPreview();
  saveDraft_('mya_draft_ttr_' + state.currentTransformerId, state.ttr.readings);
}

function submitTtr() {
  var btn = document.getElementById('submitTtrBtn');
  var status = document.getElementById('ttrSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  readFileAsBase64_(document.getElementById('ttrEvidence'))
    .then(function (evidence) {
      var body = buildTtrRequestBody();
      if (evidence) { body.file_base64 = evidence.base64; body.file_mime_type = evidence.mimeType; }
      return callApi('submitTtrTest', 'POST', body);
    })
    .then(function (data) {
      setStatus_(status, 'Prueba registrada · veredicto: ' + data.calculated_results.overallVerdict, true);
      clearDraft_('mya_draft_ttr_' + state.currentTransformerId);
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; saveDraft_('mya_cache_tests_' + state.currentTransformerId, state.currentTests); renderDetail(); })
    .catch(function (err) {
      // Las lecturas quedan intactas en state.ttr.readings y en el borrador local: el técnico puede reintentar sin volver a digitar.
      if (!err || (err.status !== 402 && err.status !== 403)) setStatus_(status, formatNetworkAwareError_(err || {}), false, true);
    })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Formulario de Resistencia de Devanados (multi-TAP)
// ---------------------------------------------------------------

function renderWindingFormContext() {
  var t = state.currentTransformer;
  document.getElementById('wrFormSubtitle').textContent = t.serial_number + ' · Desbalance entre fases';
  document.getElementById('wrTenantChip').textContent = state.username + ' · ' + state.role;
}

/** Los identificadores de fase de TTR (H1H2-X1X2) y de resistencia de devanados (H1-H2) difieren; se mapean explícitamente. */
var TTR_TO_WR_PHASE_MAP = { 'H1H2-X1X2': 'H1-H2', 'H2H3-X2X3': 'H2-H3', 'H3H1-X3X1': 'H3-H1' };

function defaultWrPhases_() {
  var p = {};
  getPhaseKeys().forEach(function (k) { p[TTR_TO_WR_PHASE_MAP[k] || k] = { resistanceOhm: 0 }; });
  return p;
}

function resetWindingStateFromTransformer() {
  var positions = tapPositions();
  var firstTap = positions.length ? positions[0] : 1;
  var draft = loadDraft_('mya_draft_wr_' + state.currentTransformerId);
  if (draft) {
    state.wr.readings = draft;
    state.wr.currentTap = Object.keys(draft).map(Number).sort(function (a, b) { return a - b; })[0];
    return;
  }
  state.wr.currentTap = firstTap;
  state.wr.readings = {};
  state.wr.readings[firstTap] = { windingTemperatureC: 25, phases: defaultWrPhases_() };
}

function renderWrTapChips() {
  var row = document.getElementById('wrTapChipRow');
  if (!row) return;
  var taps = Object.keys(state.wr.readings).map(Number).sort(function (a, b) { return a - b; });
  row.innerHTML = taps.map(function (p) {
    var cls = 'tap-chip filled' + (p === state.wr.currentTap ? ' current' : '');
    return '<div class="' + cls + '" onclick="selectWrTap(' + p + ')">TAP ' + p + '</div>';
  }).join('');
  document.getElementById('wrTapCountLabel').textContent = taps.length;
  document.getElementById('removeWrTapBtn').disabled = taps.length <= 1;
}

function selectWrTap(p) {
  state.wr.currentTap = p;
  if (!state.wr.readings[p]) {
    state.wr.readings[p] = { windingTemperatureC: 25, phases: defaultWrPhases_() };
  }
  renderWrTapChips();
  renderWrPhaseEntries();
  refreshWinding();
}

function renderWrPhaseEntries() {
  var wrap = document.getElementById('wrPhaseEntries');
  if (!wrap) return;
  var tap = state.wr.readings[state.wr.currentTap];
  document.getElementById('wrTemp').value = tap.windingTemperatureC;
  document.getElementById('wrTempTapLabel').textContent = state.wr.currentTap;
  document.getElementById('wrPreviewTapLabel').textContent = state.wr.currentTap;
  wrap.innerHTML = Object.keys(tap.phases).map(function (k) {
    var r = tap.phases[k];
    return '<div class="phase-entry">' +
      '<div class="ph-name">' + k.replace('-', ' &ndash; ') + '</div>' +
      '<div class="field"><label>Resistencia (&Omega;)</label><input class="mono" type="number" step="0.0001" value="' + r.resistanceOhm + '" oninput="updateWrPhase(\'' + k + '\',this.value)"></div>' +
      '</div>';
  }).join('');
}

function updateWrPhase(key, value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.wr.readings[state.wr.currentTap].phases[key] = { resistanceOhm: v };
  refreshWinding();
}

function updateWrTemp(value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.wr.readings[state.wr.currentTap].windingTemperatureC = v;
  refreshWinding();
}

function addWrTap() {
  var existing = Object.keys(state.wr.readings).map(Number);
  var configured = tapPositions();
  var gaps = configured.filter(function (p) { return existing.indexOf(p) === -1; });
  var nextPos = gaps.length ? Math.min.apply(null, gaps) : (existing.length ? Math.max.apply(null, existing) + 1 : 1);
  state.wr.readings[nextPos] = { windingTemperatureC: state.wr.readings[state.wr.currentTap].windingTemperatureC, phases: defaultWrPhases_() };
  selectWrTap(nextPos);
}

function removeWrTap() {
  var keys = Object.keys(state.wr.readings).map(Number);
  if (keys.length <= 1) return;
  delete state.wr.readings[state.wr.currentTap];
  var remaining = Object.keys(state.wr.readings).map(Number).sort(function (a, b) { return a - b; });
  selectWrTap(remaining[0]);
}

function computeWindingPreview(p) {
  var tap = state.wr.readings[p];
  var keys = Object.keys(tap.phases);
  var values = keys.map(function (k) { return tap.phases[k].resistanceOhm; });
  var avg = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
  var rows = keys.map(function (k) {
    var dev = avg !== 0 ? ((tap.phases[k].resistanceOhm - avg) / avg) * 100 : 0;
    return { key: k, value: tap.phases[k].resistanceOhm, deviation: dev, status: Math.abs(dev) <= UNBALANCE_THRESHOLD ? 'APROBADO' : 'RECHAZADO' };
  });
  var maxUnbalance = rows.length > 1 ? Math.max.apply(null, rows.map(function (r) { return Math.abs(r.deviation); })) : 0;
  var verdict = maxUnbalance <= UNBALANCE_THRESHOLD ? 'APROBADO' : 'RECHAZADO';
  return { rows: rows, average: avg, maxUnbalance: maxUnbalance, verdict: verdict };
}

function renderWindingPreview() {
  var result = computeWindingPreview(state.wr.currentTap);
  document.getElementById('wrPreviewRows').innerHTML = result.rows.map(function (r) {
    var cls = r.status === 'APROBADO' ? 'ok' : 'bad';
    return '<div class="preview-row"><span class="phase-name">' + r.key + '</span>' +
      '<span class="num">' + r.value.toFixed(4) + ' &Omega; &middot; prom. ' + result.average.toFixed(4) + ' &Omega;</span>' +
      '<span class="err ' + cls + '">' + (r.deviation >= 0 ? '+' : '') + r.deviation.toFixed(2) + ' %</span></div>';
  }).join('');
  var banner = document.getElementById('wrVerdictBanner');
  banner.className = 'verdict-banner ' + (result.verdict === 'APROBADO' ? 'success' : 'danger');
  banner.innerHTML = 'Veredicto TAP ' + state.wr.currentTap + ': ' + result.verdict +
    '<span class="tol">desbalance máx. ' + result.maxUnbalance.toFixed(2) + ' % &middot; umbral 5&nbsp;%</span>';
}

function buildWindingRequestBody() {
  var taps = Object.keys(state.wr.readings).map(Number).sort(function (a, b) { return a - b; });
  return {
    transformer_id: state.currentTransformerId,
    instrument_used: document.getElementById('wrInstrument').value,
    readings: {
      measurements: taps.map(function (p) {
        var tap = state.wr.readings[p];
        return { tapPosition: p, windingTemperatureC: tap.windingTemperatureC, phases: tap.phases };
      })
    }
  };
}

function refreshWinding() {
  renderWrTapChips();
  renderWrPhaseEntries();
  renderWindingPreview();
  saveDraft_('mya_draft_wr_' + state.currentTransformerId, state.wr.readings);
}

function submitWinding() {
  var btn = document.getElementById('submitWrBtn');
  var status = document.getElementById('wrSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  readFileAsBase64_(document.getElementById('wrEvidence'))
    .then(function (evidence) {
      var body = buildWindingRequestBody();
      if (evidence) { body.file_base64 = evidence.base64; body.file_mime_type = evidence.mimeType; }
      return callApi('submitWindingResistanceTest', 'POST', body);
    })
    .then(function (data) {
      setStatus_(status, 'Prueba registrada · veredicto: ' + data.calculated_results.overallVerdict, true);
      clearDraft_('mya_draft_wr_' + state.currentTransformerId);
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; saveDraft_('mya_cache_tests_' + state.currentTransformerId, state.currentTests); renderDetail(); })
    .catch(function (err) {
      // Las lecturas quedan intactas en state.wr.readings y en el borrador local: el técnico puede reintentar sin volver a digitar.
      if (!err || (err.status !== 402 && err.status !== 403)) setStatus_(status, formatNetworkAwareError_(err || {}), false, true);
    })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Formulario de Aceite Dieléctrico
// ---------------------------------------------------------------

function renderOilFormContext() {
  var t = state.currentTransformer;
  document.getElementById('oilFormSubtitle').textContent = t.serial_number + ' · marca solo las secciones que apliquen a esta visita';
  document.getElementById('oilTenantChip').textContent = state.username + ' · ' + state.role;
}

/** Genera los campos repetitivos de DGA (9 gases) y PCB (7 Aroclores) una sola vez —
 *  se llama en DOMContentLoaded, no en cada apertura del formulario. */
function buildOilDgaGrid_() {
  var grid = document.getElementById('oilDgaGrid');
  if (!grid || grid.childElementCount) return;
  grid.innerHTML = OIL_DGA_GASES.map(function (g) {
    return '<div class="field"><label>' + g.label + ' (ppm)</label>' +
      '<input class="mono" id="oilDga_' + g.key + '" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" oninput="refreshOil()"></div>';
  }).join('');
}
function buildOilPcbGrid_() {
  var grid = document.getElementById('oilPcbGrid');
  if (!grid || grid.childElementCount) return;
  grid.innerHTML = OIL_PCB_AROCLORES.map(function (key) {
    return '<div class="field"><label>Aroclor ' + key.split('_')[1] + ' (ppm)</label>' +
      '<input class="mono" id="oilPcb_' + key + '" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" oninput="refreshOil()"></div>';
  }).join('');
}

function emptyOilState_() {
  return {
    sampleBy: '', sampleDate: '',
    fisicoquimico_realizado: false, dga_realizado: false, pcb_realizado: false,
    agua_ppm: null, rigidez_dielectrica_kv: null, tension_interfacial_dinas_cm: null,
    numero_acido_mg_koh_g: null, densidad_relativa: null, color_astm: '', examen_visual: '',
    dga: {}, pcb: {}
  };
}

function resetOilStateFromTransformer() {
  var draft = loadDraft_('mya_draft_oil_' + state.currentTransformerId);
  state.oil = draft || emptyOilState_();
  var certificateInput = document.getElementById('oilCertificate');
  if (certificateInput) certificateInput.value = '';
  if (!state.oil.dga) state.oil.dga = {};
  if (!state.oil.pcb) state.oil.pcb = {};

  document.getElementById('oilSampleBy').value = state.oil.sampleBy || '';
  document.getElementById('oilSampleDate').value = state.oil.sampleDate || '';

  document.getElementById('oilSectionFisicoquimico').checked = !!state.oil.fisicoquimico_realizado;
  document.getElementById('oilBodyFisicoquimico').hidden = !state.oil.fisicoquimico_realizado;
  document.getElementById('oilAgua').value = state.oil.agua_ppm != null ? state.oil.agua_ppm : '';
  document.getElementById('oilRigidez').value = state.oil.rigidez_dielectrica_kv != null ? state.oil.rigidez_dielectrica_kv : '';
  document.getElementById('oilTension').value = state.oil.tension_interfacial_dinas_cm != null ? state.oil.tension_interfacial_dinas_cm : '';
  document.getElementById('oilAcidez').value = state.oil.numero_acido_mg_koh_g != null ? state.oil.numero_acido_mg_koh_g : '';
  document.getElementById('oilDensidad').value = state.oil.densidad_relativa != null ? state.oil.densidad_relativa : '';
  document.getElementById('oilColorAstm').value = state.oil.color_astm || '';
  document.getElementById('oilExamenVisual').value = state.oil.examen_visual || '';

  document.getElementById('oilSectionDga').checked = !!state.oil.dga_realizado;
  document.getElementById('oilBodyDga').hidden = !state.oil.dga_realizado;
  OIL_DGA_GASES.forEach(function (g) {
    var el = document.getElementById('oilDga_' + g.key);
    if (el) el.value = state.oil.dga[g.key] != null ? state.oil.dga[g.key] : '';
  });

  document.getElementById('oilSectionPcb').checked = !!state.oil.pcb_realizado;
  document.getElementById('oilBodyPcb').hidden = !state.oil.pcb_realizado;
  OIL_PCB_AROCLORES.forEach(function (key) {
    var el = document.getElementById('oilPcb_' + key);
    if (el) el.value = state.oil.pcb[key] != null ? state.oil.pcb[key] : '';
  });
}

function toggleOilSection_(section) {
  var checkboxIds = { fisicoquimico: 'oilSectionFisicoquimico', dga: 'oilSectionDga', pcb: 'oilSectionPcb' };
  var bodyIds = { fisicoquimico: 'oilBodyFisicoquimico', dga: 'oilBodyDga', pcb: 'oilBodyPcb' };
  var checked = document.getElementById(checkboxIds[section]).checked;
  document.getElementById(bodyIds[section]).hidden = !checked;
  state.oil[section + '_realizado'] = checked;
  refreshOil();
}

/** Debe replicar EXACTAMENTE calculateOilAnalysis_ en Código.gs: misma matriz de
 *  Fisicoquímico, mismo umbral de PCB, mismo criterio de "más severo gana" para
 *  combinar hasta dos veredictos (Fisicoquímico + PCB) en un solo overallVerdict.
 *  DGA nunca aporta veredicto — es solo captura de datos. */
function calculateOilPreview_(readings) {
  var sections = {};
  var overallVerdict = null;
  var overallSeverity = 0;
  function consider(verdict, severity) {
    if (severity > overallSeverity) { overallSeverity = severity; overallVerdict = verdict; }
  }

  if (readings.fisicoquimico_realizado) {
    var rigidez = readings.rigidez_dielectrica_kv, agua = readings.agua_ppm,
      acidez = readings.numero_acido_mg_koh_g, tension = readings.tension_interfacial_dinas_cm;
    var complete = [rigidez, agua, acidez, tension].every(function (v) { return typeof v === 'number' && !isNaN(v); });
    if (complete) {
      var fqVerdict, fqSeverity;
      if (acidez >= OIL_ACIDEZ_MAX || tension <= OIL_TENSION_INTERFACIAL_MIN) { fqVerdict = 'REQUIERE REGENERACIÓN / CAMBIO'; fqSeverity = 3; }
      else if (rigidez <= OIL_RIGIDEZ_MIN || agua >= OIL_HUMEDAD_MAX) { fqVerdict = 'REQUIERE TERMOVACÍO'; fqSeverity = 2; }
      else { fqVerdict = 'APROBADO'; fqSeverity = 1; }
      sections.fisicoquimico = { verdict: fqVerdict, complete: true };
      consider(fqVerdict, fqSeverity);
    } else {
      sections.fisicoquimico = { verdict: 'Faltan datos', complete: false };
    }
  }

  if (readings.dga_realizado) {
    sections.dga = { registrado: true };
  }

  if (readings.pcb_realizado) {
    var total = 0;
    OIL_PCB_AROCLORES.forEach(function (key) {
      var v = readings[key];
      if (typeof v === 'number' && !isNaN(v)) total += v;
    });
    var contaminado = total >= OIL_PCB_LIMITE_PPM;
    var pcbVerdict = contaminado ? 'Contaminado — requiere manejo especial (Res. 222 de 2011, MinAmbiente)' : 'No contaminado';
    sections.pcb = { totalPcbPpm: total, verdict: pcbVerdict };
    consider(pcbVerdict, contaminado ? 3 : 1);
  }

  if (!overallVerdict && (readings.fisicoquimico_realizado || readings.dga_realizado || readings.pcb_realizado)) {
    overallVerdict = 'REGISTRADO';
  }

  return { sections: sections, overallVerdict: overallVerdict };
}

function renderOilPreview() {
  var readings = buildOilRequestBody().readings;
  var result = calculateOilPreview_(readings);
  var rows = [];

  if (state.oil.fisicoquimico_realizado) {
    var fq = result.sections.fisicoquimico;
    rows.push(['Fisicoquímico', fq.verdict, !fq.complete ? 'pending' : (fq.verdict === 'APROBADO' ? 'ok' : 'bad')]);
  }
  if (state.oil.dga_realizado) {
    rows.push(['DGA', 'Registrado (sin veredicto automático)', 'pending']);
  }
  if (state.oil.pcb_realizado) {
    var pcb = result.sections.pcb;
    rows.push(['PCB · Total', pcb.totalPcbPpm.toFixed(2) + ' ppm', 'pending']);
    rows.push(['PCB · Veredicto', pcb.verdict, pcb.verdict === 'No contaminado' ? 'ok' : 'bad']);
    document.getElementById('oilPcbTotal').textContent = pcb.totalPcbPpm.toFixed(2) + ' ppm';
    document.getElementById('oilPcbVerdictLabel').textContent = pcb.verdict;
  }

  document.getElementById('oilPreviewRows').innerHTML = rows.length
    ? rows.map(function (r) {
        return '<div class="preview-row"><span class="phase-name">' + r[0] + '</span><span class="num"></span>' +
          '<span class="err ' + r[2] + '">' + r[1] + '</span></div>';
      }).join('')
    : '<div class="empty-note">Activa al menos una sección para ver la vista previa.</div>';

  var banner = document.getElementById('oilVerdictBanner');
  if (!result.overallVerdict) {
    banner.className = 'verdict-banner';
    banner.innerHTML = 'Activa al menos una sección';
    return;
  }
  var bannerCls = 'verdict-banner';
  if (result.overallVerdict === 'APROBADO' || result.overallVerdict === 'No contaminado') bannerCls += ' success';
  else if (result.overallVerdict === 'REQUIERE TERMOVACÍO') bannerCls += ' warning';
  else if (result.overallVerdict === 'REQUIERE REGENERACIÓN / CAMBIO' || result.overallVerdict.indexOf('Contaminado') === 0) bannerCls += ' danger';
  banner.className = bannerCls;
  banner.innerHTML = 'Dictamen: ' + result.overallVerdict;
}

function parseOilNum_(id) {
  var el = document.getElementById(id);
  if (!el) return null;
  var v = parseDecimal_(el.value);
  return isNaN(v) ? null : v;
}

/** Cada sección desactivada envía sus campos en null (nunca 0 por defecto) — un 0 en
 *  número ácido o en un Aroclor es un dato real, no debe confundirse con "no medido". */
function buildOilRequestBody() {
  var readings = {
    fisicoquimico_realizado: !!state.oil.fisicoquimico_realizado,
    dga_realizado: !!state.oil.dga_realizado,
    pcb_realizado: !!state.oil.pcb_realizado,
    sample_taken_by: state.oil.sampleBy || null,
    sample_date: state.oil.sampleDate || null
  };

  if (state.oil.fisicoquimico_realizado) {
    readings.agua_ppm = state.oil.agua_ppm;
    readings.rigidez_dielectrica_kv = state.oil.rigidez_dielectrica_kv;
    readings.tension_interfacial_dinas_cm = state.oil.tension_interfacial_dinas_cm;
    readings.numero_acido_mg_koh_g = state.oil.numero_acido_mg_koh_g;
    readings.densidad_relativa = state.oil.densidad_relativa;
    readings.color_astm = state.oil.color_astm || null;
    readings.examen_visual = state.oil.examen_visual || null;
  } else {
    readings.agua_ppm = null;
    readings.rigidez_dielectrica_kv = null;
    readings.tension_interfacial_dinas_cm = null;
    readings.numero_acido_mg_koh_g = null;
    readings.densidad_relativa = null;
    readings.color_astm = null;
    readings.examen_visual = null;
  }

  OIL_DGA_GASES.forEach(function (g) {
    readings[g.key] = state.oil.dga_realizado ? state.oil.dga[g.key] : null;
  });
  OIL_PCB_AROCLORES.forEach(function (key) {
    readings[key] = state.oil.pcb_realizado ? state.oil.pcb[key] : null;
  });

  return { transformer_id: state.currentTransformerId, readings: readings };
}

function refreshOil() {
  state.oil.sampleBy = document.getElementById('oilSampleBy').value.trim();
  state.oil.sampleDate = document.getElementById('oilSampleDate').value;

  state.oil.agua_ppm = parseOilNum_('oilAgua');
  state.oil.rigidez_dielectrica_kv = parseOilNum_('oilRigidez');
  state.oil.tension_interfacial_dinas_cm = parseOilNum_('oilTension');
  state.oil.numero_acido_mg_koh_g = parseOilNum_('oilAcidez');
  state.oil.densidad_relativa = parseOilNum_('oilDensidad');
  state.oil.color_astm = document.getElementById('oilColorAstm').value || '';
  state.oil.examen_visual = document.getElementById('oilExamenVisual').value || '';

  OIL_DGA_GASES.forEach(function (g) { state.oil.dga[g.key] = parseOilNum_('oilDga_' + g.key); });
  OIL_PCB_AROCLORES.forEach(function (key) { state.oil.pcb[key] = parseOilNum_('oilPcb_' + key); });

  renderOilPreview();
  saveDraft_('mya_draft_oil_' + state.currentTransformerId, state.oil);
}

function submitOil() {
  var btn = document.getElementById('submitOilBtn');
  var status = document.getElementById('oilSubmitStatus');

  if (!state.oil.fisicoquimico_realizado && !state.oil.dga_realizado && !state.oil.pcb_realizado) {
    setStatus_(status, 'Activa al menos una sección (Fisicoquímico, DGA o PCB) antes de enviar', false, true);
    return;
  }

  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  readFileAsBase64_(document.getElementById('oilCertificate'))
    .then(function (evidence) {
      var body = buildOilRequestBody();
      if (evidence) { body.file_base64 = evidence.base64; body.file_mime_type = evidence.mimeType; }
      return callApi('submitOilAnalysisTest', 'POST', body);
    })
    .then(function (data) {
      setStatus_(status, 'Prueba registrada · dictamen: ' + data.calculated_results.overallVerdict, true);
      clearDraft_('mya_draft_oil_' + state.currentTransformerId);
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; saveDraft_('mya_cache_tests_' + state.currentTransformerId, state.currentTests); renderDetail(); })
    .catch(function (err) {
      // Las lecturas quedan intactas en state.oil y en el borrador local: se puede reintentar sin volver a digitar.
      if (!err || (err.status !== 402 && err.status !== 403)) setStatus_(status, formatNetworkAwareError_(err || {}), false, true);
    })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Formulario de Resistencia de Aislamiento (Megger) — DAR / IP
//
// Réplica en frontend de darRating_/ipRating_ en Código.gs: DAR y umbrales
// de calculateInsulation_ (backend real). El backend solo necesita
// readings.measurements[fase] = { r30sMegaohm, r60sMegaohm, r10minMegaohm }
// — NO existe un campo "1 min" separado de "60 s" (60 s === 1 min), así que
// solo se captura una vez. La temperatura de devanado se guarda junto a las
// lecturas para el registro, pero calculateInsulation_ no la usa en el
// cálculo (documentado también en CLAUDE.md).
// ---------------------------------------------------------------

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

function defaultInsulationPhases_() {
  var p = {};
  getPhaseKeys().forEach(function (k) { p[TTR_TO_WR_PHASE_MAP[k] || k] = { r30sMegaohm: 0, r60sMegaohm: 0, r10minMegaohm: 0 }; });
  return p;
}

function resetInsulationStateFromTransformer() {
  var draft = loadDraft_('mya_draft_insulation_' + state.currentTransformerId);
  state.insulation = draft || { windingTemperatureC: 20, phases: defaultInsulationPhases_() };
  if (!state.insulation.phases) state.insulation.phases = defaultInsulationPhases_();
  var evidenceInput = document.getElementById('insulationEvidence');
  if (evidenceInput) evidenceInput.value = '';
}

function renderInsulationFormContext() {
  var t = state.currentTransformer;
  document.getElementById('insulationFormSubtitle').textContent = t.serial_number + ' · DAR e IP por fase';
  document.getElementById('insulationTenantChip').textContent = state.username + ' · ' + state.role;
}

function renderInsulationPhaseEntries() {
  var wrap = document.getElementById('insulationPhaseEntries');
  if (!wrap) return;
  document.getElementById('insulationTemp').value = state.insulation.windingTemperatureC;
  wrap.innerHTML = Object.keys(state.insulation.phases).map(function (k) {
    var r = state.insulation.phases[k];
    return '<div class="phase-entry">' +
      '<div class="ph-name">' + k.replace('-', ' &ndash; ') + '</div>' +
      '<div class="field"><label>R 30 s (M&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.r30sMegaohm + '" oninput="updateInsulationPhase_(\'' + k + '\', \'r30sMegaohm\', this.value)"></div>' +
      '<div class="field"><label>R 60 s / 1 min (M&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.r60sMegaohm + '" oninput="updateInsulationPhase_(\'' + k + '\', \'r60sMegaohm\', this.value)"></div>' +
      '<div class="field"><label>R 10 min (M&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.r10minMegaohm + '" oninput="updateInsulationPhase_(\'' + k + '\', \'r10minMegaohm\', this.value)"></div>' +
      '</div>';
  }).join('');
}

function updateInsulationPhase_(key, field, value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.insulation.phases[key][field] = v;
  refreshInsulation();
}

function updateInsulationTemp(value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.insulation.windingTemperatureC = v;
  refreshInsulation();
}

function computeInsulationPreview() {
  var keys = Object.keys(state.insulation.phases);
  var hasMalo = false, hasCuestionable = false;
  var rows = keys.map(function (k) {
    var r = state.insulation.phases[k];
    var dar = r.r30sMegaohm > 0 ? (r.r60sMegaohm / r.r30sMegaohm) : 0;
    var ip = r.r60sMegaohm > 0 ? (r.r10minMegaohm / r.r60sMegaohm) : 0;
    var dRating = darRating_(dar);
    var iRating = ipRating_(ip);
    if (dRating === 'MALO' || iRating === 'MALO') hasMalo = true;
    if (dRating === 'CUESTIONABLE' || iRating === 'CUESTIONABLE') hasCuestionable = true;
    return { key: k, dar: dar, darRating: dRating, ip: ip, ipRating: iRating };
  });
  var verdict = hasMalo ? 'RECHAZADO' : (hasCuestionable ? 'OBSERVADO' : 'APROBADO');
  return { rows: rows, verdict: verdict };
}

function ratingClass_(rating) {
  if (rating === 'MALO') return 'bad';
  if (rating === 'CUESTIONABLE') return 'warn';
  return 'ok';
}

function renderInsulationPreview() {
  var result = computeInsulationPreview();
  document.getElementById('insulationPreviewRows').innerHTML = result.rows.map(function (r) {
    return '<div class="preview-row"><span class="phase-name">' + r.key + '</span>' +
      '<span class="num">DAR = ' + r.dar.toFixed(2) + '</span>' +
      '<span class="err ' + ratingClass_(r.darRating) + '">' + r.darRating + '</span></div>' +
      '<div class="preview-row"><span class="phase-name">' + r.key + '</span>' +
      '<span class="num">IP = ' + r.ip.toFixed(2) + '</span>' +
      '<span class="err ' + ratingClass_(r.ipRating) + '">' + r.ipRating + '</span></div>';
  }).join('');
  var banner = document.getElementById('insulationVerdictBanner');
  banner.className = 'verdict-banner ' + (result.verdict === 'APROBADO' ? 'success' : result.verdict === 'OBSERVADO' ? 'warning' : 'danger');
  banner.innerHTML = 'Veredicto: ' + result.verdict;
}

function buildInsulationRequestBody() {
  return {
    transformer_id: state.currentTransformerId,
    instrument_used: document.getElementById('insulationInstrument').value,
    readings: {
      windingTemperatureC: state.insulation.windingTemperatureC,
      measurements: state.insulation.phases
    }
  };
}

function refreshInsulation() {
  renderInsulationPhaseEntries();
  renderInsulationPreview();
  saveDraft_('mya_draft_insulation_' + state.currentTransformerId, state.insulation);
}

function submitInsulation() {
  var btn = document.getElementById('submitInsulationBtn');
  var status = document.getElementById('insulationSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  readFileAsBase64_(document.getElementById('insulationEvidence'))
    .then(function (evidence) {
      var body = buildInsulationRequestBody();
      if (evidence) { body.file_base64 = evidence.base64; body.file_mime_type = evidence.mimeType; }
      return callApi('submitInsulationTest', 'POST', body);
    })
    .then(function (data) {
      setStatus_(status, 'Prueba registrada · veredicto: ' + data.calculated_results.overallVerdict, true);
      clearDraft_('mya_draft_insulation_' + state.currentTransformerId);
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; saveDraft_('mya_cache_tests_' + state.currentTransformerId, state.currentTests); renderDetail(); })
    .catch(function (err) {
      // Las lecturas quedan intactas en state.insulation y en el borrador local: se puede reintentar sin volver a digitar.
      if (!err || (err.status !== 402 && err.status !== 403)) setStatus_(status, formatNetworkAwareError_(err || {}), false, true);
    })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);
  document.getElementById('changePasswordForm').addEventListener('submit', handleChangePasswordSubmit);
  document.getElementById('createSiteForm').addEventListener('submit', handleCreateSiteSubmit);
  document.getElementById('createTransformerForm').addEventListener('submit', handleCreateTransformerSubmit);
  document.getElementById('editSiteForm').addEventListener('submit', handleEditSiteSubmit);
  document.getElementById('editTransformerForm').addEventListener('submit', handleEditTransformerSubmit);

  document.querySelectorAll('.nav-item[data-view], .bottom-nav-item[data-view], .action-sheet-item[data-view]').forEach(function (el) {
    el.addEventListener('click', function () { showView(el.dataset.view); });
  });

  document.getElementById('bottomNavFab').addEventListener('click', function () { openTestActionSheet_(); });
  document.getElementById('bottomNavMoreBtn').addEventListener('click', function () { openMoreActionSheet_(); });
  document.getElementById('testSheetBackdrop').addEventListener('click', function () { closeActionSheet_('testActionSheet'); });
  document.getElementById('moreSheetBackdrop').addEventListener('click', function () { closeActionSheet_('moreActionSheet'); });
  document.getElementById('contextModalBackdrop').addEventListener('click', function () { closeContextModal_(); });
  document.getElementById('editSiteModalBackdrop').addEventListener('click', function () { closeEditSiteModal_(); });
  document.getElementById('editTransformerModalBackdrop').addEventListener('click', function () { closeEditTransformerModal_(); });

  buildOilDgaGrid_();
  buildOilPcbGrid_();

  attachRippleDelegation_();

  // Sesión persistente: si sessionStorage trae un token de esta misma pestaña
  // (sobrevive a un refresh, muere al cerrar el navegador), se usa directo sin
  // pedir credenciales de nuevo. Si el token ya no es válido, la primera
  // llamada a callApi() lo detecta (403) y fuerza logout igual que siempre.
  var session = loadSession_();
  if (session && session.token) {
    state.token = session.token;
    state.username = session.username;
    state.role = session.role;
    state.allowedApps = session.allowedApps || [];
    document.getElementById('sidebarUserName').textContent = state.username;
    document.getElementById('sidebarRole').textContent = state.role;
    document.getElementById('dashboardTenantLabel').textContent = state.username + ' · ' + state.role;
    renderAdminNavAndPanel();
    renderRestrictedModuleNav_();
    loadSitesAndShow_();
  } else {
    showView('login');
  }
});

// ---------------------------------------------------------------
// Hojas de acciones (bottom sheets): "Nueva prueba" y "Más"
// ---------------------------------------------------------------

function backdropIdFor_(sheetId) {
  return sheetId === 'testActionSheet' ? 'testSheetBackdrop' : 'moreSheetBackdrop';
}

function openActionSheet_(sheetId) {
  document.getElementById(sheetId).classList.add('open');
  document.getElementById(backdropIdFor_(sheetId)).classList.add('open');
}

function closeActionSheet_(sheetId) {
  var sheet = document.getElementById(sheetId);
  if (sheet) sheet.classList.remove('open');
  var backdrop = document.getElementById(backdropIdFor_(sheetId));
  if (backdrop) backdrop.classList.remove('open');
}

function openTestActionSheet_() {
  var hasEquipment = !!state.currentTransformer;
  var subtitle = document.getElementById('testSheetSubtitle');
  subtitle.textContent = hasEquipment
    ? state.currentTransformer.serial_number + ' · elige el tipo de prueba'
    : 'Elige un tipo de prueba — te pedirá cliente y equipo si aún no los has seleccionado';
  openActionSheet_('testActionSheet');
}

function openMoreActionSheet_() {
  document.getElementById('moreSheetUser').textContent = (state.username || '—') + ' · ' + (state.role || '—');
  openActionSheet_('moreActionSheet');
}

// ---------------------------------------------------------------
// Microinteracción: ripple táctil (delegado, cubre elementos re-renderizados)
// ---------------------------------------------------------------

function attachRippleDelegation_() {
  var selector = '.btn, .nav-item, .tap-chip, .bottom-nav-item, .bottom-nav-fab, .action-sheet-item, .modal-list-item';
  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest(selector);
    if (!el || el.disabled) return;
    var rect = el.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    el.appendChild(ripple);
    ripple.addEventListener('animationend', function () { ripple.remove(); });
  });
}
