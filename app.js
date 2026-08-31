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
const API_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwhVAjRgkfyxFjjLM2-6wlfDuurzhS2HLW2A3gS_NKziW6fyMlXuXrwcTrjmp7oZG1Ufg/exec";

/** Servicio de autenticación: login, cambio de contraseña, creación de usuarios. */
const CONTROL_ACCESO_URL = "https://script.google.com/macros/s/AKfycby4K-qxW87hfd9Fy1wKHeyF8bic_Qo8clKfJ-ZuPg9zElNuc7XOe8qTgW8sUmJ9mnKjDA/exec";

/** Identificador de esta app dentro de Control de Acceso (fila en la hoja Config). */
const APP_ID = "MYA_PRUEBAS";

const TOLERANCE_PERCENT = 0.5;
const UNBALANCE_THRESHOLD = 5.0;

/** Debe reflejar exactamente VECTOR_GROUP_MULTIPLIERS en Código.gs (calculateTtr_) —
 *  es la vista previa local del mismo cálculo que hace el backend al guardar. Si
 *  cambias un factor o agregas un grupo, cámbialo en los dos lados. */
const VECTOR_GROUP_MULTIPLIERS = {
  Dyn11: Math.sqrt(3), Dyn5: Math.sqrt(3), Dyn1: Math.sqrt(3), Dyn7: Math.sqrt(3),
  Yyn0: 1, Yyn6: 1, Dd0: 1,
  Yd1: 1 / Math.sqrt(3), Yd11: 1 / Math.sqrt(3),
  Ynd1: 1 / Math.sqrt(3), Ynd11: 1 / Math.sqrt(3)
};

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
  wr: { currentTap: null, readings: {}, secondary: null },
  oil: { rigidez: null, humedad: null, acidez: null, tension: null },
  insulation: { windingTemperatureC: 20, phases: {} },
  documents: [],
  ofertas: [],
  currentOfertaId: null,
  calibraciones: [],
  currentCalibracionId: null
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

  if (name === 'ttr-form') { renderTtrFormContext(); renderMatrixRows(); renderTapChips(); renderPhaseEntries(); refreshTtr(); loadInstrumentCatalogForTestForms_(); }
  if (name === 'winding-form') { renderWindingFormContext(); refreshWinding(); loadInstrumentCatalogForTestForms_(); }
  if (name === 'oil-form') { renderOilFormContext(); refreshOil(); }
  if (name === 'insulation-form') { renderInsulationFormContext(); refreshInsulation(); loadInstrumentCatalogForTestForms_(); }
  if (name === 'documents') { renderDocumentsView_(); }
  if (name === 'commercial') { renderCommercialView_(); }
  if (name === 'general-dashboard') { renderGeneralDashboardView_(); }
  if (name === 'calibrations') { renderCalibrationsView_(); }
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
  var tapPositionsRaw = document.getElementById('newTrfTapPositions').value.trim();
  var tapPositionsCount = tapPositionsRaw ? parseInt(tapPositionsRaw, 10) : null;
  if (tapPositionsCount !== null && (isNaN(tapPositionsCount) || tapPositionsCount < 1)) tapPositionsCount = null;
  var btn = document.getElementById('createTransformerBtn');
  var status = document.getElementById('createTransformerStatus');
  var siteId = state.currentSiteId;
  btn.disabled = true;
  setStatus_(status, 'Verificando número de serie…', false);

  var nominalForTaps = isNaN(hv) ? 0 : hv;
  var effectiveTapCount = tapPositionsCount || 5;

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
        numero_posiciones_tap: tapPositionsCount,
        is_special_design: false,
        tap_config: {
          nominalVoltage: nominalForTaps,
          stepPercentage: 2.5,
          numPositions: effectiveTapCount,
          neutralPosition: Math.ceil(effectiveTapCount / 2),
          positions: buildDefaultTapPositions_(nominalForTaps, effectiveTapCount)
        },
        file_base64: photo ? photo.base64 : null,
        file_mime_type: photo ? photo.mimeType : null
      };

      // Local-first: el equipo aparece de inmediato en el panel con id temporal;
      // el POST real (incluida la foto de placa) corre en segundo plano.
      var tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      state.transformers.push(Object.assign({
        id: tempId, updated_at: new Date().toISOString(), estado_equipo: 'Activo', _pending: true
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

  // El número de serie pudo haberse registrado desde otro dispositivo mientras
  // este registro estaba pendiente — se revalida antes de reenviar a ciegas.
  // En un reintento de EDICIÓN, un match contra el propio id no es conflicto
  // (es el mismo equipo con su serie sin cambios).
  checkSerialExists_(payload.serial_number)
    .then(function (existing) {
      if (existing && existing.id !== id) {
        return Promise.reject({ __serialConflict: true, existing: existing });
      }
      return callApi(action, 'POST', payload);
    })
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
      var isConflict = err && err.__serialConflict;
      var message = isConflict
        ? 'Conflicto: el número de serie "' + payload.serial_number + '" ya quedó registrado desde otro dispositivo mientras este registro estaba pendiente. No se reenvió — revísalo antes de reintentar.'
        : formatNetworkAwareError_(err);
      if (r) { r._pending = false; r._error = true; r._errorMessage = message; }
      saveDraft_('mya_cache_transformers_' + siteId, state.transformers);
      if (state.currentSiteId === siteId) renderDashboard();
      showToast_(isConflict ? message : ('Sigue sin poder sincronizarse. ' + message), 'error');
    });
}

function openEditTransformerModal_() {
  var t = state.currentTransformer;
  if (!t) return;
  document.getElementById('editTrfEstadoEquipo').value = t.estado_equipo || 'Activo';
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
  document.getElementById('editTrfTapPositions').value = t.numero_posiciones_tap || '';
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
    estado_equipo: document.getElementById('editTrfEstadoEquipo').value,
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

  // El número de posiciones de TAP solo se toca si el técnico lo diligenció;
  // vacío = se mantiene el tap_config actual del equipo tal cual (no rompe
  // equipos ya creados ni sus TAPs ya registrados en pruebas anteriores).
  var tapPositionsRaw = document.getElementById('editTrfTapPositions').value.trim();
  if (tapPositionsRaw) {
    var tapPositionsCount = parseInt(tapPositionsRaw, 10);
    if (!isNaN(tapPositionsCount) && tapPositionsCount > 0) {
      var currentCfg = (state.currentTransformer && state.currentTransformer.tap_config) || {};
      payload.numero_posiciones_tap = tapPositionsCount;
      payload.tap_config = {
        nominalVoltage: currentCfg.nominalVoltage || 0,
        stepPercentage: currentCfg.stepPercentage || 2.5,
        numPositions: tapPositionsCount,
        neutralPosition: Math.ceil(tapPositionsCount / 2),
        positions: buildDefaultTapPositions_(currentCfg.nominalVoltage || 0, tapPositionsCount)
      };
    }
  }

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

/** Genera las posiciones del cambiador de tomas. `numPositions` viene del
 *  campo de placa `numero_posiciones_tap` cuando el técnico lo diligencia —
 *  si no, se mantiene el default histórico de 5. La posición neutra se
 *  calcula como la del medio (no asume que siempre son 5). */
function buildDefaultTapPositions_(nominalVoltage, numPositions) {
  var step = 2.5, n = numPositions > 0 ? numPositions : 5, neutral = Math.ceil(n / 2), positions = [];
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

    // Vista real (Comercial) o placeholder (los demás módulos sin construir) —
    // solo se crea si no existe todavía.
    if (!document.getElementById('view-' + mod.view)) {
      var section = document.createElement('section');
      section.id = 'view-' + mod.view;
      section.hidden = true;
      if (mod.view === 'commercial') {
        section.innerHTML =
          '<div class="topbar"><div><h1>' + mod.title + '</h1><p>' + mod.subtitle + '</p></div></div>' +
          '<div class="view" id="commercialViewBody"></div>';
      } else if (mod.view === 'general-dashboard') {
        section.innerHTML =
          '<div class="topbar"><div><h1>' + mod.title + '</h1><p>' + mod.subtitle + '</p></div></div>' +
          '<div class="view" id="generalDashboardViewBody"></div>';
      } else {
        section.innerHTML =
          '<div class="topbar"><div><h1>' + mod.title + '</h1><p>' + mod.subtitle + '</p></div></div>' +
          '<div class="view"><div class="panel"><div class="panel-head"><h2>Próximamente</h2></div>' +
          '<div class="empty-note">Este módulo está en diseño — se construirá cuando se valide el alcance completo con el cliente.</div>' +
          '</div></div>';
      }
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

function estadoEquipoPillClass_(estado) {
  if (estado === 'Fuera de servicio') return 'danger';
  if (estado === 'Dado de baja') return 'neutral';
  return 'success'; // Activo
}

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
      statusCell = '<span class="pill ' + estadoEquipoPillClass_(t.estado_equipo) + '">' + escapeHtml_(t.estado_equipo || 'Activo') + '</span>' + deleteBtn;
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
  document.getElementById('detailStatusChip').textContent = 'Estado: ' + (t.estado_equipo || 'Activo');

  var phaseLabel = t.phase_type === 'MONOFASICO' ? 'Monofásico' : 'Trifásico';
  var powerLabel = t.rated_power_kva ? (t.rated_power_kva + ' kVA') : null;
  var siteLabel = state.currentSite ? (state.currentSite.client_name + ' · ' + state.currentSite.project_name) : null;
  document.getElementById('detailMeta').textContent =
    [siteLabel, phaseLabel, powerLabel].filter(Boolean).join(' · ');

  var badges = [];
  if (t.is_special_design) badges.push('<span class="tag">Diseño especial</span>');
  badges.push('<span class="pill neutral">Grupo: ' + escapeHtml_(t.vector_group || 'N/A') + '</span>');
  if (t.electrical_report_url) {
    badges.push('<a class="pill success" href="' + t.electrical_report_url + '" target="_blank" rel="noopener">Informe eléctrico combinado (PDF)</a>');
  }
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
    histBody.innerHTML = '<tr><td colspan="6" class="empty-note">Aún no hay pruebas registradas para este transformador.</td></tr>';
  } else {
    histBody.innerHTML = state.currentTests.slice().reverse().map(function (test) {
      var links = [];
      if (test.report_url) links.push('<a href="' + test.report_url + '" target="_blank" rel="noopener">Informe</a>');
      if (test.attachment_url) links.push('<a href="' + test.attachment_url + '" target="_blank" rel="noopener">Evidencia</a>');
      return '<tr>' +
        '<td>' + fmtDate_(test.created_at) + '</td>' +
        '<td>' + escapeHtml_(test.test_type) + '</td>' +
        '<td>' + escapeHtml_(test.instrument_used || '—') + '</td>' +
        '<td>' + escapeHtml_(test.tested_by || '—') + '</td>' +
        '<td><span class="pill ' + verdictPillClass_(test.verdict) + '">' + escapeHtml_(test.verdict) + '</span></td>' +
        '<td>' + (links.length ? links.join(' · ') : '—') + '</td>' +
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

/**
 * Réplica EXACTA de la fórmula estándar (no-matriz-personalizada) de
 * calculateTtr_ en Código.gs: `multiplier * (tapVoltage / lvNominalVoltage)`,
 * con `multiplier` de VECTOR_GROUP_MULTIPLIERS si hay grupo de conexión, 1 si
 * no. Copiada aquí a propósito (mismo criterio de duplicación que el resto de
 * la app — NIT, umbrales de Aceite, etc., ver CLAUDE.md) porque no hay build
 * step que comparta código entre el frontend y Apps Script.
 *
 * A diferencia del backend (que lanza una excepción si falta un dato),
 * esta versión NUNCA lanza — el técnico sigue midiendo y enviando aunque
 * falte tensión de placa o grupo de conexión, así que la vista previa debe
 * degradarse a un estado explícito en vez de romperse. Devuelve:
 *   - { state: 'unavailable' } — falta tensión nominal (primaria y/o
 *     secundaria) o el TAP no tiene voltaje configurado (tap_config en 0,
 *     típicamente porque la tensión primaria estaba vacía al crear el
 *     equipo) → no hay ningún teórico que mostrar, ni siquiera impreciso.
 *   - { state: 'unreliable', value } — sí hay tensiones, pero el grupo de
 *     conexión está vacío: se calcula igual con multiplier=1 (mismo
 *     comportamiento que el backend), pero marcado como no confiable — el
 *     factor √3 puede faltar y no hay forma de saberlo sin el dato.
 *   - { state: 'ok', value } — grupo de conexión reconocido, cálculo normal.
 *
 * Verificación de alineación con el backend (caso conocido, documentado en
 * CLAUDE.md "TTR — vista previa..."): transformador Dyn5, TAP con
 * tapVoltage=13860, lv_nominal_voltage=440 → multiplier=√3≈1.7320508 →
 * theoretical≈54.548... Confirmado en vivo que este valor coincide, dígito
 * por dígito hasta el redondeo de UI, entre esta función y lo que guarda
 * calculateTtr_ para el mismo envío real.
 */
function computeStandardTtrTheoretical_(tapVoltage, lvNominalVoltage, vectorGroup) {
  if (!tapVoltage || !lvNominalVoltage) return { state: 'unavailable' };
  if (!vectorGroup) return { state: 'unreliable', value: 1 * (tapVoltage / lvNominalVoltage) };
  var multiplier = VECTOR_GROUP_MULTIPLIERS[vectorGroup];
  if (multiplier === undefined) return { state: 'unreliable', value: 1 * (tapVoltage / lvNominalVoltage) };
  return { state: 'ok', value: multiplier * (tapVoltage / lvNominalVoltage) };
}

function computeTtrPreview(p) {
  var t = state.currentTransformer;
  var useCustom = usesCustomMatrix();
  var mrow = useCustom ? state.matrix.taps.filter(function (tp) { return tp.tapPosition === p; })[0] : null;
  var tapVoltage = tapVoltageFor(p);
  var readings = state.ttr.readings[p] || {};

  var rows = getPhaseKeys().map(function (k) {
    var measured = readings[k] ? readings[k].measuredRatio : null;
    var theoretical = null;
    var theoState = 'ok';

    if (useCustom) {
      theoretical = mrow && mrow.phases[k] ? mrow.phases[k].theoreticalRatio : null;
      if (!theoretical) theoretical = null;
    } else {
      var calc = computeStandardTtrTheoretical_(tapVoltage, t && t.lv_nominal_voltage, t && t.vector_group);
      theoState = calc.state;
      theoretical = calc.state === 'unavailable' ? null : calc.value;
    }

    if (theoretical == null || measured == null || measured === 0) {
      return { key: k, measured: measured, theoretical: theoretical, theoState: theoState, errorPercent: null, status: 'pending' };
    }
    var err = ((measured - theoretical) / theoretical) * 100;
    return { key: k, measured: measured, theoretical: theoretical, theoState: theoState, errorPercent: err, status: Math.abs(err) <= TOLERANCE_PERCENT ? 'APROBADO' : 'RECHAZADO' };
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
    if (r.theoState === 'unreliable' && errCls !== 'pending') errCls = 'warn';
    var measuredTxt = r.measured != null ? r.measured.toFixed(3) : '&mdash;';
    var theoTxt;
    if (r.theoState === 'unavailable') {
      theoTxt = '<span class="theo-flag theo-unavailable">Teórico no disponible &mdash; falta voltaje nominal de placa</span>';
    } else if (r.theoState === 'unreliable') {
      theoTxt = '<span class="theo-flag theo-unreliable">&#9888;&#65039; ' + r.theoretical.toFixed(3) +
        ' &mdash; grupo de conexión no registrado en placa: teórico sin factor de relación trifásica, puede ser impreciso</span>';
    } else {
      theoTxt = r.theoretical != null ? r.theoretical.toFixed(3) : '&mdash;';
    }
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
      warnIfInstrumentExpired_(body.instrument_used);
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

/** El secundario usa sus propias claves (X1-X2/X2-X3/X3-X1) — nunca las del
 *  primario — y respeta monofásico/trifásico igual que el primario, pero sin
 *  concepto de TAP: normalmente no tiene cambiador de tomas. */
function getSecondaryPhaseKeys_() {
  var t = state.currentTransformer;
  if (t && t.phase_type === 'MONOFASICO') return ['X1-X2'];
  return ['X1-X2', 'X2-X3', 'X3-X1'];
}

function defaultWrSecondary_() {
  var phases = {};
  getSecondaryPhaseKeys_().forEach(function (k) { phases[k] = { resistanceOhm: 0 }; });
  return { windingTemperatureC: 25, phases: phases };
}

function resetWindingStateFromTransformer() {
  var positions = tapPositions();
  var firstTap = positions.length ? positions[0] : 1;
  var draft = loadDraft_('mya_draft_wr_' + state.currentTransformerId);
  if (draft && draft.readings && Object.keys(draft.readings).length) {
    state.wr.readings = draft.readings;
    state.wr.currentTap = Object.keys(draft.readings).map(Number).sort(function (a, b) { return a - b; })[0];
    state.wr.secondary = draft.secondary || defaultWrSecondary_();
    return;
  }
  state.wr.currentTap = firstTap;
  state.wr.readings = {};
  state.wr.readings[firstTap] = { windingTemperatureC: 25, phases: defaultWrPhases_() };
  state.wr.secondary = defaultWrSecondary_();
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
      '<div class="field"><label>Resistencia (&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.resistanceOhm + '" oninput="updateWrPhase(\'' + k + '\',this.value)"></div>' +
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

function renderWrSecondaryPhaseEntries() {
  var wrap = document.getElementById('wrSecondaryPhaseEntries');
  if (!wrap) return;
  document.getElementById('wrSecondaryTemp').value = state.wr.secondary.windingTemperatureC;
  wrap.innerHTML = Object.keys(state.wr.secondary.phases).map(function (k) {
    var r = state.wr.secondary.phases[k];
    return '<div class="phase-entry">' +
      '<div class="ph-name">' + k.replace('-', ' &ndash; ') + '</div>' +
      '<div class="field"><label>Resistencia (&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.resistanceOhm + '" oninput="updateWrSecondaryPhase_(\'' + k + '\',this.value)"></div>' +
      '</div>';
  }).join('');
}

function updateWrSecondaryPhase_(key, value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.wr.secondary.phases[key] = { resistanceOhm: v };
  refreshWinding();
}

function updateWrSecondaryTemp(value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.wr.secondary.windingTemperatureC = v;
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

/** Desbalance entre fases — misma fórmula para el primario (por TAP) y el
 *  secundario (una sola medición): reusada en vez de duplicada. */
function computePhaseUnbalancePreview_(phases) {
  var keys = Object.keys(phases);
  var values = keys.map(function (k) { return phases[k].resistanceOhm; });
  var avg = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
  var rows = keys.map(function (k) {
    var dev = avg !== 0 ? ((phases[k].resistanceOhm - avg) / avg) * 100 : 0;
    return { key: k, value: phases[k].resistanceOhm, deviation: dev, status: Math.abs(dev) <= UNBALANCE_THRESHOLD ? 'APROBADO' : 'RECHAZADO' };
  });
  var maxUnbalance = rows.length > 1 ? Math.max.apply(null, rows.map(function (r) { return Math.abs(r.deviation); })) : 0;
  var verdict = maxUnbalance <= UNBALANCE_THRESHOLD ? 'APROBADO' : 'RECHAZADO';
  return { rows: rows, average: avg, maxUnbalance: maxUnbalance, verdict: verdict };
}

function computeWindingPreview(p) {
  return computePhaseUnbalancePreview_(state.wr.readings[p].phases);
}

function computeWindingSecondaryPreview() {
  return computePhaseUnbalancePreview_(state.wr.secondary.phases);
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

function renderWindingSecondaryPreview() {
  var result = computeWindingSecondaryPreview();
  var rowsEl = document.getElementById('wrSecondaryPreviewRows');
  if (!rowsEl) return;
  rowsEl.innerHTML = result.rows.map(function (r) {
    var cls = r.status === 'APROBADO' ? 'ok' : 'bad';
    return '<div class="preview-row"><span class="phase-name">' + r.key + '</span>' +
      '<span class="num">' + r.value.toFixed(4) + ' &Omega; &middot; prom. ' + result.average.toFixed(4) + ' &Omega;</span>' +
      '<span class="err ' + cls + '">' + (r.deviation >= 0 ? '+' : '') + r.deviation.toFixed(2) + ' %</span></div>';
  }).join('');
  var banner = document.getElementById('wrSecondaryVerdictBanner');
  banner.className = 'verdict-banner ' + (result.verdict === 'APROBADO' ? 'success' : 'danger');
  banner.innerHTML = 'Veredicto secundario: ' + result.verdict +
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
      }),
      secondary: { windingTemperatureC: state.wr.secondary.windingTemperatureC, phases: state.wr.secondary.phases }
    }
  };
}

function refreshWinding() {
  renderWrTapChips();
  renderWrPhaseEntries();
  renderWindingPreview();
  renderWrSecondaryPhaseEntries();
  renderWindingSecondaryPreview();
  saveDraft_('mya_draft_wr_' + state.currentTransformerId, { readings: state.wr.readings, secondary: state.wr.secondary });
}

function submitWinding() {
  var btn = document.getElementById('submitWrBtn');
  var status = document.getElementById('wrSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  readFileAsBase64_(document.getElementById('wrEvidence'))
    .then(function (evidence) {
      var body = buildWindingRequestBody();
      warnIfInstrumentExpired_(body.instrument_used);
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

/** Las 3 combinaciones de devanado que exige IEEE C57.12.90 para Resistencia
 *  de Aislamiento — NO son fases del transformador (eso es otro módulo).
 *  Fijas siempre, sin importar phase_type (monofásico o trifásico): las tres
 *  combinaciones existen igual en ambos casos. */
var INSULATION_COMBINATIONS = ['AT-BT', 'AT-Tierra', 'BT-Tierra'];

function defaultInsulationCombinations_() {
  var p = {};
  INSULATION_COMBINATIONS.forEach(function (k) { p[k] = { r30sMegaohm: 0, r60sMegaohm: 0, r10minMegaohm: 0 }; });
  return p;
}

function resetInsulationStateFromTransformer() {
  var draft = loadDraft_('mya_draft_insulation_' + state.currentTransformerId);
  state.insulation = draft || { windingTemperatureC: 20, combinations: defaultInsulationCombinations_() };
  if (!state.insulation.combinations) state.insulation.combinations = defaultInsulationCombinations_();
  var evidenceInput = document.getElementById('insulationEvidence');
  if (evidenceInput) evidenceInput.value = '';
}

function renderInsulationFormContext() {
  var t = state.currentTransformer;
  document.getElementById('insulationFormSubtitle').textContent = t.serial_number + ' · DAR e IP por combinación de devanado';
  document.getElementById('insulationTenantChip').textContent = state.username + ' · ' + state.role;
}

function renderInsulationCombinationEntries() {
  var wrap = document.getElementById('insulationCombinationEntries');
  if (!wrap) return;
  document.getElementById('insulationTemp').value = state.insulation.windingTemperatureC;
  wrap.innerHTML = Object.keys(state.insulation.combinations).map(function (k) {
    var r = state.insulation.combinations[k];
    return '<div class="phase-entry">' +
      '<div class="ph-name">' + k + '</div>' +
      '<div class="field"><label>R 30 s (M&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.r30sMegaohm + '" oninput="updateInsulationCombination_(\'' + k + '\', \'r30sMegaohm\', this.value)"></div>' +
      '<div class="field"><label>R 60 s / 1 min (M&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.r60sMegaohm + '" oninput="updateInsulationCombination_(\'' + k + '\', \'r60sMegaohm\', this.value)"></div>' +
      '<div class="field"><label>R 10 min (M&Omega;)</label><input class="mono" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="' + r.r10minMegaohm + '" oninput="updateInsulationCombination_(\'' + k + '\', \'r10minMegaohm\', this.value)"></div>' +
      '</div>';
  }).join('');
}

function updateInsulationCombination_(key, field, value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.insulation.combinations[key][field] = v;
  refreshInsulation();
}

function updateInsulationTemp(value) {
  var v = parseDecimal_(value); if (isNaN(v)) v = 0;
  state.insulation.windingTemperatureC = v;
  refreshInsulation();
}

function computeInsulationPreview() {
  var keys = Object.keys(state.insulation.combinations);
  var hasMalo = false, hasCuestionable = false;
  var rows = keys.map(function (k) {
    var r = state.insulation.combinations[k];
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
      measurements: state.insulation.combinations
    }
  };
}

function refreshInsulation() {
  renderInsulationCombinationEntries();
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
      warnIfInstrumentExpired_(body.instrument_used);
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
// Documentos e Informes
//
// RBAC: Técnico puede subir (formulario siempre visible), pero NUNCA se le
// arma la sección de lista/filtro/descarga — ni siquiera se agrega al DOM
// (mismo criterio que "Sin acceso" en otros módulos). El backend además
// rechaza listDocuments con 403 si auth.role === 'Tecnico', así que aunque
// alguien fuerce la llamada desde la consola no obtiene nada.
// ---------------------------------------------------------------

var DOCUMENT_CATEGORY_LABELS = {
  CERTIFICADOS: 'Certificados de Pruebas',
  OFERTAS_CONTRATOS: 'Ofertas y Contratos',
  GENERALES: 'Documentos Generales'
};

function renderDocumentsView_() {
  var body = document.getElementById('documentsViewBody');
  if (!body) return;
  var canList = state.role !== 'Tecnico';

  body.innerHTML =
    '<div class="panel" style="max-width:560px;">' +
    '<div class="panel-head"><h2>Subir documento</h2><span class="hint">Ofertas/Contratos o Documentos Generales</span></div>' +
    '<form id="uploadDocumentForm" class="form-field-block" style="align-items:flex-end;">' +
    '<div class="field" style="flex:1; min-width:200px;"><label>Cliente</label><select id="uploadDocSite" required><option value="">Cargando…</option></select></div>' +
    '<div class="field" style="min-width:200px;"><label>Categoría</label>' +
    '<select id="uploadDocCategory" required>' +
    '<option value="OFERTAS_CONTRATOS">' + DOCUMENT_CATEGORY_LABELS.OFERTAS_CONTRATOS + '</option>' +
    '<option value="GENERALES">' + DOCUMENT_CATEGORY_LABELS.GENERALES + '</option>' +
    '</select></div>' +
    '<div class="field" style="flex:1; min-width:200px;"><label>Archivo</label><input id="uploadDocFile" type="file" required></div>' +
    '<button class="btn primary" type="submit" id="uploadDocBtn">Subir</button>' +
    '</form>' +
    '<div class="status-line" id="uploadDocStatus" hidden style="padding:0 18px 14px;"></div>' +
    '</div>' +
    (canList ?
      '<div class="panel">' +
      '<div class="panel-head"><h2>Documentos</h2></div>' +
      '<div class="form-field-block">' +
      '<div class="field" style="min-width:200px;"><label>Cliente</label><select id="filterDocSite" onchange="applyDocumentFilters_()"><option value="">Todos</option></select></div>' +
      '<div class="field" style="min-width:200px;"><label>Tipo</label>' +
      '<select id="filterDocCategory" onchange="applyDocumentFilters_()">' +
      '<option value="">Todos</option>' +
      '<option value="CERTIFICADOS">' + DOCUMENT_CATEGORY_LABELS.CERTIFICADOS + '</option>' +
      '<option value="OFERTAS_CONTRATOS">' + DOCUMENT_CATEGORY_LABELS.OFERTAS_CONTRATOS + '</option>' +
      '<option value="GENERALES">' + DOCUMENT_CATEGORY_LABELS.GENERALES + '</option>' +
      '</select></div>' +
      '<div class="field"><label>Desde</label><input type="date" id="filterDocDateFrom" onchange="applyDocumentFilters_()"></div>' +
      '<div class="field"><label>Hasta</label><input type="date" id="filterDocDateTo" onchange="applyDocumentFilters_()"></div>' +
      '</div>' +
      '<div style="overflow-x:auto;"><table>' +
      '<thead><tr><th>Nombre</th><th>Tipo</th><th>Cliente</th><th>Fecha</th><th>Subido por</th><th></th></tr></thead>' +
      '<tbody id="documentsRows"><tr><td colspan="6" class="empty-note">Cargando…</td></tr></tbody>' +
      '</table></div>' +
      '</div>'
      : '');

  document.getElementById('uploadDocumentForm').addEventListener('submit', handleUploadDocumentSubmit);

  callApi('listSites', 'GET', {}).then(function (sites) {
    state.sites = sites || [];
    var options = '<option value="">Selecciona…</option>' + state.sites.map(function (s) {
      return '<option value="' + s.id + '">' + escapeHtml_(s.client_name + ' · ' + s.project_name) + '</option>';
    }).join('');
    document.getElementById('uploadDocSite').innerHTML = options;
    var filterSite = document.getElementById('filterDocSite');
    if (filterSite) filterSite.innerHTML = '<option value="">Todos</option>' + options.replace('<option value="">Selecciona…</option>', '');
  });

  if (canList) loadDocumentsAndRender_();
}

function handleUploadDocumentSubmit(e) {
  e.preventDefault();
  var siteId = document.getElementById('uploadDocSite').value;
  var category = document.getElementById('uploadDocCategory').value;
  var fileInput = document.getElementById('uploadDocFile');
  var status = document.getElementById('uploadDocStatus');
  var btn = document.getElementById('uploadDocBtn');
  if (!siteId || !fileInput.files[0]) { setStatus_(status, 'Selecciona un cliente y un archivo', false, true); return; }

  btn.disabled = true;
  setStatus_(status, 'Subiendo…', false);

  readFileAsBase64_(fileInput)
    .then(function (file) {
      return callApi('uploadDocument', 'POST', {
        site_id: siteId,
        category: category,
        file_name: fileInput.files[0].name,
        file_base64: file.base64,
        file_mime_type: file.mimeType
      });
    })
    .then(function () {
      setStatus_(status, 'Documento subido correctamente', true);
      document.getElementById('uploadDocumentForm').reset();
      if (state.role !== 'Tecnico') loadDocumentsAndRender_();
    })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(status, formatNetworkAwareError_(err), false, true);
    })
    .then(function () { btn.disabled = false; });
}

function loadDocumentsAndRender_() {
  var tbody = document.getElementById('documentsRows');
  if (!tbody) return;

  var cached = loadDraft_('mya_cache_documents');
  if (cached) { state.documents = cached; applyDocumentFilters_(); }

  callApi('listDocuments', 'GET', {})
    .then(function (docs) {
      state.documents = docs || [];
      saveDraft_('mya_cache_documents', state.documents);
      applyDocumentFilters_();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      if (!cached) tbody.innerHTML = '<tr><td colspan="6" class="empty-note">' + escapeHtml_(formatNetworkAwareError_(err)) + '</td></tr>';
    });
}

function applyDocumentFilters_() {
  var tbody = document.getElementById('documentsRows');
  if (!tbody) return;
  var siteFilter = document.getElementById('filterDocSite');
  var categoryFilter = document.getElementById('filterDocCategory');
  var dateFromEl = document.getElementById('filterDocDateFrom');
  var dateToEl = document.getElementById('filterDocDateTo');
  var siteId = siteFilter ? siteFilter.value : '';
  var category = categoryFilter ? categoryFilter.value : '';
  var dateFrom = dateFromEl && dateFromEl.value ? new Date(dateFromEl.value) : null;
  var dateTo = dateToEl && dateToEl.value ? new Date(dateToEl.value + 'T23:59:59') : null;

  var rows = state.documents.filter(function (d) {
    if (siteId && d.site_id !== siteId) return false;
    if (category && d.category !== category) return false;
    var created = new Date(d.created_at);
    if (dateFrom && created < dateFrom) return false;
    if (dateTo && created > dateTo) return false;
    return true;
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">No hay documentos que coincidan con el filtro.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.slice().reverse().map(function (d) {
    var site = state.sites.filter(function (s) { return s.id === d.site_id; })[0];
    var siteLabel = site ? (site.client_name + ' · ' + site.project_name) : '—';
    return '<tr>' +
      '<td>' + escapeHtml_(d.file_name) + '</td>' +
      '<td><span class="pill neutral">' + escapeHtml_(DOCUMENT_CATEGORY_LABELS[d.category] || d.category) + '</span></td>' +
      '<td>' + escapeHtml_(siteLabel) + '</td>' +
      '<td>' + fmtDate_(d.created_at) + '</td>' +
      '<td>' + escapeHtml_(d.uploaded_by || '—') + '</td>' +
      '<td><a href="' + d.url + '" target="_blank" rel="noopener">Ver / descargar</a></td>' +
      '</tr>';
  }).join('');
}

// ---------------------------------------------------------------
// Calibraciones — catálogo de instrumentos propios de M&A
//
// RBAC: Técnico tiene SOLO LECTURA — ve el catálogo y el semáforo, pero
// renderCalibrationsView_() no arma el formulario de alta/edición ni los
// botones de eliminar cuando state.role === 'Tecnico' (mismo criterio de
// "no agregar al DOM" que el resto de "RBAC" en CLAUDE.md). El backend
// además rechaza con 403 cualquier create/update/delete para Técnico
// (checkCalibracionesWriteAccess_), así que forzar la llamada desde la
// consola tampoco funciona. listCalibraciones sí es Full para los 3 roles.
// ---------------------------------------------------------------

function calibracionEstadoPillClass_(estado) {
  if (estado === 'Vencido') return 'danger';
  if (estado === 'Por vencer') return 'warning';
  return 'success'; // Vigente
}

function renderCalibrationsView_() {
  var body = document.getElementById('calibrationsViewBody');
  if (!body) return;
  var canWrite = state.role !== 'Tecnico';

  body.innerHTML =
    (canWrite ?
      '<div class="panel" style="max-width:720px;">' +
      '<div class="panel-head"><h2>Nuevo instrumento</h2></div>' +
      '<form id="createCalibracionForm" class="form-field-block" style="align-items:flex-end;">' +
      '<div class="field" style="flex:1; min-width:180px;"><label>Modelo</label><input id="newCalModelo" placeholder="Micro-ohmmeter DLRO-10" required></div>' +
      '<div class="field" style="min-width:160px;"><label>N&uacute;mero de serie</label><input class="mono" id="newCalSerie" required></div>' +
      '<div class="field" style="min-width:160px;"><label>Fabricante</label><input id="newCalFabricante"></div>' +
      '<div class="field" style="min-width:180px;"><label>Ente acreditado</label><input id="newCalEnte"></div>' +
      '<div class="field" style="min-width:160px;"><label>Fecha &uacute;ltima calibraci&oacute;n</label><input type="date" id="newCalFechaUltima"></div>' +
      '<div class="field" style="min-width:160px;"><label>Fecha pr&oacute;xima calibraci&oacute;n</label><input type="date" id="newCalFechaProxima" required></div>' +
      '<div class="field" style="min-width:200px;"><label>Certificado (opcional)</label><input id="newCalFile" type="file" accept="application/pdf,image/*"></div>' +
      '<button class="btn primary" type="submit" id="createCalibracionBtn">Registrar</button>' +
      '</form>' +
      '<div class="status-line" id="createCalibracionStatus" hidden style="padding:0 18px 14px;"></div>' +
      '</div>'
      : '') +
    '<div class="panel">' +
    '<div class="panel-head"><h2>Cat&aacute;logo</h2></div>' +
    '<div style="overflow-x:auto;"><table>' +
    '<thead><tr><th>Modelo</th><th>Serie</th><th>Fabricante</th><th>Ente acreditado</th><th>Pr&oacute;xima calibraci&oacute;n</th><th>Estado</th><th></th></tr></thead>' +
    '<tbody id="calibracionesRows"><tr><td colspan="7" class="empty-note">Cargando&hellip;</td></tr></tbody>' +
    '</table></div>' +
    '</div>';

  if (canWrite) document.getElementById('createCalibracionForm').addEventListener('submit', handleCreateCalibracionSubmit);
  ensureEditCalibracionModalWired_();
  loadCalibracionesAndRender_();
}

function loadCalibracionesAndRender_() {
  var tbody = document.getElementById('calibracionesRows');

  var cached = loadDraft_('mya_cache_calibraciones');
  if (cached) { state.calibraciones = cached; renderCalibracionesTable_(); }

  callApi('listCalibraciones', 'GET', {})
    .then(function (calibraciones) {
      state.calibraciones = calibraciones || [];
      saveDraft_('mya_cache_calibraciones', state.calibraciones);
      renderCalibracionesTable_();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      if (!cached && tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-note">' + escapeHtml_(formatNetworkAwareError_(err)) + '</td></tr>';
    });
}

function renderCalibracionesTable_() {
  var tbody = document.getElementById('calibracionesRows');
  if (!tbody) return;
  var canWrite = state.role !== 'Tecnico';

  if (state.calibraciones.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-note">No hay instrumentos registrados todav&iacute;a.</td></tr>';
    return;
  }

  tbody.innerHTML = state.calibraciones.slice().sort(function (a, b) {
    return String(a.fecha_proxima_calibracion).localeCompare(String(b.fecha_proxima_calibracion));
  }).map(function (c) {
    var actions = '<a href="#" onclick="event.preventDefault(); openEditCalibracionModal_(\'' + c.id + '\')">Editar</a>';
    if (c.certificado_url) actions += ' &middot; <a href="' + c.certificado_url + '" target="_blank" rel="noopener">Certificado</a>';
    if (canWrite) actions += ' &middot; <a href="#" onclick="event.preventDefault(); handleDeleteCalibracion_(\'' + c.id + '\')">Eliminar</a>';
    return '<tr>' +
      '<td>' + escapeHtml_(c.modelo) + '</td>' +
      '<td class="mono">' + escapeHtml_(c.numero_serie) + '</td>' +
      '<td>' + escapeHtml_(c.fabricante || '—') + '</td>' +
      '<td>' + escapeHtml_(c.ente_acreditado || '—') + '</td>' +
      '<td class="mono">' + fmtDate_(c.fecha_proxima_calibracion) + '</td>' +
      '<td><span class="pill ' + calibracionEstadoPillClass_(c.estado) + '">' + escapeHtml_(c.estado) + '</span></td>' +
      '<td>' + (canWrite || c.certificado_url ? actions : '') + '</td>' +
      '</tr>';
  }).join('');
}

function handleCreateCalibracionSubmit(e) {
  e.preventDefault();
  var status = document.getElementById('createCalibracionStatus');
  var btn = document.getElementById('createCalibracionBtn');
  var payload = {
    modelo: document.getElementById('newCalModelo').value.trim(),
    numero_serie: document.getElementById('newCalSerie').value.trim(),
    fabricante: document.getElementById('newCalFabricante').value.trim(),
    ente_acreditado: document.getElementById('newCalEnte').value.trim(),
    fecha_ultima_calibracion: document.getElementById('newCalFechaUltima').value || null,
    fecha_proxima_calibracion: document.getElementById('newCalFechaProxima').value
  };

  btn.disabled = true;
  setStatus_(status, 'Guardando…', false);

  var fileInput = document.getElementById('newCalFile');
  (fileInput.files[0] ? readFileAsBase64_(fileInput) : Promise.resolve(null))
    .then(function (file) {
      if (file) { payload.file_base64 = file.base64; payload.file_mime_type = file.mimeType; }
      return callApi('createCalibracion', 'POST', payload);
    })
    .then(function () {
      setStatus_(status, 'Instrumento registrado', true);
      document.getElementById('createCalibracionForm').reset();
      loadCalibracionesAndRender_();
    })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(status, formatNetworkAwareError_(err), false, true);
    })
    .then(function () { btn.disabled = false; });
}

function openEditCalibracionModal_(id) {
  var c = state.calibraciones.filter(function (x) { return x.id === id; })[0];
  if (!c) return;
  state.currentCalibracionId = id;
  document.getElementById('editCalModelo').value = c.modelo || '';
  document.getElementById('editCalSerie').value = c.numero_serie || '';
  document.getElementById('editCalFabricante').value = c.fabricante || '';
  document.getElementById('editCalEnte').value = c.ente_acreditado || '';
  document.getElementById('editCalFechaUltima').value = c.fecha_ultima_calibracion ? String(c.fecha_ultima_calibracion).slice(0, 10) : '';
  document.getElementById('editCalFechaProxima').value = c.fecha_proxima_calibracion ? String(c.fecha_proxima_calibracion).slice(0, 10) : '';
  setStatus_(document.getElementById('editCalibracionStatus'), '', false);
  document.getElementById('editCalibracionModal').classList.add('open');
  document.getElementById('editCalibracionModalBackdrop').classList.add('open');
}

function closeEditCalibracionModal_() {
  document.getElementById('editCalibracionModal').classList.remove('open');
  document.getElementById('editCalibracionModalBackdrop').classList.remove('open');
}

function ensureEditCalibracionModalWired_() {
  var form = document.getElementById('editCalibracionForm');
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', handleEditCalibracionSubmit);
  }
}

function handleEditCalibracionSubmit(e) {
  e.preventDefault();
  var id = state.currentCalibracionId;
  var status = document.getElementById('editCalibracionStatus');
  var payload = {
    id: id,
    modelo: document.getElementById('editCalModelo').value.trim(),
    numero_serie: document.getElementById('editCalSerie').value.trim(),
    fabricante: document.getElementById('editCalFabricante').value.trim(),
    ente_acreditado: document.getElementById('editCalEnte').value.trim(),
    fecha_ultima_calibracion: document.getElementById('editCalFechaUltima').value || null,
    fecha_proxima_calibracion: document.getElementById('editCalFechaProxima').value
  };

  setStatus_(status, 'Guardando…', false);
  var fileInput = document.getElementById('editCalFile');
  (fileInput.files[0] ? readFileAsBase64_(fileInput) : Promise.resolve(null))
    .then(function (file) {
      if (file) { payload.file_base64 = file.base64; payload.file_mime_type = file.mimeType; }
      return callApi('updateCalibracion', 'POST', payload);
    })
    .then(function () {
      closeEditCalibracionModal_();
      showToast_('Instrumento actualizado', 'success');
      loadCalibracionesAndRender_();
    })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(status, formatNetworkAwareError_(err), false, true);
    });
}

function handleDeleteCalibracion_(id) {
  var c = state.calibraciones.filter(function (x) { return x.id === id; })[0];
  if (!c) return;
  if (!confirm('¿Eliminar el instrumento "' + c.modelo + ' · ' + c.numero_serie + '"? Esta acción no se puede deshacer.')) return;
  callApi('deleteCalibracion', 'POST', { id: id })
    .then(function () { loadCalibracionesAndRender_(); showToast_('Instrumento eliminado', 'success'); })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      alert('No se pudo eliminar: ' + err.message);
    });
}

// ---------------------------------------------------------------
// instrument_used (TTR/Resistencia de devanados/Resistencia de
// aislamiento) — cruce NO bloqueante contra el catálogo de Calibraciones.
// Decisión explícita: el campo sigue siendo texto libre (ver CLAUDE.md,
// sección "instrument_used" dentro de Calibraciones) — un <datalist>
// sugiere instrumentos reales mientras se escribe, y una comparación
// difusa al enviar avisa si el texto coincide con un instrumento Vencido o
// Por vencer, sin impedir el envío. Aceite dieléctrico no tiene este campo
// a propósito (no usa un instrumento propio de M&A).
// ---------------------------------------------------------------

/** Carga el catálogo (para la comparación difusa) y llena el <datalist>
 *  compartido por los 3 formularios. Falla en silencio a propósito: es una
 *  ayuda opcional, un fallo de red aquí nunca debe interrumpir ni ensuciar
 *  un formulario de prueba real. */
function loadInstrumentCatalogForTestForms_() {
  callApi('listCalibraciones', 'GET', {})
    .then(function (calibraciones) {
      state.calibraciones = calibraciones || [];
      var datalist = document.getElementById('instrumentCatalogList');
      if (!datalist) return;
      datalist.innerHTML = state.calibraciones.map(function (c) {
        var label = c.modelo + (c.numero_serie ? ' · ' + c.numero_serie : '');
        return '<option value="' + escapeHtml_(label) + '"></option>';
      }).join('');
    })
    .catch(function () { /* silencioso, ver comentario arriba */ });
}

/** Minúsculas, sin acentos, solo alfanumérico — para que "TTR-2000" y
 *  "ttr 2000" comparen igual. */
function normalizeInstrumentText_(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Coincidencia difusa por contención de substring (en cualquier
 *  dirección) contra `modelo` o `numero_serie` normalizados. Exige al
 *  menos 3 caracteres normalizados a ambos lados de la comparación para no
 *  disparar falsos positivos con textos cortos. */
function findMatchingCalibracion_(text) {
  var normalized = normalizeInstrumentText_(text);
  if (normalized.length < 3) return null;
  var match = null;
  state.calibraciones.forEach(function (c) {
    if (match) return;
    var modelo = normalizeInstrumentText_(c.modelo);
    var serie = normalizeInstrumentText_(c.numero_serie);
    if (modelo.length >= 3 && (normalized.indexOf(modelo) !== -1 || modelo.indexOf(normalized) !== -1)) { match = c; return; }
    if (serie.length >= 3 && (normalized.indexOf(serie) !== -1 || serie.indexOf(normalized) !== -1)) { match = c; }
  });
  return match;
}

/** Advertencia NO bloqueante — se llama justo antes de enviar la prueba,
 *  nunca detiene ni retrasa el envío real. Sin coincidencia o instrumento
 *  Vigente: no hace nada. */
function warnIfInstrumentExpired_(instrumentText) {
  var match = findMatchingCalibracion_(instrumentText);
  if (!match || (match.estado !== 'Vencido' && match.estado !== 'Por vencer')) return;
  showToast_(
    'Instrumento "' + match.modelo + ' · ' + match.numero_serie + '" está ' + match.estado.toLowerCase() + ' en Calibraciones — la prueba se envía igual, revisa su certificado cuando puedas.',
    'warning',
    6000
  );
}

// ---------------------------------------------------------------
// Comercial — Ofertas y Licitaciones
//
// RBAC: "Sin acceso" para Técnico — igual que Administración, ni el nav ni
// la vista se agregan al DOM para ese rol (ver RESTRICTED_MODULES_ /
// renderRestrictedModuleNav_). El backend además rechaza con 403 en TODAS
// las acciones de este módulo (no solo listar, a diferencia de Documentos),
// así que aunque alguien fuerce la llamada desde la consola no logra nada.
// ---------------------------------------------------------------

var OFERTA_TIPO_LABELS = { OFERTA_DIRECTA: 'Oferta directa', LICITACION_PUBLICA: 'Licitación pública' };
var OFERTA_ESTADOS = ['Pendiente', 'Aprobada', 'Rechazada', 'Cierre'];

function ofertaEstadoPillClass_(estado) {
  if (estado === 'Aprobada') return 'success';
  if (estado === 'Rechazada' || estado === 'Cierre') return 'danger';
  return 'neutral'; // Pendiente
}

function renderCommercialView_() {
  var body = document.getElementById('commercialViewBody');
  if (!body) return;

  body.innerHTML =
    '<div class="stat-row" id="comercialStatRow"></div>' +
    '<div class="panel">' +
    '<div class="panel-head"><h2>Por mes</h2><span class="hint">Cantidad y valor cotizado por estado, agrupado por mes de envío</span></div>' +
    '<div style="overflow-x:auto;"><table><thead><tr><th>Mes</th><th>Pendiente</th><th>Aprobada</th><th>Rechazada</th><th>Cierre</th></tr></thead>' +
    '<tbody id="comercialMonthlyRows"><tr><td colspan="5" class="empty-note">Cargando…</td></tr></tbody></table></div>' +
    '</div>' +
    '<div class="panel" style="max-width:720px;">' +
    '<div class="panel-head"><h2>Nueva oferta</h2></div>' +
    '<form id="createOfertaForm" class="form-field-block" style="align-items:flex-end;">' +
    '<div class="field" style="flex:1; min-width:200px;"><label>Cliente / prospecto</label><input id="newOfertaCliente" required></div>' +
    '<div class="field" style="min-width:200px;"><label>Vincular a Sitio (opcional)</label><select id="newOfertaSite"><option value="">— sin vincular —</option></select></div>' +
    '<div class="field" style="min-width:180px;"><label>Tipo</label><select id="newOfertaTipo"><option value="OFERTA_DIRECTA">Oferta directa</option><option value="LICITACION_PUBLICA">Licitación pública</option></select></div>' +
    '<div class="field" style="flex:1; min-width:220px;"><label>Descripción / alcance</label><input id="newOfertaDescripcion"></div>' +
    '<div class="field" style="min-width:150px;"><label>Valor cotizado</label><input class="mono" id="newOfertaValor" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*"></div>' +
    '<div class="field" style="min-width:150px;"><label>Fecha de envío</label><input type="date" id="newOfertaFechaEnvio"></div>' +
    '<div class="field" style="min-width:150px;"><label>Fecha de cierre</label><input type="date" id="newOfertaFechaCierre"></div>' +
    '<div class="field" style="min-width:180px;"><label>Responsable</label><input id="newOfertaResponsable"></div>' +
    '<div class="field" style="min-width:200px;"><label>Propuesta enviada (opcional)</label><input id="newOfertaFile" type="file" accept="application/pdf,image/*"></div>' +
    '<button class="btn primary" type="submit" id="createOfertaBtn">Crear</button>' +
    '</form>' +
    '<div class="status-line" id="createOfertaStatus" hidden style="padding:0 18px 14px;"></div>' +
    '</div>' +
    '<div class="panel">' +
    '<div class="panel-head"><h2>Ofertas</h2></div>' +
    '<div class="form-field-block">' +
    '<div class="field" style="min-width:170px;"><label>Estado</label><select id="filterOfertaEstado" onchange="applyComercialFilters_()"><option value="">Todos</option><option>Pendiente</option><option>Aprobada</option><option>Rechazada</option><option>Cierre</option></select></div>' +
    '<div class="field" style="min-width:200px;"><label>Cliente / Sitio</label><select id="filterOfertaSite" onchange="applyComercialFilters_()"><option value="">Todos</option></select></div>' +
    '<div class="field" style="min-width:180px;"><label>Tipo</label><select id="filterOfertaTipo" onchange="applyComercialFilters_()"><option value="">Todos</option><option value="OFERTA_DIRECTA">Oferta directa</option><option value="LICITACION_PUBLICA">Licitación pública</option></select></div>' +
    '<div class="field"><label>Desde</label><input type="date" id="filterOfertaDateFrom" onchange="applyComercialFilters_()"></div>' +
    '<div class="field"><label>Hasta</label><input type="date" id="filterOfertaDateTo" onchange="applyComercialFilters_()"></div>' +
    '</div>' +
    '<div style="overflow-x:auto;"><table>' +
    '<thead><tr><th>Cliente</th><th>Tipo</th><th>Valor</th><th>Envío</th><th>Cierre</th><th>Estado</th><th></th></tr></thead>' +
    '<tbody id="ofertasRows"><tr><td colspan="7" class="empty-note">Cargando…</td></tr></tbody>' +
    '</table></div>' +
    '</div>';

  document.getElementById('createOfertaForm').addEventListener('submit', handleCreateOfertaSubmit);
  ensureOfertaDetailModal_();

  callApi('listSites', 'GET', {}).then(function (sites) {
    state.sites = sites || [];
    var options = state.sites.map(function (s) {
      return '<option value="' + s.id + '">' + escapeHtml_(s.client_name + ' · ' + s.project_name) + '</option>';
    }).join('');
    document.getElementById('newOfertaSite').innerHTML = '<option value="">— sin vincular —</option>' + options;
    document.getElementById('filterOfertaSite').innerHTML = '<option value="">Todos</option>' + options;
  });

  loadOfertasAndRender_();
}

function loadOfertasAndRender_() {
  var cached = loadDraft_('mya_cache_ofertas');
  if (cached) {
    state.ofertas = cached;
    renderComercialDashboard_();
    applyComercialFilters_();
  }

  callApi('listOfertas', 'GET', {})
    .then(function (ofertas) {
      state.ofertas = ofertas || [];
      saveDraft_('mya_cache_ofertas', state.ofertas);
      renderComercialDashboard_();
      applyComercialFilters_();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      if (!cached) {
        var tbody = document.getElementById('ofertasRows');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-note">' + escapeHtml_(formatNetworkAwareError_(err)) + '</td></tr>';
      }
    });
}

function computeComercialStats_(ofertas) {
  var valueByEstado = { Pendiente: 0, Aprobada: 0, Rechazada: 0, Cierre: 0 };
  var resolved = 0, approved = 0, responseDaysSum = 0, responseCount = 0;

  ofertas.forEach(function (o) {
    var v = parseFloat(o.valor_cotizado) || 0;
    valueByEstado[o.estado] = (valueByEstado[o.estado] || 0) + v;
    if (o.estado === 'Aprobada' || o.estado === 'Rechazada' || o.estado === 'Cierre') {
      resolved++;
      if (o.estado === 'Aprobada') approved++;
      var endIso = o.estado_changed_at || (o.estado === 'Cierre' ? o.fecha_cierre : null);
      if (endIso && o.fecha_envio) {
        var days = (new Date(endIso) - new Date(o.fecha_envio)) / 86400000;
        if (!isNaN(days) && days >= 0) { responseDaysSum += days; responseCount++; }
      }
    }
  });

  return {
    valueByEstado: valueByEstado,
    pipelineValue: valueByEstado.Pendiente,
    wonValue: valueByEstado.Aprobada,
    conversionRatePercent: resolved > 0 ? (approved / resolved * 100) : null,
    avgResponseDays: responseCount > 0 ? (responseDaysSum / responseCount) : null
  };
}

function fmtCOP_(v) {
  return '$ ' + Math.round(v || 0).toLocaleString('es-CO');
}

function renderComercialDashboard_() {
  var row = document.getElementById('comercialStatRow');
  if (!row) return;
  var stats = computeComercialStats_(state.ofertas);
  var counts = { Pendiente: 0, Aprobada: 0, Rechazada: 0, Cierre: 0 };
  state.ofertas.forEach(function (o) { counts[o.estado] = (counts[o.estado] || 0) + 1; });

  row.innerHTML =
    '<div class="stat-card"><div class="label">Funnel</div><div class="value" style="font-size:14px;">' +
    'Pendiente ' + counts.Pendiente + ' &middot; Aprobada ' + counts.Aprobada + ' &middot; Rechazada ' + counts.Rechazada + ' &middot; Cierre ' + counts.Cierre +
    '</div></div>' +
    '<div class="stat-card"><div class="label">Valor en pipeline</div><div class="value num">' + fmtCOP_(stats.pipelineValue) + '</div><div class="delta">Suma de ofertas Pendiente</div></div>' +
    '<div class="stat-card"><div class="label">Valor ganado</div><div class="value num">' + fmtCOP_(stats.wonValue) + '</div><div class="delta">Suma de ofertas Aprobada</div></div>' +
    '<div class="stat-card"><div class="label">Tasa de conversión</div><div class="value num">' + (stats.conversionRatePercent === null ? '—' : stats.conversionRatePercent.toFixed(1) + ' %') + '</div><div class="delta">Aprobada / resueltas</div></div>' +
    '<div class="stat-card"><div class="label">Tiempo prom. de respuesta</div><div class="value num">' + (stats.avgResponseDays === null ? '—' : stats.avgResponseDays.toFixed(1) + ' d') + '</div><div class="delta">Envío &rarr; cambio de estado</div></div>';

  renderComercialMonthlyTable_();
}

function renderComercialMonthlyTable_() {
  var tbody = document.getElementById('comercialMonthlyRows');
  if (!tbody) return;
  var byMonth = {};
  state.ofertas.forEach(function (o) {
    if (!o.fecha_envio) return;
    var month = String(o.fecha_envio).slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = { Pendiente: { n: 0, v: 0 }, Aprobada: { n: 0, v: 0 }, Rechazada: { n: 0, v: 0 }, Cierre: { n: 0, v: 0 } };
    var v = parseFloat(o.valor_cotizado) || 0;
    byMonth[month][o.estado].n++;
    byMonth[month][o.estado].v += v;
  });
  var months = Object.keys(byMonth).sort().reverse();
  if (months.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-note">Sin ofertas registradas todavía.</td></tr>';
    return;
  }
  tbody.innerHTML = months.map(function (m) {
    var row = byMonth[m];
    return '<tr><td class="mono">' + m + '</td>' + OFERTA_ESTADOS.map(function (e) {
      return '<td>' + row[e].n + ' &middot; ' + fmtCOP_(row[e].v) + '</td>';
    }).join('') + '</tr>';
  }).join('');
}

// ---------------------------------------------------------------
// Panel General — dashboard consolidado
//
// RBAC: "Sin acceso" para Técnico, mismo patrón frontend que Comercial (ver
// RESTRICTED_MODULES_ / renderRestrictedModuleNav_). No agrega ningún action
// de backend nuevo: solo consume listTransformers/listTests/listOfertas/
// listDocuments, que ya existen. listOfertas_/listDocuments_ ya rechazan a
// Técnico con 403 por su cuenta; listTransformers_/listTests_ se dejan
// abiertos a propósito (Técnico tiene Full en Equipos/Pruebas por su cuenta,
// según la matriz RBAC) — la protección de Panel General en sí sigue siendo
// 100% frontend, como Comercial.
//
// No duplica ningún cálculo: computeComercialStats_() es la MISMA función
// que usa el dashboard propio de Comercial, llamada tal cual aquí.
// Calibraciones no tiene todavía ningún semáforo ni acción de backend
// construida (sigue siendo placeholder puro), así que esa tarjeta muestra
// "Módulo pendiente" en vez de inventar un número.
// ---------------------------------------------------------------

function renderGeneralDashboardView_() {
  var body = document.getElementById('generalDashboardViewBody');
  if (!body) return;

  body.innerHTML =
    '<div class="stat-row" id="generalKpiRow"><div class="stat-card"><div class="label">Cargando&hellip;</div></div></div>' +
    '<div class="panel">' +
    '<div class="panel-head"><h2>Comercial</h2><span class="hint">Mismos números que el dashboard propio de Comercial</span></div>' +
    '<div class="stat-row" id="generalComercialRow"></div>' +
    '</div>' +
    '<div class="panel">' +
    '<div class="panel-head"><h2>Pruebas por mes</h2></div>' +
    '<div style="overflow-x:auto;"><table><thead><tr><th>Mes</th><th>TTR</th><th>Devanados</th><th>Aceite</th><th>Aislamiento</th><th>Total</th></tr></thead>' +
    '<tbody id="generalTestsMonthlyRows"><tr><td colspan="6" class="empty-note">Cargando&hellip;</td></tr></tbody></table></div>' +
    '</div>' +
    '<div class="panel">' +
    '<div class="panel-head"><h2>Documentos recientes</h2></div>' +
    '<div style="overflow-x:auto;"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Nombre</th></tr></thead>' +
    '<tbody id="generalRecentDocsRows"><tr><td colspan="4" class="empty-note">Cargando&hellip;</td></tr></tbody></table></div>' +
    '</div>';

  loadGeneralDashboardAndRender_();
}

function renderGeneralDashboardFromData_(data) {
  renderGeneralKpis_(data.transformers, data.tests, data.calibraciones);
  renderGeneralComercialStats_(data.ofertas);
  renderGeneralTestsMonthlyTable_(data.tests);
  renderGeneralRecentDocuments_(data.documents, data.sites);
}

function loadGeneralDashboardAndRender_() {
  var cached = loadDraft_('mya_cache_general_dashboard');
  if (cached) renderGeneralDashboardFromData_(cached);

  Promise.all([
    callApi('listSites', 'GET', {}),
    callApi('listTransformers', 'GET', {}),
    callApi('listTests', 'GET', { light: 1 }),
    callApi('listOfertas', 'GET', {}),
    callApi('listDocuments', 'GET', {}),
    callApi('listCalibraciones', 'GET', {})
  ]).then(function (results) {
    var data = {
      sites: results[0] || [],
      transformers: results[1] || [],
      tests: results[2] || [],
      ofertas: results[3] || [],
      documents: results[4] || [],
      calibraciones: results[5] || []
    };
    saveDraft_('mya_cache_general_dashboard', data);
    renderGeneralDashboardFromData_(data);
  }).catch(function (err) {
    if (err.status === 402 || err.status === 403) return;
    if (!cached) {
      var row = document.getElementById('generalKpiRow');
      if (row) row.innerHTML = '<div class="stat-card"><div class="label">' + escapeHtml_(formatNetworkAwareError_(err)) + '</div></div>';
    }
  });
}

function renderGeneralKpis_(transformers, tests, calibraciones) {
  var row = document.getElementById('generalKpiRow');
  if (!row) return;
  var activeCount = transformers.filter(function (t) { return (t.estado_equipo || 'Activo') === 'Activo'; }).length;
  var monthPrefix = new Date().toISOString().slice(0, 7);
  var testsThisMonth = tests.filter(function (t) { return String(t.created_at || '').slice(0, 7) === monthPrefix; }).length;
  var porVencer = calibraciones.filter(function (c) { return c.estado === 'Por vencer'; }).length;
  var vencidos = calibraciones.filter(function (c) { return c.estado === 'Vencido'; }).length;

  row.innerHTML =
    '<div class="stat-card"><div class="label">Transformadores activos</div><div class="value num">' + activeCount + '</div><div class="delta">De ' + transformers.length + ' registrados en total</div></div>' +
    '<div class="stat-card"><div class="label">Pruebas del mes</div><div class="value num">' + testsThisMonth + '</div><div class="delta">TTR + Devanados + Aceite + Aislamiento, mes en curso</div></div>' +
    '<div class="stat-card"><div class="label">Calibraciones</div><div class="value" style="font-size:15px;">' + porVencer + ' por vencer &middot; ' + vencidos + ' vencidos</div><div class="delta">De ' + calibraciones.length + ' instrumentos en el catálogo</div></div>';
}

function renderGeneralComercialStats_(ofertas) {
  var row = document.getElementById('generalComercialRow');
  if (!row) return;
  var stats = computeComercialStats_(ofertas);
  row.innerHTML =
    '<div class="stat-card"><div class="label">Valor en pipeline</div><div class="value num">' + fmtCOP_(stats.pipelineValue) + '</div><div class="delta">Suma de ofertas Pendiente</div></div>' +
    '<div class="stat-card"><div class="label">Valor ganado</div><div class="value num">' + fmtCOP_(stats.wonValue) + '</div><div class="delta">Suma de ofertas Aprobada</div></div>' +
    '<div class="stat-card"><div class="label">Tasa de conversión</div><div class="value num">' + (stats.conversionRatePercent === null ? '—' : stats.conversionRatePercent.toFixed(1) + ' %') + '</div><div class="delta">Aprobada / resueltas</div></div>';
}

function renderGeneralTestsMonthlyTable_(tests) {
  var tbody = document.getElementById('generalTestsMonthlyRows');
  if (!tbody) return;
  var byMonth = {};
  tests.forEach(function (t) {
    if (!t.created_at) return;
    var month = String(t.created_at).slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { TTR: 0, RESISTENCIA_DEVANADOS: 0, ACEITE_DIELECTRICO: 0, AISLAMIENTO: 0 };
    if (byMonth[month][t.test_type] !== undefined) byMonth[month][t.test_type]++;
  });
  var months = Object.keys(byMonth).sort().reverse();
  if (months.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Sin pruebas registradas todavía.</td></tr>';
    return;
  }
  tbody.innerHTML = months.map(function (m) {
    var row = byMonth[m];
    var total = row.TTR + row.RESISTENCIA_DEVANADOS + row.ACEITE_DIELECTRICO + row.AISLAMIENTO;
    return '<tr><td class="mono">' + m + '</td><td>' + row.TTR + '</td><td>' + row.RESISTENCIA_DEVANADOS + '</td><td>' + row.ACEITE_DIELECTRICO + '</td><td>' + row.AISLAMIENTO + '</td><td class="mono">' + total + '</td></tr>';
  }).join('');
}

function renderGeneralRecentDocuments_(documents, sites) {
  var tbody = document.getElementById('generalRecentDocsRows');
  if (!tbody) return;
  var recent = documents.slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); }).slice(0, 8);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-note">Sin documentos subidos todavía.</td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(function (d) {
    var site = sites.filter(function (s) { return s.id === d.site_id; })[0];
    var siteLabel = site ? (site.client_name + ' · ' + site.project_name) : '—';
    return '<tr>' +
      '<td>' + fmtDate_(d.created_at) + '</td>' +
      '<td>' + escapeHtml_(siteLabel) + '</td>' +
      '<td><span class="pill neutral">' + escapeHtml_(DOCUMENT_CATEGORY_LABELS[d.category] || d.category) + '</span></td>' +
      '<td>' + escapeHtml_(d.file_name) + '</td>' +
      '</tr>';
  }).join('');
}

function applyComercialFilters_() {
  var tbody = document.getElementById('ofertasRows');
  if (!tbody) return;
  var estado = document.getElementById('filterOfertaEstado').value;
  var siteId = document.getElementById('filterOfertaSite').value;
  var tipo = document.getElementById('filterOfertaTipo').value;
  var dateFromEl = document.getElementById('filterOfertaDateFrom');
  var dateToEl = document.getElementById('filterOfertaDateTo');
  var dateFrom = dateFromEl.value ? new Date(dateFromEl.value) : null;
  var dateTo = dateToEl.value ? new Date(dateToEl.value + 'T23:59:59') : null;

  var rows = state.ofertas.filter(function (o) {
    if (estado && o.estado !== estado) return false;
    if (siteId && o.site_id !== siteId) return false;
    if (tipo && o.tipo !== tipo) return false;
    if (dateFrom || dateTo) {
      var envio = o.fecha_envio ? new Date(o.fecha_envio) : null;
      if (!envio) return false;
      if (dateFrom && envio < dateFrom) return false;
      if (dateTo && envio > dateTo) return false;
    }
    return true;
  });

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-note">No hay ofertas que coincidan con el filtro.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.slice().reverse().map(function (o) {
    return '<tr class="rowlink" onclick="openOfertaDetail_(\'' + o.id + '\')">' +
      '<td>' + escapeHtml_(o.cliente_nombre) + '</td>' +
      '<td>' + escapeHtml_(OFERTA_TIPO_LABELS[o.tipo] || o.tipo) + '</td>' +
      '<td class="mono">' + fmtCOP_(o.valor_cotizado) + '</td>' +
      '<td>' + fmtDate_(o.fecha_envio) + '</td>' +
      '<td>' + fmtDate_(o.fecha_cierre) + '</td>' +
      '<td><span class="pill ' + ofertaEstadoPillClass_(o.estado) + '">' + escapeHtml_(o.estado) + '</span></td>' +
      '<td>' + (o.site_id ? '' : '<span class="pill neutral" title="Sin vincular a un Sitio">Prospecto</span>') + '</td>' +
      '</tr>';
  }).join('');
}

function handleCreateOfertaSubmit(e) {
  e.preventDefault();
  var status = document.getElementById('createOfertaStatus');
  var btn = document.getElementById('createOfertaBtn');
  var cliente = document.getElementById('newOfertaCliente').value.trim();
  if (!cliente) { setStatus_(status, 'El cliente/prospecto es obligatorio', false, true); return; }

  btn.disabled = true;
  setStatus_(status, 'Creando…', false);

  readFileAsBase64_(document.getElementById('newOfertaFile'))
    .then(function (file) {
      var body = {
        cliente_nombre: cliente,
        site_id: document.getElementById('newOfertaSite').value || null,
        tipo: document.getElementById('newOfertaTipo').value,
        descripcion: document.getElementById('newOfertaDescripcion').value.trim(),
        valor_cotizado: parseDecimal_(document.getElementById('newOfertaValor').value) || null,
        fecha_envio: document.getElementById('newOfertaFechaEnvio').value || null,
        fecha_cierre: document.getElementById('newOfertaFechaCierre').value || null,
        responsable: document.getElementById('newOfertaResponsable').value.trim()
      };
      if (file) { body.file_base64 = file.base64; body.file_mime_type = file.mimeType; body.file_name = document.getElementById('newOfertaFile').files[0].name; }
      return callApi('createOferta', 'POST', body);
    })
    .then(function () {
      setStatus_(status, 'Oferta creada', true);
      document.getElementById('createOfertaForm').reset();
      loadOfertasAndRender_();
    })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(status, formatNetworkAwareError_(err), false, true);
    })
    .then(function () { btn.disabled = false; });
}

function ensureOfertaDetailModal_() {
  if (document.getElementById('ofertaDetailModal')) return;
  var backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'ofertaDetailModalBackdrop';
  backdrop.addEventListener('click', closeOfertaDetailModal_);

  var modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'ofertaDetailModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML =
    '<div class="modal-head"><h3>Detalle de la oferta</h3><button type="button" class="modal-close" onclick="closeOfertaDetailModal_()" aria-label="Cerrar">&times;</button></div>' +
    '<div class="modal-body" id="ofertaDetailBody"></div>';

  document.body.appendChild(backdrop);
  document.body.appendChild(modal);
}

function openOfertaDetail_(id) {
  var oferta = state.ofertas.filter(function (o) { return o.id === id; })[0];
  if (!oferta) return;
  state.currentOfertaId = id;

  var siteLabel = '—';
  if (oferta.site_id) {
    var site = state.sites.filter(function (s) { return s.id === oferta.site_id; })[0];
    siteLabel = site ? (site.client_name + ' · ' + site.project_name) : oferta.site_id;
  }

  var siteLinkBlock = oferta.site_id
    ? '<div class="field"><label>Sitio vinculado</label><div>' + escapeHtml_(siteLabel) + '</div></div>'
    : '<div class="field"><label>Vincular a un Sitio</label>' +
      '<select id="linkOfertaSite"><option value="">Selecciona…</option>' +
      state.sites.map(function (s) { return '<option value="' + s.id + '">' + escapeHtml_(s.client_name + ' · ' + s.project_name) + '</option>'; }).join('') +
      '</select>' +
      '<button type="button" class="btn" style="margin-top:8px;" onclick="handleLinkOfertaToSite_()">Vincular (mueve los adjuntos a la carpeta del cliente)</button></div>';

  var estadoActionsBlock = oferta.estado_real === 'Pendiente'
    ? '<button type="button" class="btn primary" onclick="handleOfertaEstadoChange_(\'Aprobada\')">Aprobar</button>' +
      '<button type="button" class="btn" onclick="handleOfertaEstadoChange_(\'Rechazada\')">Rechazar</button>'
    : '';

  var contratoBlock = oferta.estado_real === 'Aprobada'
    ? '<div class="field"><label>Contrato / orden de compra' + (oferta.adjunto_contrato_url ? ' (ya subido, <a href="' + oferta.adjunto_contrato_url + '" target="_blank" rel="noopener">verlo</a>)' : '') + '</label>' +
      '<input id="ofertaContratoFile" type="file" accept="application/pdf,image/*">' +
      '<button type="button" class="btn" style="margin-top:8px;" onclick="handleUploadOfertaContrato_()">Subir contrato</button></div>'
    : '';

  var bitacoraHtml = oferta.bitacora.length === 0
    ? '<div class="empty-note">Sin notas de seguimiento todavía.</div>'
    : oferta.bitacora.slice().reverse().map(function (n) {
        return '<div style="padding:8px 0; border-bottom:1px solid var(--border);">' +
          '<div style="font-size:11px; color:var(--text-muted);">' + fmtDate_(n.fecha) + ' &middot; ' + escapeHtml_(n.autor) + '</div>' +
          '<div>' + escapeHtml_(n.nota) + '</div></div>';
      }).join('');

  document.getElementById('ofertaDetailBody').innerHTML =
    '<div class="field"><label>Cliente / prospecto</label><div>' + escapeHtml_(oferta.cliente_nombre) + '</div></div>' +
    siteLinkBlock +
    '<div class="field"><label>Tipo</label><div>' + escapeHtml_(OFERTA_TIPO_LABELS[oferta.tipo] || oferta.tipo) + '</div></div>' +
    '<div class="field"><label>Descripción</label><div>' + escapeHtml_(oferta.descripcion || '—') + '</div></div>' +
    '<div class="field"><label>Valor cotizado</label><div>' + fmtCOP_(oferta.valor_cotizado) + '</div></div>' +
    '<div class="field"><label>Envío / Cierre</label><div>' + fmtDate_(oferta.fecha_envio) + ' &rarr; ' + fmtDate_(oferta.fecha_cierre) + '</div></div>' +
    '<div class="field"><label>Responsable</label><div>' + escapeHtml_(oferta.responsable || '—') + '</div></div>' +
    '<div class="field"><label>Propuesta enviada</label><div>' + (oferta.adjunto_propuesta_url ? '<a href="' + oferta.adjunto_propuesta_url + '" target="_blank" rel="noopener">Ver / descargar</a>' : '—') + '</div></div>' +
    '<div class="field"><label>Estado</label><div><span class="pill ' + ofertaEstadoPillClass_(oferta.estado) + '">' + escapeHtml_(oferta.estado) + '</span></div></div>' +
    (estadoActionsBlock ? '<div class="field">' + estadoActionsBlock + '</div>' : '') +
    contratoBlock +
    '<div class="field"><label>Bitácora de seguimiento</label>' + bitacoraHtml + '</div>' +
    '<div class="field"><label>Agregar nota</label><input id="ofertaNuevaNota">' +
    '<button type="button" class="btn" style="margin-top:8px;" onclick="handleAddOfertaNota_()">Agregar</button></div>' +
    (state.role === 'Administrador'
      ? '<button type="button" class="btn" style="margin-top:4px; color:var(--danger); border-color:var(--danger-border);" onclick="handleDeleteOferta_()">Eliminar oferta</button>'
      : '') +
    '<span class="status-line" id="ofertaDetailStatus" hidden></span>';

  document.getElementById('ofertaDetailModal').classList.add('open');
  document.getElementById('ofertaDetailModalBackdrop').classList.add('open');
}

function closeOfertaDetailModal_() {
  document.getElementById('ofertaDetailModal').classList.remove('open');
  document.getElementById('ofertaDetailModalBackdrop').classList.remove('open');
  state.currentOfertaId = null;
}

function refreshOfertaDetailAfterChange_() {
  loadOfertasAndRender_();
  var id = state.currentOfertaId;
  callApi('listOfertas', 'GET', {}).then(function (ofertas) {
    state.ofertas = ofertas || [];
    renderComercialDashboard_();
    applyComercialFilters_();
    if (id) openOfertaDetail_(id);
  });
}

function handleOfertaEstadoChange_(estado) {
  var id = state.currentOfertaId;
  if (!id) return;
  var statusEl = document.getElementById('ofertaDetailStatus');
  setStatus_(statusEl, 'Guardando…', false);
  callApi('updateOferta', 'POST', { id: id, estado: estado })
    .then(function () { refreshOfertaDetailAfterChange_(); })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(statusEl, formatNetworkAwareError_(err), false, true);
    });
}

function handleLinkOfertaToSite_() {
  var id = state.currentOfertaId;
  var siteId = document.getElementById('linkOfertaSite').value;
  if (!id || !siteId) return;
  var statusEl = document.getElementById('ofertaDetailStatus');
  setStatus_(statusEl, 'Vinculando…', false);
  callApi('updateOferta', 'POST', { id: id, site_id: siteId })
    .then(function () { refreshOfertaDetailAfterChange_(); })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(statusEl, formatNetworkAwareError_(err), false, true);
    });
}

function handleUploadOfertaContrato_() {
  var id = state.currentOfertaId;
  var fileInput = document.getElementById('ofertaContratoFile');
  if (!id || !fileInput.files[0]) return;
  var statusEl = document.getElementById('ofertaDetailStatus');
  setStatus_(statusEl, 'Subiendo…', false);
  readFileAsBase64_(fileInput)
    .then(function (file) {
      return callApi('updateOferta', 'POST', { id: id, file_base64: file.base64, file_mime_type: file.mimeType, file_name: fileInput.files[0].name, file_slot: 'contrato' });
    })
    .then(function () { refreshOfertaDetailAfterChange_(); })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(statusEl, formatNetworkAwareError_(err), false, true);
    });
}

/** Solo Administrador — el botón ni se pinta para otros roles (ver
 *  openOfertaDetail_), y el backend lo vuelve a exigir. */
function handleDeleteOferta_() {
  var id = state.currentOfertaId;
  if (!id) return;
  var oferta = state.ofertas.filter(function (o) { return o.id === id; })[0];
  if (!oferta || !confirm('¿Eliminar la oferta de "' + oferta.cliente_nombre + '"? Esta acción no se puede deshacer.')) return;
  callApi('deleteOferta', 'POST', { id: id })
    .then(function () {
      closeOfertaDetailModal_();
      loadOfertasAndRender_();
    })
    .catch(function (err) {
      if (err.status === 402 || err.status === 403) return;
      alert('No se pudo eliminar: ' + err.message);
    });
}

function handleAddOfertaNota_() {
  var id = state.currentOfertaId;
  var notaInput = document.getElementById('ofertaNuevaNota');
  var nota = notaInput.value.trim();
  if (!id || !nota) return;
  var statusEl = document.getElementById('ofertaDetailStatus');
  setStatus_(statusEl, 'Guardando…', false);
  callApi('addOfertaNota', 'POST', { id: id, nota: nota })
    .then(function () { refreshOfertaDetailAfterChange_(); })
    .catch(function (err) {
      if (err.status !== 402 && err.status !== 403) setStatus_(statusEl, formatNetworkAwareError_(err), false, true);
    });
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
