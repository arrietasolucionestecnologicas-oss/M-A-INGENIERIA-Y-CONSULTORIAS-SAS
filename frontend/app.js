'use strict';

/* ============================================================
   M&A Gestión de Pruebas — app.js
   Lógica de UI + cliente HTTP contra el backend Apps Script
   (backend-apps-script/Código.gs).
   ============================================================ */

// ---------------------------------------------------------------
// Configuración de conexión
// ---------------------------------------------------------------

/** Reemplaza con la URL del Web App (Implementar > Nueva implementación > Aplicación web), termina en /exec. */
const API_WEBHOOK_URL = "URL_DE_APPS_SCRIPT_AQUI";

/** Acciones que no requieren tenant_slug todavía (ver PUBLIC_ACTIONS en Código.gs). */
const PUBLIC_CLIENT_ACTIONS = { createClient: true };

const TOLERANCE_PERCENT = 0.5;
const UNBALANCE_THRESHOLD = 5.0;

// ---------------------------------------------------------------
// Estado global de la aplicación
// ---------------------------------------------------------------

var state = {
  tenantSlug: null,
  userDisplayName: null,
  transformers: [],
  currentTransformerId: null,
  currentTransformer: null,
  currentTests: [],
  role: 'tecnico',
  ttr: { currentTap: null, readings: {} },
  matrix: { taps: [] },
  wr: { currentTap: null, readings: {} }
};

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
  if (!API_WEBHOOK_URL || API_WEBHOOK_URL === 'URL_DE_APPS_SCRIPT_AQUI') {
    return Promise.reject(new ApiError(0, 'Configura API_WEBHOOK_URL en app.js con la URL real del Web App de Apps Script'));
  }
  if (!state.tenantSlug && !PUBLIC_CLIENT_ACTIONS[action]) {
    return Promise.reject(new ApiError(0, 'No hay una sesión activa (tenant_slug ausente)'));
  }

  var body = Object.assign({ action: action, tenant_slug: state.tenantSlug }, payload || {});
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

// ---------------------------------------------------------------
// Navegación entre vistas
// ---------------------------------------------------------------

function showView(name) {
  var isFullscreen = name === 'login' || name === 'suspended';
  document.getElementById('app-shell').style.display = isFullscreen ? 'none' : 'grid';
  document.getElementById('screen-login').hidden = name !== 'login';
  document.getElementById('screen-suspended').hidden = name !== 'suspended';

  if (name === 'login') {
    state.tenantSlug = null;
    state.currentTransformer = null;
  }

  ['dashboard', 'detail', 'ttr-form', 'winding-form'].forEach(function (v) {
    var el = document.getElementById('view-' + v);
    if (el) el.hidden = (name !== v);
  });

  document.querySelectorAll('.nav-item[data-view]').forEach(function (el) {
    el.classList.toggle('active', el.dataset.view === name);
  });
  window.scrollTo(0, 0);

  if ((name === 'ttr-form' || name === 'winding-form') && !state.currentTransformer) {
    alert('Selecciona primero un transformador desde el Panel general.');
    return showView('dashboard');
  }
  if (name === 'ttr-form') { renderTtrFormContext(); renderMatrixRows(); refreshTtr(); }
  if (name === 'winding-form') { renderWindingFormContext(); refreshWinding(); }
}

// ---------------------------------------------------------------
// Login — primera llamada real (Kill Switch) + carga del panel
// ---------------------------------------------------------------

function handleLoginSubmit(e) {
  e.preventDefault();
  var slug = document.getElementById('loginSlug').value.trim();
  var email = document.getElementById('loginEmail').value.trim();
  if (!slug) return;

  state.tenantSlug = slug;
  state.userDisplayName = email || 'Usuario';

  var btn = document.getElementById('loginSubmitBtn');
  var errEl = document.getElementById('loginError');
  btn.disabled = true;
  setStatus_(errEl, '', false);

  callApi('listTransformers', 'GET', {})
    .then(function (transformers) {
      state.transformers = transformers || [];
      document.getElementById('sidebarUserName').textContent = state.userDisplayName;
      document.getElementById('sidebarTenant').textContent = state.tenantSlug;
      document.getElementById('dashboardTenantLabel').textContent = state.tenantSlug;
      renderDashboard();
      showView('dashboard');
    })
    .catch(function (err) {
      if (err.status === 402) return; // ya se mostró la pantalla de suspendido
      state.tenantSlug = null;
      setStatus_(errEl, err.message, false, true);
    })
    .then(function () { btn.disabled = false; });
}

function refreshLoginPreview() {
  var el = document.getElementById('jsonLogin');
  if (!el) return;
  el.innerHTML = syntaxHighlight({
    action: 'listTransformers',
    tenant_slug: document.getElementById('loginSlug').value
  });
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
      '<td>' + escapeHtml_(t.site_id || '—') + '</td>' +
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
  document.getElementById('detailMeta').textContent =
    [t.site_id, phaseLabel, powerLabel].filter(Boolean).join(' · ');

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
  document.getElementById('ttrTenantChip').textContent = state.tenantSlug;
  document.getElementById('ttrVectorGroupLabel').textContent = t.vector_group || 'N/A';
  document.getElementById('tapCountLabel').textContent = tapPositions().length;
}

function resetTtrStateFromTransformer() {
  var positions = tapPositions();
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
  var v = parseFloat(value); if (isNaN(v)) v = 0;
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

function renderMatrixRows() {
  var tbody = document.getElementById('matrixRows');
  if (!tbody) return;
  var disabled = state.role !== 'supervisor';
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

  document.getElementById('matrixLock').hidden = state.role === 'supervisor';
  document.getElementById('addTapBtn').disabled = disabled;
  document.getElementById('saveMatrixBtn').disabled = disabled;
}

function updateMatrixValue(tapPosition, key, value) {
  var t = state.matrix.taps.filter(function (x) { return x.tapPosition === tapPosition; })[0];
  if (!t) return;
  var v = parseFloat(value); if (isNaN(v)) v = 0;
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

document.addEventListener('DOMContentLoaded', function () {
  var seg = document.getElementById('roleSegment');
  if (!seg) return;
  seg.querySelectorAll('.seg-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.role = btn.dataset.role;
      seg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
      renderMatrixRows();
    });
  });
});

function saveMatrix() {
  var btn = document.getElementById('saveMatrixBtn');
  var status = document.getElementById('matrixSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Guardando…', false);

  callApi('updateTransformer', 'POST', {
    id: state.currentTransformerId,
    custom_tap_ratio_matrix: { source: 'Cargada desde la interfaz · ' + (state.userDisplayName || 'usuario'), taps: state.matrix.taps }
  }).then(function () {
    setStatus_(status, 'Matriz guardada', true);
    state.currentTransformer.custom_tap_ratio_matrix = { taps: JSON.parse(JSON.stringify(state.matrix.taps)) };
    refreshTtr();
  }).catch(function (err) {
    if (err.status !== 402) setStatus_(status, err.message, false, true);
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
    tested_by: state.userDisplayName,
    readings: { testVoltageV: parseFloat(document.getElementById('ttrVoltage').value) || null, measurements: measurements }
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
  if (el) el.innerHTML = syntaxHighlight(Object.assign({ action: 'submitTtrTest', tenant_slug: state.tenantSlug }, buildTtrRequestBody()));
}

function refreshMatrixJson() {
  var el = document.getElementById('jsonMatrix');
  if (el) el.innerHTML = syntaxHighlight(Object.assign({ action: 'updateTransformer', tenant_slug: state.tenantSlug }, buildMatrixRequestBody()));
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
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; renderDetail(); })
    .catch(function (err) { if (err.status !== 402) setStatus_(status, err.message, false, true); })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Formulario de Resistencia de Devanados (multi-TAP)
// ---------------------------------------------------------------

function renderWindingFormContext() {
  var t = state.currentTransformer;
  document.getElementById('wrFormSubtitle').textContent = t.serial_number + ' · Desbalance entre fases';
  document.getElementById('wrTenantChip').textContent = state.tenantSlug;
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
  var v = parseFloat(value); if (isNaN(v)) v = 0;
  state.wr.readings[state.wr.currentTap].phases[key] = { resistanceOhm: v };
  refreshWinding();
}

function updateWrTemp(value) {
  var v = parseFloat(value); if (isNaN(v)) v = 0;
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
    tested_by: state.userDisplayName,
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
  if (el) el.innerHTML = syntaxHighlight(Object.assign({ action: 'submitWindingResistanceTest', tenant_slug: state.tenantSlug }, buildWindingRequestBody()));
}

function submitWinding() {
  var btn = document.getElementById('submitWrBtn');
  var status = document.getElementById('wrSubmitStatus');
  btn.disabled = true;
  setStatus_(status, 'Enviando…', false);

  callApi('submitWindingResistanceTest', 'POST', buildWindingRequestBody())
    .then(function (data) {
      setStatus_(status, 'Prueba registrada · veredicto: ' + data.calculated_results.overallVerdict, true);
      return callApi('listTests', 'GET', { transformer_id: state.currentTransformerId });
    })
    .then(function (tests) { state.currentTests = tests || []; renderDetail(); })
    .catch(function (err) { if (err.status !== 402) setStatus_(status, err.message, false, true); })
    .then(function () { btn.disabled = false; });
}

// ---------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);
  document.getElementById('loginSlug').addEventListener('input', refreshLoginPreview);
  refreshLoginPreview();

  document.querySelectorAll('.nav-item[data-view]').forEach(function (el) {
    el.addEventListener('click', function () { showView(el.dataset.view); });
  });

  showView('login');
});
