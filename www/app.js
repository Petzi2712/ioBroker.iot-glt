'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { bootstrap: null, user: null, csrf: '', pages: [], currentView: 'alarms', editorPage: 0, selectedWidget: null, stateCache: new Map(), reports: [] };
const uid = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function api(url, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = 'toast', 3500);
}

function dateTimeValue(timestamp) {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 16);
}

function number(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(n) : '—';
}

function modal(title, body, actions = []) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const footer = $('#modalActions');
  footer.innerHTML = '';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.primary ? 'primary' : 'quiet';
    button.textContent = action.label;
    button.addEventListener('click', action.click);
    footer.append(button);
  }
  $('#modal').showModal();
}

function closeModal() { $('#modal').close(); }

function can(module, action = 'read') {
  return state.user?.role === 'admin' || Boolean(state.user?.permissions?.[module]?.[action]);
}

async function bootstrap() {
  const data = await api('/api/bootstrap');
  state.bootstrap = data;
  state.user = data.user;
  state.csrf = data.user?.csrf || '';
  state.pages = structuredClone(data.pages || []);
  document.documentElement.style.setProperty('--accent', data.settings?.accent || '#1fd1a5');
  $('#loginButton').textContent = state.user?.id && state.user.id !== 'public' ? 'Abmelden' : 'Anmelden';
  $('#sideUser').textContent = state.user?.displayName || state.user?.username || 'Nicht angemeldet';
  $('#sideRole').textContent = state.user?.role === 'admin' ? 'Administrator' : 'Nur lesen';
  $$('#navigation button').forEach(button => {
    const module = button.dataset.view;
    button.hidden = !data.modules?.[module];
    button.disabled = !data.modules?.[module];
  });
  $('#addAlarm').hidden = !can('alarms', 'write');
  $('#savePages').hidden = !can('editor', 'write');
  $('#newPage').hidden = !can('editor', 'write');
  $('#newUser').hidden = !can('users', 'write');
  fillPageSelects();
  if (data.mustChangePassword) showChangePassword();
  await showView(firstAllowedView(state.currentView));
  stateSearchSetup();
}

function firstAllowedView(preferred) {
  if (state.bootstrap?.modules?.[preferred]) return preferred;
  return ['alarms', 'visualization', 'trends', 'energy', 'editor', 'users'].find(key => state.bootstrap?.modules?.[key]) || 'alarms';
}

async function showView(name) {
  name = firstAllowedView(name);
  state.currentView = name;
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('#navigation button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  if (innerWidth < 900) toggleMenu(false);
  try {
    if (name === 'alarms') await loadAlarms();
    if (name === 'visualization') await renderLivePage();
    if (name === 'editor') renderEditor();
    if (name === 'users') await loadUsers();
    if (name === 'energy') await loadReports();
  } catch (error) { toast(error.message, true); }
}

function toggleMenu(open = !document.body.classList.contains('menu-open')) {
  document.body.classList.toggle('menu-open', open);
  $('#menuToggle').setAttribute('aria-expanded', String(open));
  $('#sidebar').setAttribute('aria-hidden', String(!open));
}

function showLogin() {
  modal('Anmelden', '<label>Benutzername<input id="loginUser" autocomplete="username" value="admin"></label><label>Passwort<input id="loginPassword" type="password" autocomplete="current-password"></label>', [
    { label: 'Abbrechen', click: closeModal },
    { label: 'Anmelden', primary: true, click: async () => {
      try {
        const result = await api('/api/login', { method: 'POST', body: { username: $('#loginUser').value, password: $('#loginPassword').value } });
        state.csrf = result.user.csrf;
        closeModal();
        await bootstrap();
        toast('Erfolgreich angemeldet');
      } catch (error) { toast(error.message, true); }
    } }
  ]);
  $('#loginPassword').addEventListener('keydown', event => { if (event.key === 'Enter') $('#modalActions .primary').click(); });
}

function showChangePassword() {
  modal('Passwort ändern', '<p class="muted">Das Standardpasswort muss vor der weiteren Administration ersetzt werden.</p><label>Aktuelles Passwort<input id="oldPassword" type="password"></label><label>Neues Passwort (mindestens 10 Zeichen)<input id="newPassword" type="password"></label>', [
    { label: 'Jetzt ändern', primary: true, click: async () => {
      try {
        await api('/api/change-password', { method: 'POST', body: { currentPassword: $('#oldPassword').value, newPassword: $('#newPassword').value } });
        closeModal();
        toast('Passwort wurde geändert');
        await bootstrap();
      } catch (error) { toast(error.message, true); }
    } }
  ]);
}

function fillPageSelects() {
  const options = state.pages.map((page, index) => `<option value="${index}">${escapeHtml(page.name)}</option>`).join('');
  $('#pageSelect').innerHTML = options;
  $('#editorPageSelect').innerHTML = options;
  $('#editorPageSelect').value = String(Math.min(state.editorPage, state.pages.length - 1));
}

async function stateValues(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  try {
    const rows = unique.length ? await api(`/api/visual-values?ids=${encodeURIComponent(unique.join(','))}`) : [];
    rows.forEach(row => state.stateCache.set(row.id, row));
  } catch { /* a missing datapoint is represented as unavailable */ }
}

function curveSvg(widget, editable = false) {
  const points = widget.points || (widget.type === 'hx' ? [{ x: .08, y: .82 }, { x: .28, y: .67 }, { x: .5, y: .46 }, { x: .75, y: .25 }, { x: .92, y: .14 }] : [{ x: .08, y: .8 }, { x: .35, y: .64 }, { x: .65, y: .38 }, { x: .92, y: .18 }]);
  const coords = points.map(point => `${20 + point.x * 280},${150 - point.y * 130}`).join(' ');
  const handles = editable ? points.map((point, index) => `<circle class="curveHandle" data-point="${index}" cx="${20 + point.x * 280}" cy="${150 - point.y * 130}" r="6"/>`).join('') : '';
  return `<svg viewBox="0 0 320 170" aria-label="${escapeHtml(widget.label)}"><g>${[0,1,2,3,4].map(i => `<line class="curveGrid" x1="20" y1="${20 + i * 32.5}" x2="300" y2="${20 + i * 32.5}"/>`).join('')}</g><polyline class="curvePath" points="${coords}"/>${handles}<text x="22" y="16" fill="#8ba3c0" font-size="10">${widget.type === 'hx' ? 'Feuchte / Enthalpie' : 'Außentemperatur / Vorlauf'}</text></svg>`;
}

function renderPlant(canvas, page, editing = false) {
  if (!page) return;
  canvas.style.width = `${page.width || 1600}px`;
  canvas.style.height = `${page.height || 900}px`;
  canvas.style.backgroundImage = page.background ? `url(${page.background})` : '';
  canvas.innerHTML = '';
  for (const widget of page.widgets || []) {
    const element = document.createElement('div');
    element.className = `plantWidget ${widget.type === 'digital' ? 'digital' : ''} ${['heatingCurve','hx'].includes(widget.type) ? 'curve' : ''}${widget.id === state.selectedWidget ? ' selected' : ''}`;
    element.dataset.widget = widget.id;
    element.style.left = `${widget.x || 0}px`;
    element.style.top = `${widget.y || 0}px`;
    if (widget.width) element.style.width = `${widget.width}px`;
    const point = state.stateCache.get(widget.stateId);
    if (widget.type === 'heatingCurve' || widget.type === 'hx') {
      element.innerHTML = `<small>${escapeHtml(widget.label || (widget.type === 'hx' ? 'h,x-Diagramm' : 'Heizkurve'))}</small>${curveSvg(widget, editing)}`;
    } else {
      const value = point?.val;
      const on = Boolean(value);
      element.classList.toggle('on', widget.type === 'digital' && on);
      element.classList.toggle('writable', !editing && point?.write && can('visualization', 'write'));
      element.innerHTML = `<small>${escapeHtml(widget.label || widget.stateId || 'Einblendpunkt')}</small><strong>${widget.type === 'digital' ? (on ? (widget.onText || 'EIN') : (widget.offText || 'AUS')) : `${number(value, widget.decimals ?? 2)} ${escapeHtml(widget.unit || point?.unit || '')}`}</strong>`;
    }
    if (editing) bindEditorWidget(element, widget, page);
    else bindLiveWidget(element, widget, point);
    canvas.append(element);
  }
}

function bindLiveWidget(element, widget, point) {
  element.addEventListener('click', async () => {
    if (widget.type === 'analog' && widget.stateId) {
      $('#trendState').value = widget.stateId;
      await showView('trends');
      await loadTrend();
    } else if (widget.type === 'digital' && point?.write && can('visualization', 'write')) {
      try { await api('/api/state', { method: 'PUT', body: { id: widget.stateId, value: !Boolean(point.val) } }); toast('Sollwert übertragen'); setTimeout(renderLivePage, 600); } catch (error) { toast(error.message, true); }
    }
  });
}

function bindEditorWidget(element, widget, page) {
  element.addEventListener('pointerdown', event => {
    state.selectedWidget = widget.id;
    if (event.target.classList.contains('curveHandle')) {
      const point = widget.points[Number(event.target.dataset.point)];
      const rect = element.querySelector('svg').getBoundingClientRect();
      const move = moveEvent => {
        point.x = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left - 20) / (rect.width - 40)));
        point.y = Math.max(0, Math.min(1, 1 - (moveEvent.clientY - rect.top - 20) / (rect.height - 40)));
        renderEditor();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
      return;
    }
    const start = { x: event.clientX, y: event.clientY, wx: widget.x || 0, wy: widget.y || 0 };
    const move = moveEvent => {
      widget.x = Math.max(0, Math.round(start.wx + moveEvent.clientX - start.x));
      widget.y = Math.max(0, Math.round(start.wy + moveEvent.clientY - start.y));
      element.style.left = `${widget.x}px`;
      element.style.top = `${widget.y}px`;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); renderEditor(); }, { once: true });
    renderInspector(widget, page);
  });
}

async function renderLivePage() {
  const page = state.pages[Number($('#pageSelect').value || 0)];
  await stateValues((page?.widgets || []).map(widget => widget.stateId));
  renderPlant($('#liveCanvas'), page, false);
}

function renderEditor() {
  state.editorPage = Number($('#editorPageSelect').value || state.editorPage || 0);
  const page = state.pages[state.editorPage];
  renderPlant($('#editorCanvas'), page, true);
  const selected = page?.widgets?.find(widget => widget.id === state.selectedWidget);
  renderInspector(selected, page);
}

function renderInspector(widget, page) {
  const node = $('#widgetInspector');
  if (!widget) { node.innerHTML = '<p class="muted">Ein Element im Anlagenbild auswählen.</p>'; return; }
  node.innerHTML = `<label>Beschriftung<input id="inspectLabel" value="${escapeHtml(widget.label || '')}"></label>${!['heatingCurve','hx'].includes(widget.type) ? `<label>Datenpunkt<input id="inspectState" list="stateOptions" value="${escapeHtml(widget.stateId || '')}"></label><label>Einheit<input id="inspectUnit" value="${escapeHtml(widget.unit || '')}"></label>` : ''}<label>Breite<input id="inspectWidth" type="number" min="80" max="900" value="${widget.width || (['heatingCurve','hx'].includes(widget.type) ? 320 : 120)}"></label><button id="deleteWidget">Element löschen</button>`;
  const update = () => {
    widget.label = $('#inspectLabel').value;
    if ($('#inspectState')) widget.stateId = $('#inspectState').value;
    if ($('#inspectUnit')) widget.unit = $('#inspectUnit').value;
    widget.width = Number($('#inspectWidth').value) || 120;
    renderEditor();
  };
  node.querySelectorAll('input').forEach(input => input.addEventListener('change', update));
  $('#deleteWidget').addEventListener('click', () => { page.widgets = page.widgets.filter(item => item.id !== widget.id); state.selectedWidget = null; renderEditor(); });
}

async function loadAlarms() {
  const alarms = await api('/api/alarms');
  const activeAlarms = alarms.filter(item => item.active && item.severity === 'alarm');
  const warnings = alarms.filter(item => item.active && item.severity === 'warning');
  $('#alarmCount').textContent = activeAlarms.length;
  $('#warningCount').textContent = warnings.length;
  $('#okCount').textContent = alarms.filter(item => !item.active).length;
  $('#alarmList').classList.toggle('empty', !alarms.length);
  $('#alarmList').innerHTML = alarms.length ? alarms.map(item => `<div class="tableRow"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.stateId)}</small></div><span class="pill ${item.active ? item.severity : 'ok'}">${item.active ? (item.severity === 'alarm' ? 'STÖRUNG' : 'WARNUNG') : 'OK'}</span><span>${escapeHtml(item.currentValue ?? '—')}</span><small>${item.ts ? new Date(item.ts).toLocaleString('de-DE') : '—'}</small><button class="quiet" data-delete-alarm="${item.id}" ${can('alarms','write') ? '' : 'hidden'}>Entfernen</button></div>`).join('') : 'Noch keine Melderegeln eingerichtet.';
  $$('[data-delete-alarm]').forEach(button => button.addEventListener('click', async () => { await api('/api/alarms', { method: 'PUT', body: alarms.filter(item => item.id !== button.dataset.deleteAlarm) }); await loadAlarms(); }));
}

function showAddAlarm() {
  modal('Melderegel anlegen', '<label>Name<input id="a