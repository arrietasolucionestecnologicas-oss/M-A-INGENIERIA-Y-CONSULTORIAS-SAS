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

/** IdP central "Control de Acceso" (JL Bedoya Group) — login, cambio de contraseña, creación de usuarios. */
const CONTROL_ACCESO_URL = "https://script.google.com/macros/s/AKfycby4K-qxW87hfd9Fy1wKHeyF8bic_Qo8clKfJ-ZuPg9zElNuc7XOe8qTgW8sUmJ9mnKjDA/exec";

/** Identificador de esta app dentro de Control de Acceso (fila en la hoja Config). */
const APP_ID = "MYA_PRUEBAS";

const TOLERANCE_PERCENT = 0.5;
const UNBALANCE_THRESHOLD = 5.0;

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
  ttr: { currentTap: null, readings: {} },
  matrix: { taps: [] },
  wr: { currentTap: null, readings: {} }
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
  if (verdict === 'APROBADO') return 'success';
  if (verdict === 'RECHAZADO') return 'danger';
  if (verdict === 'OBSERVADO') return 'warning';
  return 'neutral';
}

function syntaxHighlight(obj) {
  var json = JSON.stringify(obj, null, 2)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    function (match) {
      var cls = 'json-num';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'json-key' : 'json-str';
      else if (/true|false|null/.test(match)) cls = 'json-bool';
      return '<span class="' + cls + '">' + match + '</span>';
    }
  );
}

function setStatus_(el, message, ok, isError) {
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || '';
  el.className = 'status-line' + (isError ? ' error' : (ok ? ' ok' : ''));
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

// ---------------------------------------------------------------
// Navegación entre vistas
// ---------------------------------------------------------------

function showView(name) {
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
    removeAdminNavAndPanel();
  }

  ['sites', 'dashboard', 'detail', 'ttr-form', 'winding-form', 'admin'].forEach(function (v) {
    var el = document.getElementById('view-' + v);
    if (el) el.hidden = (name !== v);
  });

  document.querySelectorAll('.nav-item[data-view]').forEach(function (el) {
    el.classList.toggle('active', el.dataset.view === name);
  });
  window.scrollTo(0, 0);

  // Jerarquía obligatoria: Fase 2 (Equipos) exige Fase 1 (Cliente/Proyecto);
  // Fase 3 (Pruebas) exige un equipo ya validado en Fase 2.
  if (name === 'dashboard' && !state.currentSiteId) {
    alert('Selecciona primero un Cliente/Proyecto (Fase 1).');
    return showView('sites');
  }
  if ((name === 'ttr-form' || name === 'winding-form') && !state.currentTransformer) {
    alert('Selecciona primero un equipo desde Fase 2.');
    return showView(state.currentSiteId ? 'dashboard' : 'sites');
  }
  if (name === 'ttr-form') { renderTtrFormContext(); renderMatrixRows(); refreshTtr(); }
  if (name === 'winding-form') { renderWindingFormContext(); refreshWinding(); }
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

      renderAdminNavAndPanel();
      return loadSitesAndShow_();
    })
    .catch(function (err) {
      setStatus_(errEl, 'No se pudo contactar el servicio de autenticación: ' + err.message, false, true);
    })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Fase 1: Cliente / Proyecto (Sitios)
// ---------------------------------------------------------------

function loadSitesAndShow_() {
  return callApi('listSites', 'GET', {})
    .then(function (sites) {
      state.sites = sites || [];
      renderSites();
      showView('sites');
    })
    .catch(function (err) {
      if (err.status === 402) return; // ya se mostró la pantalla de suspendido
      alert('No se pudieron cargar los clientes/proyectos: ' + err.message);
    });
}

function renderSites() {
  var tbody = document.getElementById('sitesRows');
  var chip = document.getElementById('sitesTenantChip');
  if (chip) chip.textContent = state.username + ' · ' + state.role;
  if (!tbody) return;

  if (state.sites.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-note">No hay clientes/proyectos todavía. Crea el primero arriba para empezar (Fase 1).</td></tr>';
    return;
  }

  tbody.innerHTML = state.sites.map(function (s) {
    return '<tr class="rowlink" onclick="selectSite(\'' + s.id + '\')">' +
      '<td>' + escapeHtml_(s.client_name) + '</td>' +
      '<td>' + escapeHtml_(s.project_name) + '</td>' +
      '<td>' + escapeHtml_(s.address || '—') + '</td>' +
      '<td><span class="pill neutral">Seleccionar &rarr;</span></td>' +
      '</tr>';
  }).join('');
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
  if (!clientName || !projectName) return;

  var btn = document.getElementById('createSiteBtn');
  var status = document.getElementById('createSiteStatus');
  btn.disabled = true;
  setStatus_(status, 'Creando…', false);

  callApi('createSite', 'POST', { client_name: clientName, project_name: projectName, address: address })
    .then(function () {
      setStatus_(status, 'Cliente/Proyecto creado', true);
      document.getElementById('createSiteForm').reset();
      return loadSitesAndShow_();
    })
    .catch(function (err) {
      if (err.status !== 402) setStatus_(status, formatNetworkAwareError_(err), false, true);
    })
    .then(function () { btn.disabled = false; });
}

function loadDashboardAndShow_() {
  if (!state.currentSiteId) return showView('sites');
  return callApi('listTransformers', 'GET', { site_id: state.currentSiteId })
    .then(function (transformers) {
      state.transformers = transformers || [];
      renderDashboard();
      showView('dashboard');
    })
    .catch(function (err) {
      if (err.status === 402) return; // ya se mostró la pantalla de suspendido
      alert('No se pudieron cargar los transformadores: ' + err.message);
    });
}

function handleCreateTransformerSubmit(e) {
  e.preventDefault();
  if (!state.currentSiteId) { alert('Selecciona primero un Cliente/Proyecto (Fase 1).'); return; }

  var hv = parseDecimal_(document.getElementById('newTrfHv').value);
  var lv = parseDecimal_(document.getElementById('newTrfLv').value);
  var btn = document.getElementById('createTransformerBtn');
  var status = document.getElementById('createTransformerStatus');
  btn.disabled = true;
  setStatus_(status, 'Creando…', false);

  var nominalForTaps = isNaN(hv) ? 0 : hv;
  callApi('createTransformer', 'POST', {
    site_id: state.currentSiteId,
    serial_number: document.getElementById('newTrfSerial').value.trim(),
    manufacturer: document.getElementById('newTrfManufacturer').value.trim(),
    phase_type: document.getElementById('newTrfPhaseType').value,
    vector_group: document.getElementById('newTrfVectorGroup').value.trim() || null,
    hv_nominal_voltage: isNaN(hv) ? null : hv,
    lv_nominal_voltage: isNaN(lv) ? null : lv,
    is_special_design: false,
    tap_config: {
      nominalVoltage: nominalForTaps,
      stepPercentage: 2.5,
      numPositions: 5,
      neutralPosition: 3,
      positions: buildDefaultTapPositions_(nominalForTaps)
    }
  })
    .then(function () {
      setStatus_(status, 'Equipo creado', true);
      document.getElementById('createTransformerForm').reset();
      return loadDashboardAndShow_();
    })
    .catch(function (err) {
      if (err.status !== 402) setStatus_(status, formatNetworkAwareError_(err), false, true);
    })
    .then(function () { btn.disabled = false; });
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
      renderAdminNavAndPanel();
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
    '<span>El usuario nuevo deberá cambiar esta contraseña al entrar</span><span class="tag">DebeCambiar</span></div>' +
    '</div></div>';

  document.querySelector('main').appendChild(section);
  document.getElementById('createUserForm').addEventListener('submit', handleCreateUserSubmit);
}

function removeAdminNavAndPanel() {
  var navItem = document.querySelector('.nav-item[data-view="admin"]');
  if (navItem) {
    var label = navItem.previousElementSibling;
    if (label && label.classList.contains('nav-label')) label.remove();
    navItem.remove();
  }
  var section = document.getElementById('view-admin');
  if (section) section.remove();
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
    return '<tr class="rowlink" onclick="openTransformer(\'' + t.id + '\')">' +
      '<td class="mono">' + escapeHtml_(t.serial_number) + '</td>' +
      '<td>' + escapeHtml_(t.manufacturer || '—') + '</td>' +
      '<td>' + phaseLabel + specialTag + '</td>' +
      '<td>' + fmtDate_(t.updated_at) + '</td>' +
      '<td><span class="pill neutral">' + escapeHtml_(t.status || 'ACTIVO') + '</span></td>' +
      '</tr>';
  }).join('');
}

function openTransformer(id) {
  document.getElementById('detailTopTitle').textContent = 'Cargando…';
  showView('detail');

  Promise.all([
    callApi('getTransformer', 'GET', { id: id }),
    callApi('listTests', 'GET', { transformer_id: id })
  ]).then(function (results) {
    state.currentTransformerId = id;
    state.currentTransformer = results[0];
    state.currentTests = results[1] || [];
    renderDetail();
    resetTtrStateFromTransformer();
    resetMatrixStateFromTransformer();
    resetWindingStateFromTransformer();
  }).catch(function (err) {
    if (err.status === 402) return;
    alert('No se pudo cargar el transformador: ' + err.message);
    showView('dashboard');
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
    ['Tensión HV nominal', fmtVoltage_(t.hv_nominal_voltage)],
    ['Tensión LV nominal', fmtVoltage_(t.lv_nominal_voltage)],
    ['TAPs configurados', (cfg.positions || []).length],
    ['Paso por TAP', cfg.stepPercentage != null ? (cfg.stepPercentage + ' %') : '—']
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
  refreshMatrixJson();
}

function addTapRow() {
  var existing = state.matrix.taps.map(function (t) { return t.tapPosition; });
  var nextPos = existing.length ? Math.max.apply(null, existing) + 1 : 1;
  var phases = {};
  getPhaseKeys().forEach(function (k) { phases[k] = { theoreticalRatio: 0 }; });
  state.matrix.taps.push({ tapPosition: nextPos, phases: phases });
  renderMatrixRows();
  refreshMatrixJson();
}

function removeTapRow(tapPosition) {
  if (state.matrix.taps.length <= 1) return;
  state.matrix.taps = state.matrix.taps.filter(function (t) { return t.tapPosition !== tapPosition; });
  renderMatrixRows();
  refreshMatrixJson();
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
    if (err.status !== 402) setStatus_(status, formatNetworkAwareError_(err), false, true);
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
  var el = document.getElementById('jsonTtr');
  if (el) el.innerHTML = syntaxHighlight(Object.assign({ action: 'submitTtrTest', token: state.token }, buildTtrRequestBody()));
  saveDraft_('mya_draft_ttr_' + state.currentTransformerId, state.ttr.readings);
}

function refreshMatrixJson() {
  var el = document.getElementById('jsonMatrix');
  if (el) el.innerHTML = syntaxHighlight(Object.assign({ action: 'updateTransformer', token: state.token }, buildMatrixRequestBody()));
}

function switchJsonTab(tab) {
  document.querySelectorAll('#view-ttr-form .json-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
  document.getElementById('jsonTtr').hidden = tab !== 'ttr';
  document.getElementById('jsonMatrix').hidden = tab !== 'matrix';
  if (tab === 'matrix') refreshMatrixJson();
}

function submitTtr() {
  var btn = document.getElementById('submitTtrBtn');
  var status = document.getElementById('ttrSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  callApi('submitTtrTest', 'POST', buildTtrRequestBody())
    .then(function (data) {
      setStatus_(status, 'Prueba registrada · veredicto: ' + data.calculated_results.overallVerdict, true);
      clearDraft_('mya_draft_ttr_' + state.currentTransformerId);
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; renderDetail(); })
    .catch(function (err) {
      // Las lecturas quedan intactas en state.ttr.readings y en el borrador local: el técnico puede reintentar sin volver a digitar.
      if (err.status !== 402) setStatus_(status, formatNetworkAwareError_(err), false, true);
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
  var el = document.getElementById('jsonWinding');
  if (el) el.innerHTML = syntaxHighlight(Object.assign({ action: 'submitWindingResistanceTest', token: state.token }, buildWindingRequestBody()));
  saveDraft_('mya_draft_wr_' + state.currentTransformerId, state.wr.readings);
}

function submitWinding() {
  var btn = document.getElementById('submitWrBtn');
  var status = document.getElementById('wrSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  callApi('submitWindingResistanceTest', 'POST', buildWindingRequestBody())
    .then(function (data) {
      setStatus_(status, 'Prueba registrada · veredicto: ' + data.calculated_results.overallVerdict, true);
      clearDraft_('mya_draft_wr_' + state.currentTransformerId);
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; renderDetail(); })
    .catch(function (err) {
      // Las lecturas quedan intactas en state.wr.readings y en el borrador local: el técnico puede reintentar sin volver a digitar.
      if (err.status !== 402) setStatus_(status, formatNetworkAwareError_(err), false, true);
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

  document.querySelectorAll('.nav-item[data-view]').forEach(function (el) {
    el.addEventListener('click', function () { showView(el.dataset.view); closeMobileNav_(); });
  });

  var mobileNavBtn = document.getElementById('mobileNavBtn');
  var mobileNavBackdrop = document.getElementById('mobileNavBackdrop');
  if (mobileNavBtn) mobileNavBtn.addEventListener('click', toggleMobileNav_);
  if (mobileNavBackdrop) mobileNavBackdrop.addEventListener('click', closeMobileNav_);

  showView('login');
});

// ---------------------------------------------------------------
// Navegación móvil (menú lateral tipo cajón, bajo 900px)
// ---------------------------------------------------------------

function toggleMobileNav_() {
  var sidebar = document.getElementById('sidebar');
  var open = sidebar.classList.toggle('open');
  document.getElementById('mobileNavBackdrop').classList.toggle('open', open);
  document.getElementById('mobileNavBtn').setAttribute('aria-expanded', String(open));
}

function closeMobileNav_() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobileNavBackdrop').classList.remove('open');
  document.getElementById('mobileNavBtn').setAttribute('aria-expanded', 'false');
}
