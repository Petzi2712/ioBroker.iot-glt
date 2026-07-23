'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { bootstrap: null, user: null, csrf: '', pages: [], navigationTree: [], selectedTreeId: '', expandedTreeIds: new Set(), currentView: 'dashboard', editorPage: 0, selectedWidget: null, stateCache: new Map(), reports: [], trendSeries: [], trendData: [], trendZoomHistory: [], trendWheelSession: 0, energySeries: [], energyData: [], users: [], userSearch: '', userSort: { key: 'displayName', direction: 1 }, autoLogoutTimer: null, lastKeepAlive: 0, treeDragActive: false, dashboardEdit: false, dashboardActiveId: null, dashboardWidgets: [] };
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

function showTooltipAt(tooltip, clientX, clientY) {
  tooltip.style.display = 'block';
  const rect = tooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - rect.width - 8, clientX + 14));
  const preferredTop = clientY + 14;
  const top = preferredTop + rect.height <= innerHeight - 8 ? preferredTop : Math.max(8, clientY - rect.height - 14);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
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

async function showObjectPicker({ title = 'ioBroker-Objektbaum', numericOnly = false, multiple = false, selected = [], onApply }) {
  const selectedMap = new Map((selected || []).map(item => [typeof item === 'string' ? item : item.id, typeof item === 'string' ? { id: item, name: item, unit: '' } : item]));
  const dialog = document.createElement('dialog');
  dialog.className = 'objectPickerDialog';
  dialog.innerHTML = `<form method="dialog"><header><h2>${escapeHtml(title)}</h2><button value="cancel" aria-label="Schließen">×</button></header><div class="objectPicker"><label class="objectPickerSearch">Objekte durchsuchen<input class="objectPickerSearchInput" type="search" placeholder="Name, Rolle oder vollständige DP-Adresse"></label><div class="objectPickerResults"><div class="empty">Objektbaum wird geladen …</div></div></div><footer><button type="button" class="quiet objectPickerCancel">Abbrechen</button><button type="button" class="primary objectPickerApply">${multiple ? 'Auswahl übernehmen' : 'Datenpunkt übernehmen'}</button></footer></form>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('.objectPickerCancel').addEventListener('click', close);
  dialog.querySelector('header button').addEventListener('click', event => { event.preventDefault(); close(); });
  dialog.querySelector('.objectPickerApply').addEventListener('click', () => {
    const rows = [...selectedMap.values()];
    if (!rows.length) return toast('Bitte mindestens einen Datenpunkt auswählen', true);
    close();
    onApply?.(multiple ? rows : rows.slice(-1));
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.showModal();
  let timer;
  const search = async query => {
    const rows = await api(`/${numericOnly ? 'api/trend-states' : 'api/states'}?query=${encodeURIComponent(query)}`);
    const target = dialog.querySelector('.objectPickerResults');
    target.innerHTML = rows.length ? rows.map(row => `<label class="objectPickerRow"><input type="${multiple ? 'checkbox' : 'radio'}" name="objectPickerItem" value="${escapeHtml(row.id)}" ${selectedMap.has(row.id) ? 'checked' : ''}><span><strong>${escapeHtml(row.name || row.id)}</strong><small>${escapeHtml(row.id)}${row.role ? ` · ${escapeHtml(row.role)}` : ''}</small></span><small>${escapeHtml(row.unit || '')}</small></label>`).join('') : '<div class="empty">Keine passenden Datenpunkte gefunden.</div>';
    target.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
      const row = rows.find(item => item.id === input.value);
      if (!multiple) selectedMap.clear();
      if (input.checked && row) selectedMap.set(row.id, row);
      else selectedMap.delete(input.value);
    }));
  };
  dialog.querySelector('.objectPickerSearchInput').addEventListener('input', event => {
    clearTimeout(timer);
    timer = setTimeout(() => search(event.target.value).catch(error => toast(error.message, true)), 250);
  });
  await search('');
}

function can(module, action = 'read') {
  return state.user?.role === 'admin' || Boolean(state.user?.permissions?.[module]?.[action]);
}

function applyFont(value) {
  document.body.classList.toggle('font-material', value === 'material');
  document.body.classList.toggle('font-apple', value !== 'material');
}

function applyTheme(value = 'light') {
  const resolved = value === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
  document.documentElement.dataset.theme = resolved === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = value;
}

async function bootstrap() {
  const data = await api('/api/bootstrap');
  state.bootstrap = data;
  state.user = data.user;
  state.csrf = data.user?.csrf || '';
  state.pages = structuredClone(data.pages || []);
  state.navigationTree = structuredClone(data.navigationTree || []);
  state.dashboardWidgets = structuredClone(data.dashboardWidgets || []).map(widget => ({ ...widget, dp: widget.stateId || widget.dp || '' }));
  if (!state.expandedTreeIds.size) state.navigationTree.filter(node => !node.url).forEach(node => state.expandedTreeIds.add(node.id));
  document.documentElement.style.setProperty('--accent', '#fe6e00');
  applyFont(data.settings?.fontFamily || 'apple');
  applyTheme(data.settings?.theme || 'light');
  $('#headerSiteName').textContent = data.settings?.siteName || 'Gebäude Zentrale';
  $('#settingsSiteName').value = data.settings?.siteName || 'Gebäude Zentrale';
  $('#settingsFont').value = data.settings?.fontFamily === 'material' ? 'material' : 'apple';
  $('#settingsTheme').value = ['light', 'dark', 'system'].includes(data.settings?.theme) ? data.settings.theme : 'light';
  $('#settingsAutoLogoff').value = String(data.settings?.autoLogoffMinutes || 30);
  $('#settingsIoBrokerUrl').value = data.settings?.ioBrokerAdminUrl || '';
  const authenticated = state.user?.id && state.user.id !== 'public';
  $('#headerUserName').textContent = authenticated ? (state.user.displayName || state.user.username) : 'Anmelden';
  $('#headerUserAvatar').textContent = authenticated ? String(state.user.displayName || state.user.username || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() : '?';
  $('#sideUser').textContent = state.user?.displayName || state.user?.username || 'Nicht angemeldet';
  $('#sideRole').textContent = state.user?.role === 'admin' ? 'Administrator' : 'Nur lesen';
  $('#sideVersion').textContent = data.adapter?.version || '0.0.0';
  $$('#navigation button').forEach(button => {
    const module = button.dataset.view;
    const allowed = data.modules?.[module] === true;
    button.hidden = !allowed;
    button.classList.toggle('permission-hidden', !allowed);
    button.disabled = !allowed;
    button.setAttribute('aria-hidden', String(!allowed));
  });
  $('#addAlarm').hidden = !can('alarms', 'write');
  $('#dashboardEdit').hidden = !can('dashboard', 'write');
  $('#managePlantTree').hidden = !can('editor', 'write');
  $('#newUser').hidden = !can('users', 'write');
  const sources = data.adapter?.historySources || [];
  $('#trendSource').innerHTML = sources.length ? sources.map(source => `<option value="${escapeHtml(source.instance)}">${source.type === 'influxdb' ? 'InfluxDB' : 'History'} · ${escapeHtml(source.instance)}</option>`).join('') : '<option value="">Keine Zeitreihendatenbank konfiguriert</option>';
  $('#energySource').innerHTML = $('#trendSource').innerHTML;
  fillPageSelects();
  if (data.mustChangePassword) showChangePassword();
  resetAutoLogout();
  await showView(firstAllowedView(state.currentView));
  stateSearchSetup();
}

function firstAllowedView(preferred) {
  if (state.bootstrap?.modules?.[preferred]) return preferred;
  return ['dashboard', 'alarms', 'visualization', 'trends', 'energy', 'editor', 'iobroker', 'users', 'settings'].find(key => state.bootstrap?.modules?.[key]) || 'dashboard';
}

async function showView(name) {
  name = firstAllowedView(name);
  state.currentView = name;
  $('#tooltip').style.display = 'none';
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('#navigation button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  if (innerWidth < 900) toggleMenu(false);
  try {
    if (name === 'dashboard') { renderDashboard(); await refreshDashboard(); }
    if (name === 'alarms') await loadAlarms();
    if (name === 'visualization') await renderLivePage();
    if (name === 'editor') renderPlantTreeEditor();
    if (name === 'iobroker') renderIoBrokerAdmin();
    if (name === 'users') await loadUsers();
    if (name === 'energy') await loadReports();
  } catch (error) { toast(error.message, true); }
}

function toggleMenu(open = !document.body.classList.contains('menu-open')) {
  document.body.classList.toggle('menu-open', open);
  $('#menuToggle').setAttribute('aria-expanded', String(open));
  $('#sidebar').setAttribute('aria-hidden', String(!open));
}

function toggleSettingsPanel(button, panel, view, collapsedClass) {
  const collapsed = !panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed', collapsed);
  view.classList.toggle(collapsedClass, collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', collapsed ? 'Werkzeuge einblenden' : 'Werkzeuge ausblenden');
}

function resetAutoLogout() {
  clearTimeout(state.autoLogoutTimer);
  if (!state.user?.id || state.user.id === 'public') return;
  const minutes = Math.max(5, Number(state.bootstrap?.settings?.autoLogoffMinutes) || 30);
  if (Date.now() - state.lastKeepAlive > 60000) {
    state.lastKeepAlive = Date.now();
    api('/api/session/keepalive', { method: 'POST' }).catch(() => {});
  }
  state.autoLogoutTimer = setTimeout(async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* session may already have expired */ }
    state.csrf = '';
    await bootstrap();
    toast('Die Sitzung wurde wegen Inaktivität beendet');
  }, minutes * 60000);
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  state.csrf = '';
  closeModal();
  await bootstrap();
  toast('Abgemeldet');
}

function showAccountDialog() {
  if (!state.user?.id || state.user.id === 'public') return showLogin();
  modal('Benutzerkonto', `<div class="accountSummary"><span class="accountAvatar">${escapeHtml($('#headerUserAvatar').textContent)}</span><div><strong>${escapeHtml(state.user.displayName || state.user.username)}</strong><small>${escapeHtml(state.user.username)} · ${state.user.role === 'admin' ? 'Administrator' : 'Benutzer'}</small></div></div><p class="muted">Für einen Benutzerwechsel unten die neuen Zugangsdaten eintragen.</p><label>Benutzername<input id="loginUser" autocomplete="username"></label><label>Passwort<input id="loginPassword" type="password" autocomplete="current-password"></label>`, [
    { label: 'Abmelden', click: logout },
    { label: 'Benutzer wechseln', primary: true, click: loginFromDialog }
  ]);
}

async function loginFromDialog() {
  try {
    const result = await api('/api/login', { method: 'POST', body: { username: $('#loginUser').value, password: $('#loginPassword').value } });
    state.csrf = result.user.csrf;
    closeModal();
    await bootstrap();
    toast('Erfolgreich angemeldet');
  } catch (error) { toast(error.message, true); }
}

function showLogin() {
  modal('Anmelden', '<label>Benutzername<input id="loginUser" autocomplete="username" value="admin"></label><label>Passwort<input id="loginPassword" type="password" autocomplete="current-password"></label>', [
    { label: 'Abbrechen', click: closeModal },
    { label: 'Anmelden', primary: true, click: loginFromDialog }
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
  if ($('#editorPageSelect')) {
    $('#editorPageSelect').innerHTML = options;
    $('#editorPageSelect').value = String(Math.min(state.editorPage, state.pages.length - 1));
  }
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
      if (!state.trendSeries.some(series => series.id === widget.stateId)) state.trendSeries.push({ id: widget.stateId, name: widget.label || widget.stateId, unit: widget.unit || point?.unit || '', color: trendColor(state.trendSeries.length) });
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

const treeIconLabels = { folder: 'Ordner', building: 'Gebäude', floor: 'Etage', systems: 'Anlagengruppe', heating: 'Heizung', ventilation: 'Lüftung', cooling: 'Kälte', temperature: 'Temperatur', electric: 'Elektrozähler', water: 'Wasserzähler', heatmeter: 'Wärmemengenzähler', solar: 'PV-Anlage', room: 'Raum', meter: 'Messgerät' };

function treeIconSvg(icon) {
  const paths = {
    folder: '<path d="M3 6h6l2 2h10v10H3z"/>', building: '<path d="M5 21V4h14v17M8 8h2m4 0h2M8 12h2m4 0h2M8 16h2m4 0h2M3 21h18"/>',
    floor: '<path d="M3 19h18M5 15h14M7 11h10M9 7h6"/>', systems: '<circle cx="12" cy="5" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M12 7v5M6 16v-4h12v4"/>',
    heating: '<path d="M7 20c-3-4 3-5 0-9s3-5 1-8M13 20c-3-4 3-5 0-9s3-5 1-8M19 20c-3-4 3-5 0-9s3-5 1-8"/>', ventilation: '<circle cx="12" cy="12" r="2"/><path d="M12 10c-1-6 7-7 7-2 0 3-3 4-5 4M14 13c6 2 3 9-1 7-3-1-2-5-1-7M10 13c-4 5-10 0-7-4 2-3 6-1 8 1"/>',
    cooling: '<path d="M12 2v20M4 7l16 10M20 7 4 17M9 4l3 3 3-3M9 20l3-3 3 3"/>', temperature: '<path d="M10 14.8V5a2 2 0 0 1 4 0v9.8a4 4 0 1 1-4 0Z"/><path d="M12 17V9"/>', electric: '<path d="m13 2-7 12h6l-1 8 7-12h-6z"/>', water: '<path d="M12 2S6 10 6 15a6 6 0 0 0 12 0c0-5-6-13-6-13z"/>',
    heatmeter: '<path d="M6 21c-4-5 4-6 0-11S10 4 7 1M12 21c-4-5 4-6 0-11S16 4 13 1M18 21c-4-5 4-6 0-11S22 4 19 1"/>', solar: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>', room: '<path d="M4 21V3h16v18M9 21v-6h6v6"/>', meter: '<circle cx="12" cy="12" r="9"/><path d="m12 12 5-3M6 16h12"/>'
  };
  return `<svg class="treeIcon icon-${escapeHtml(icon)}" viewBox="0 0 24 24" aria-hidden="true">${paths[icon] || paths.systems}</svg>`;
}

function treeChildren(parentId) { return state.navigationTree.filter(node => String(node.parentId || '') === String(parentId || '')); }

function renderPlantTree() {
  const target = $('#plantTree');
  if (!state.navigationTree.length) { target.innerHTML = '<div class="empty">Noch kein Anlagenbaum eingerichtet.</div>'; return; }
  const seen = new Set();
  const branch = (parentId, depth) => treeChildren(parentId).map(node => {
    if (seen.has(node.id) || depth > 20) return '';
    seen.add(node.id);
    const children = treeChildren(node.id), expanded = state.expandedTreeIds.has(node.id), selected = state.selectedTreeId === node.id;
    return `<div class="treeBranch"><div class="plantTreeRow${selected ? ' selected' : ''}" style="--tree-depth:${depth}">${children.length ? `<button class="treeToggle" data-tree-toggle="${escapeHtml(node.id)}" aria-label="Ebene ${expanded ? 'schließen' : 'öffnen'}" aria-expanded="${expanded}"><span>${expanded ? '⌄' : '›'}</span></button>` : '<span class="treeToggleSpacer"></span>'}<button class="treeNodeButton" data-tree-node="${escapeHtml(node.id)}">${treeIconSvg(node.icon)}<span>${escapeHtml(node.label)}</span>${node.url ? '<i class="treeLinkMark" title="VIS-Ansicht">↗</i>' : ''}</button></div>${children.length && expanded ? `<div>${branch(node.id, depth + 1)}</div>` : ''}</div>`;
  }).join('');
  target.innerHTML = branch('', 0);
  target.querySelectorAll('[data-tree-toggle]').forEach(button => button.addEventListener('click', () => { const id = button.dataset.treeToggle; state.expandedTreeIds.has(id) ? state.expandedTreeIds.delete(id) : state.expandedTreeIds.add(id); renderPlantTree(); }));
  target.querySelectorAll('[data-tree-node]').forEach(button => button.addEventListener('click', () => selectTreeNode(button.dataset.treeNode)));
}

function safeVisUrl(value) {
  const url = String(value || '').trim();
  if (!url || /^(https?:\/\/|\/|\.\/)/i.test(url)) return url;
  if (/^www\.[^\s]+$/i.test(url)) return `https://${url}`;
  const ipMatch = url.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[/?#].*)?$/);
  if (ipMatch && ipMatch[1].split('.').every(part => Number(part) >= 0 && Number(part) <= 255)) return `http://${url}`;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i.test(url)) return `https://${url}`;
  return '';
}

function resolvedVisUrl(value) {
  const url=safeVisUrl(value), base=safeVisUrl(state.bootstrap?.adapter?.visBaseUrl || '');
  if(!url)return '';
  if((url.startsWith('/')||url.startsWith('./'))&&base){try{return new URL(url,base.endsWith('/')?base:`${base}/`).href;}catch{return url;}}
  return url;
}

function blocksEmbeddingByPolicy(url) {
  try {
    const host = new URL(url, location.href).hostname.toLowerCase();
    return /(^|\.)google\.[a-z.]+$/.test(host);
  } catch { return false; }
}

function renderIoBrokerAdmin() {
  const configured = safeVisUrl(state.bootstrap?.settings?.ioBrokerAdminUrl || '');
  const fallbackProtocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const url = configured || `${fallbackProtocol}//${location.hostname}:8081/`;
  const frame = $('#ioBrokerFrame'), external = $('#openIoBrokerExternal');
  if (frame.getAttribute('src') !== url) frame.src = url;
  external.href = url;
}

async function selectTreeNode(id) {
  const node = state.navigationTree.find(item => item.id === id);
  if (!node) return;
  const children = treeChildren(node.id);
  if (children.length && !node.url) state.expandedTreeIds.has(id) ? state.expandedTreeIds.delete(id) : state.expandedTreeIds.add(id);
  state.selectedTreeId = id;
  renderPlantTree();
  $('#visFrameTitle').textContent = node.label;
  const url = resolvedVisUrl(node.url), frame = $('#visFrame'), internal = $('#internalVisual'), empty = $('#visFrameEmpty'), external = $('#openVisExternal');
  frame.hidden = !url;
  internal.hidden = true;
  empty.hidden = true;
  external.hidden = !url;
  if (url) {
    if (frame.getAttribute('src') !== url) frame.src = url;
    external.href = url;
  } else {
    frame.removeAttribute('src');
  }
}

async function renderLivePage() {
  renderPlantTree();
  let selected = state.navigationTree.find(node => node.id === state.selectedTreeId);
  if (!selected) selected = state.navigationTree.find(node => node.url) || state.navigationTree[0];
  if (selected) await selectTreeNode(selected.id);
  else $('#visFrameEmpty').hidden = true;
}

function treeDescendants(id, result = new Set()) {
  treeChildren(id).forEach(child => { if (!result.has(child.id)) { result.add(child.id); treeDescendants(child.id, result); } });
  return result;
}

function renderPlantTreeEditor() {
  const target = $('#treeEditorList');
  if (!target) return;
  if (!state.navigationTree.length) { target.innerHTML = '<div class="empty">Noch keine Ebene oder Ansicht angelegt.</div>'; return; }
  const depthOf = node => {
    let depth = 0, parent = node.parentId, guard = new Set([node.id]);
    while (parent && depth < 20 && !guard.has(parent)) { guard.add(parent); depth += 1; parent = state.navigationTree.find(item => item.id === parent)?.parentId || ''; }
    return depth;
  };
  target.innerHTML = `<div class="treeRootDrop" data-tree-drop-root><strong>Oberste Ebene</strong><small>Hier ablegen, um eine Ansicht aus einer Unterebene herauszuziehen.</small></div>${state.navigationTree.map(node => `<button type="button" draggable="true" class="treeEditorRow" data-edit-tree-node="${escapeHtml(node.id)}" data-tree-drop-target="${escapeHtml(node.id)}"><span class="treeDragHandle" aria-hidden="true">⠿</span><span class="treeEditorIdentity" style="--tree-depth:${depthOf(node)}">${treeIconSvg(node.icon)}<span><strong>${escapeHtml(node.label)}</strong><small>${node.url ? 'Verknüpfte VIS-Ansicht' : 'Aufklappbare Strukturebene'}</small></span></span><code>${escapeHtml(node.url || '—')}</code><span class="treeEditorAction">Bearbeiten</span></button>`).join('')}`;
  target.querySelectorAll('[data-edit-tree-node]').forEach(button => button.addEventListener('click', () => { if (!state.treeDragActive) showTreeNodeDialog(button.dataset.editTreeNode); }));
  target.querySelectorAll('[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', event => { state.treeDragActive = true; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.dataset.editTreeNode); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); target.querySelectorAll('.dragOver,.dropBefore,.dropInside,.dropAfter').forEach(item => item.classList.remove('dragOver','dropBefore','dropInside','dropAfter')); setTimeout(() => { state.treeDragActive = false; }, 0); });
  });
  target.querySelectorAll('[data-tree-drop-root],[data-tree-drop-target]').forEach(zone => {
    const dropMode = event => {
      if (zone.hasAttribute('data-tree-drop-root')) return 'root';
      const ratio = (event.clientY - zone.getBoundingClientRect().top) / Math.max(1, zone.getBoundingClientRect().height);
      return ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside';
    };
    zone.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; zone.classList.remove('dragOver','dropBefore','dropInside','dropAfter'); const mode = dropMode(event); zone.classList.add(mode === 'root' ? 'dragOver' : `drop${mode[0].toUpperCase()}${mode.slice(1)}`); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragOver','dropBefore','dropInside','dropAfter'));
    zone.addEventListener('drop', async event => {
      event.preventDefault(); const mode = dropMode(event); zone.classList.remove('dragOver','dropBefore','dropInside','dropAfter');
      const id = event.dataTransfer.getData('text/plain'), targetId = zone.dataset.treeDropTarget || '';
      if (!id || id === targetId) return toast('Eine Ebene kann nicht in sich selbst verschoben werden', true);
      const previous = structuredClone(state.navigationTree), moved = state.navigationTree.find(item => item.id === id);
      const targetNode = state.navigationTree.find(item => item.id === targetId);
      const parentId = mode === 'root' ? '' : mode === 'inside' ? targetId : (targetNode?.parentId || '');
      if (!moved || treeDescendants(id).has(parentId)) return toast('Eine Ebene kann nicht in eine eigene Unterebene verschoben werden', true);
      const reordered = state.navigationTree.filter(item => item.id !== id);
      let insertAt = mode === 'root' ? reordered.length : reordered.findIndex(item => item.id === targetId);
      if (insertAt < 0) insertAt = reordered.length;
      else if (mode === 'after' || mode === 'inside') insertAt += 1;
      reordered.splice(insertAt, 0, { ...moved, parentId });
      state.navigationTree = reordered;
      try {
        state.navigationTree = await api('/api/navigation-tree', { method: 'PUT', body: state.navigationTree });
        if (parentId) state.expandedTreeIds.add(parentId);
        await renderLivePage(); renderPlantTreeEditor(); toast(mode === 'inside' || mode === 'root' ? 'Ansicht in die neue Ebene verschoben' : 'Reihenfolge gespeichert');
      } catch (error) { state.navigationTree = previous; renderPlantTreeEditor(); toast(error.message, true); }
    });
  });
}

function showPlantTreeManager() {
  const rows = state.navigationTree.map(node => `<button type="button" class="treeManagerRow" data-edit-tree-node="${escapeHtml(node.id)}">${treeIconSvg(node.icon)}<span><strong>${escapeHtml(node.label)}</strong><small>${node.url ? escapeHtml(node.url) : 'Strukturebene'}</small></span><i>Bearbeiten</i></button>`).join('');
  modal('Anlagenbaum verwalten', `<p class="muted">Hierarchie, Beschriftung, HKL-Icon und Link zur ioBroker-VIS-Ansicht festlegen.</p><div class="treeManagerList">${rows || '<div class="empty">Noch keine Einträge vorhanden.</div>'}</div>`, [
    { label: 'Schließen', click: closeModal }, { label: 'Neue Ansicht', primary: true, click: () => showTreeNodeDialog() }
  ]);
  $$('[data-edit-tree-node]').forEach(button => button.addEventListener('click', () => showTreeNodeDialog(button.dataset.editTreeNode)));
}

function showTreeNodeDialog(nodeId = '') {
  const node = state.navigationTree.find(item => item.id === nodeId);
  const excluded = node ? treeDescendants(node.id) : new Set();
  if (node) excluded.add(node.id);
  const parents = state.navigationTree.filter(item => !excluded.has(item.id)).map(item => `<option value="${escapeHtml(item.id)}"${item.id === node?.parentId ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
  const selectedIcon = node?.icon || 'systems';
  const icons = Object.entries(treeIconLabels).map(([key, label]) => `<label class="treeIconChoice"><input type="radio" name="treeIcon" value="${key}"${key === selectedIcon ? ' checked' : ''}>${treeIconSvg(key)}<span>${escapeHtml(label)}</span></label>`).join('');
  const body = `<div class="treeNodeForm"><label>Beschriftung<input id="treeNodeLabel" maxlength="160" value="${escapeHtml(node?.label || '')}" placeholder="z. B. Lüftungsanlage AHU-01"></label><label>Übergeordnete Ebene<select id="treeNodeParent"><option value="">Oberste Ebene</option>${parents}</select></label><label>VIS-Link, Webadresse oder IP-Adresse<input id="treeNodeUrl" maxlength="2048" value="${escapeHtml(node?.url || '')}" placeholder="192.168.178.101:8082/vis-2/ oder www.beispiel.de"><small>http(s) wird bei Webadressen und IPs automatisch ergänzt. Leer lassen für eine reine Strukturebene.</small></label><fieldset><legend>Icon auswählen</legend><div class="treeIconGrid">${icons}</div></fieldset></div>`;
  const save = async () => {
    try {
      const label = $('#treeNodeLabel').value.trim();
      if (!label) return toast('Bitte eine Beschriftung eingeben', true);
      const entry = { id: node?.id || uid(), parentId: $('#treeNodeParent').value, label, url: $('#treeNodeUrl').value.trim(), icon: $('input[name="treeIcon"]:checked')?.value || 'systems' };
      state.navigationTree = node ? state.navigationTree.map(item => item.id === node.id ? entry : item) : [...state.navigationTree, entry];
      state.navigationTree = await api('/api/navigation-tree', { method: 'PUT', body: state.navigationTree });
      state.expandedTreeIds.add(entry.parentId); closeModal();
      if (state.selectedTreeId === entry.id) await selectTreeNode(entry.id); else renderPlantTree();
      renderPlantTreeEditor(); toast('Anlagenbaum gespeichert und in Visualisierung übernommen');
    } catch (error) { toast(error.message, true); }
  };
  const actions = [{ label: 'Zurück', click: showPlantTreeManager }];
  if (node) actions.push({ label: 'Eintrag löschen', click: async () => { if (!confirm(`„${node.label}“ wirklich löschen? Untergeordnete Einträge werden eine Ebene nach oben verschoben.`)) return; state.navigationTree = state.navigationTree.filter(item => item.id !== node.id).map(item => item.parentId === node.id ? { ...item, parentId: node.parentId || '' } : item); state.navigationTree = await api('/api/navigation-tree', { method: 'PUT', body: state.navigationTree }); if (state.selectedTreeId === node.id) state.selectedTreeId = ''; closeModal(); await renderLivePage(); renderPlantTreeEditor(); toast('Eintrag gelöscht und Visualisierung aktualisiert'); } });
  actions.push({ label: 'Speichern', primary: true, click: save });
  modal(node ? 'Ansicht bearbeiten' : 'Ansicht für Anlagenbaum erstellen', body, actions);
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
  node.innerHTML = `<label>Beschriftung<input id="inspectLabel" value="${escapeHtml(widget.label || '')}"></label>${!['heatingCurve','hx'].includes(widget.type) ? `<label>Datenpunkt<div class="objectInput"><input id="inspectState" readonly value="${escapeHtml(widget.stateId || '')}"><button id="pickInspectState" type="button" class="quiet">Objekte</button></div></label><label>Einheit<input id="inspectUnit" value="${escapeHtml(widget.unit || '')}"></label>` : ''}<label>Breite<input id="inspectWidth" type="number" min="80" max="900" value="${widget.width || (['heatingCurve','hx'].includes(widget.type) ? 320 : 120)}"></label><button id="deleteWidget">Element löschen</button>`;
  const update = () => {
    widget.label = $('#inspectLabel').value;
    if ($('#inspectState')) widget.stateId = $('#inspectState').value;
    if ($('#inspectUnit')) widget.unit = $('#inspectUnit').value;
    widget.width = Number($('#inspectWidth').value) || 120;
    renderEditor();
  };
  node.querySelectorAll('input').forEach(input => input.addEventListener('change', update));
  $('#pickInspectState')?.addEventListener('click', () => showObjectPicker({ title: 'ioBroker-Objektbaum · Anlagenbild', selected: widget.stateId ? [{ id: widget.stateId }] : [], onApply: rows => { widget.stateId = rows[0].id; widget.unit = rows[0].unit || widget.unit; renderEditor(); } }).catch(error => toast(error.message, true)));
  $('#deleteWidget').addEventListener('click', () => { page.widgets = page.widgets.filter(item => item.id !== widget.id); state.selectedWidget = null; renderEditor(); });
}

async function loadAlarms() {
  const alarms = await api('/api/alarms');
  $('#alarmList').classList.toggle('empty', !alarms.length);
  $('#alarmList').innerHTML = alarms.length ? alarms.map(item => `<div class="tableRow alarmRow" data-alarm-detail="${item.id}"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.stateId)}</small></div><span class="pill ${item.active ? item.severity : 'ok'}">${item.active ? (item.severity === 'alarm' ? 'STÖRUNG' : 'WARNUNG') : 'OK'}</span><span>${escapeHtml(item.currentValue ?? '—')}</span><small>${item.active && item.ts ? `seit ${formatDuration(item.ts)}` : (item.ts ? new Date(item.ts).toLocaleString('de-DE') : '—')}</small><button class="quiet" data-delete-alarm="${item.id}" ${can('alarms','write') ? '' : 'hidden'}>Entfernen</button></div>`).join('') : 'Noch keine Melderegeln eingerichtet.';
  const active = alarms.filter(item => item.active);
  $('#notificationBadge').textContent = String(active.length);
  $('#notificationBadge').hidden = !active.length;
  $('#notificationList').classList.toggle('empty', !active.length);
  $('#notificationList').innerHTML = active.length ? active.map(item => `<div class="notificationItem"><i class="notifyDot ${item.severity}"></i><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.stateId)} · ${escapeHtml(item.currentValue ?? '—')}</small></div><small>${item.ts ? new Date(item.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : 'jetzt'}</small></div>`).join('') : 'Keine aktiven Meldungen.';
  $$('[data-alarm-detail]').forEach(row => row.addEventListener('click', event => { if (!event.target.closest('[data-delete-alarm]')) showAlarmDetails(alarms.find(item => item.id === row.dataset.alarmDetail)); }));
  $$('[data-delete-alarm]').forEach(button => button.addEventListener('click', async event => { event.stopPropagation(); await api('/api/alarms', { method: 'PUT', body: alarms.filter(item => item.id !== button.dataset.deleteAlarm) }); await loadAlarms(); }));
}

function formatDuration(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 60000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} T ${Math.floor((minutes % 1440) / 60)} h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes} min`;
}

function showAlarmDetails(alarm) {
  if (!alarm) return;
  const sent = alarm.notificationSentAt ? `Ja · ${new Date(alarm.notificationSentAt).toLocaleString('de-DE')}` : 'Nein';
  const acknowledged = alarm.acknowledgedAt ? `${escapeHtml(alarm.acknowledgedBy || 'unbekannt')} · ${new Date(alarm.acknowledgedAt).toLocaleString('de-DE')}` : 'Noch nicht bestätigt';
  const body = `<div class="alarmDetailGrid"><div><span>Status</span><strong class="pill ${alarm.active ? alarm.severity : 'ok'}">${alarm.active ? (alarm.severity === 'alarm' ? 'STÖRUNG' : 'WARNUNG') : 'OK'}</strong></div><div><span>Aktueller Wert</span><strong>${escapeHtml(alarm.currentValue ?? '—')}</strong></div><div class="wide"><span>DP-Adresse</span><strong>${escapeHtml(alarm.stateId)}</strong></div><div class="wide"><span>Technischer Einbauort</span><strong>${escapeHtml(alarm.technicalLocation || 'Noch nicht hinterlegt')}</strong></div><div><span>Störung seit / Dauer</span><strong>${alarm.active && alarm.ts ? `${new Date(alarm.ts).toLocaleString('de-DE')} · ${formatDuration(alarm.ts)}` : 'Nicht aktiv'}</strong></div><div><span>Als Störmeldung versendet</span><strong>${sent}</strong></div><div><span>Versandweg</span><strong>${escapeHtml(alarm.notificationChannel || 'Kein Versand protokolliert')}</strong></div><div><span>Bearbeitet / bestätigt durch</span><strong>${acknowledged}</strong></div><label class="wide"><span>Bemerkung</span><textarea id="alarmNote" placeholder="Technische Feststellung oder Übergabehinweis …">${escapeHtml(alarm.note || '')}</textarea></label></div>`;
  const actions = [{ label: 'Schließen', click: closeModal }];
  if (can('alarms', 'write')) {
    actions.push({ label: 'Bemerkung speichern', click: async () => { await api(`/api/alarms/${encodeURIComponent(alarm.id)}`, { method: 'PATCH', body: { note: $('#alarmNote').value } }); closeModal(); await loadAlarms(); toast('Bemerkung gespeichert'); } });
    if (alarm.active) actions.push({ label: 'Meldung bestätigen', primary: true, click: async () => { await api(`/api/alarms/${encodeURIComponent(alarm.id)}`, { method: 'PATCH', body: { note: $('#alarmNote').value, acknowledge: true } }); closeModal(); await loadAlarms(); toast('Meldung bestätigt'); } });
  }
  modal(alarm.name, body, actions);
}

function showAddAlarm() {
  modal('Melderegel anlegen', '<label>Name<input id="alarmName" value="Störmeldung"></label><label>Datenpunkt / DP-Adresse<div class="objectInput"><input id="alarmState" readonly><button id="pickAlarmState" type="button" class="quiet">Objekte</button></div></label><label>Technischer Einbauort<input id="alarmLocation" placeholder="z. B. Gebäude A · UG · Schaltschrank MSR-01"></label><label>Prüfung<select id="alarmOperator"><option value="truthy">Wert ist wahr</option><option value="eq">Gleich</option><option value="ne">Ungleich</option><option value="gt">Größer</option><option value="lt">Kleiner</option></select></label><label>Grenzwert<input id="alarmValue"></label><label>Priorität<select id="alarmSeverity"><option value="alarm">Störung</option><option value="warning">Warnung</option></select></label>', [
    { label: 'Abbrechen', click: closeModal },
    { label: 'Anlegen', primary: true, click: async () => { try { const alarms = await api('/api/alarms'); alarms.push({ name: $('#alarmName').value, stateId: $('#alarmState').value, technicalLocation: $('#alarmLocation').value, operator: $('#alarmOperator').value, value: $('#alarmValue').value, severity: $('#alarmSeverity').value }); await api('/api/alarms', { method: 'PUT', body: alarms }); closeModal(); await loadAlarms(); toast('Melderegel gespeichert'); } catch (error) { toast(error.message, true); } } }
  ]);
  $('#pickAlarmState').addEventListener('click', () => showObjectPicker({ title: 'ioBroker-Objektbaum · Störmeldepunkt', selected: $('#alarmState').value ? [{ id: $('#alarmState').value }] : [], onApply: rows => { $('#alarmState').value = rows[0].id; } }).catch(error => toast(error.message, true)));
}

function chartSvg(values, type) {
  const clean = values.filter(item => Number.isFinite(Number(item.val))).map(item => ({ ts: Number(item.ts), val: Number(item.val) }));
  if (!clean.length) return '<div class="empty">Für diesen Zeitraum wurden keine numerischen Werte gefunden.</div>';
  const width = 1000, height = 350, pad = 40;
  const min = Math.min(...clean.map(item => item.val)), max = Math.max(...clean.map(item => item.val));
  const span = max - min || 1;
  const x = (item, index) => pad + (clean.length === 1 ? .5 : index / (clean.length - 1)) * (width - 2 * pad);
  const y = item => height - pad - (item.val - min) / span * (height - 2 * pad);
  const defs = '<defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1fd1a5" stop-opacity=".35"/><stop offset="1" stop-color="#1fd1a5" stop-opacity="0"/></linearGradient></defs>';
  const grid = [0,.25,.5,.75,1].map(value => `<line class="gridline" x1="${pad}" y1="${pad + value * (height - 2 * pad)}" x2="${width - pad}" y2="${pad + value * (height - 2 * pad)}"/>`).join('');
  if (type === 'bar') {
    const shown = clean.slice(-80), barWidth = (width - 2 * pad) / shown.length;
    return `<svg viewBox="0 0 ${width} ${height}">${grid}${shown.map((item, index) => `<rect class="bar chartPoint" data-index="${clean.length - shown.length + index}" x="${pad + index * barWidth}" y="${y(item)}" width="${Math.max(2, barWidth - 2)}" height="${height - pad - y(item)}"/>`).join('')}</svg>`;
  }
  if (type === 'pie') {
    const buckets = clean.slice(-12), sum = buckets.reduce((s, item) => s + Math.abs(item.val), 0) || 1; let angle = -Math.PI / 2;
    const paths = buckets.map((item, index) => { const next = angle + Math.abs(item.val) / sum * Math.PI * 2; const large = next - angle > Math.PI ? 1 : 0; const x1 = 500 + Math.cos(angle) * 140, y1 = 175 + Math.sin(angle) * 140, x2 = 500 + Math.cos(next) * 140, y2 = 175 + Math.sin(next) * 140; const d = `M500 175 L${x1} ${y1} A140 140 0 ${large} 1 ${x2} ${y2} Z`; angle = next; return `<path class="chartPoint" data-index="${clean.length - buckets.length + index}" d="${d}" fill="hsl(${index * 360 / buckets.length} 65% 55%)"/>`; }).join('');
    return `<svg viewBox="0 0 ${width} ${height}">${paths}</svg>`;
  }
  if (type === 'heat') {
    const shown = clean.slice(-168), cols = Math.min(24, shown.length), cell = Math.min(34, (width - 2 * pad) / cols);
    return `<svg viewBox="0 0 ${width} ${height}">${shown.map((item, index) => `<rect class="chartPoint" data-index="${clean.length - shown.length + index}" x="${pad + (index % cols) * cell}" y="${pad + Math.floor(index / cols) * cell}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="hsl(${165 - ((item.val - min) / span) * 165} 75% 50%)"/>`).join('')}</svg>`;
  }
  const points = clean.map((item, index) => `${x(item,index)},${y(item)}`).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}">${defs}${grid}<polygon class="trendArea" points="${pad},${height-pad} ${points} ${width-pad},${height-pad}"/><polyline class="trendLine" points="${points}"/><rect class="chartHover" x="${pad}" y="${pad}" width="${width-2*pad}" height="${height-2*pad}" fill="transparent"/></svg>`;
}

function bindChartTooltip(values) {
  const tooltip = $('#tooltip');
  const show = (item, event) => { tooltip.innerHTML = `<strong>${number(item.val, 4)}</strong><br>${new Date(item.ts).toLocaleString('de-DE')}`; tooltip.style.left = `${event.clientX + 12}px`; tooltip.style.top = `${event.clientY + 12}px`; tooltip.style.display = 'block'; };
  $$('.chartPoint').forEach(node => node.addEventListener('pointermove', event => show(values[Number(node.dataset.index)], event)));
  const hover = $('.chartHover');
  if (hover) hover.addEventListener('pointermove', event => { const rect = hover.getBoundingClientRect(); const index = Math.max(0, Math.min(values.length - 1, Math.round((event.clientX - rect.left) / rect.width * (values.length - 1)))); show(values[index], event); });
  $('#trendChart').addEventListener('pointerleave', () => tooltip.style.display = 'none');
}

function trendColor(index) {
  return trendPalette[index % trendPalette.length];
}

const trendPalette = ['#2f80ed','#56ccf2','#27ae60','#6fcf97','#f2994a','#f2c94c','#eb5757','#ff7a90','#9b51e0','#bb6bd9','#34495e','#7f8c8d','#00a8a8','#8d6e63','#c2185b','#5c6bc0'];

function multiTrendSvg(datasets, type, requestedMin, requestedMax, rangeStart = null, rangeEnd = null, requestedLineWidth = 2.5) {
  const width = 1000, height = 350, top = 18, bottom = 42;
  const lineWidth = Math.max(.5, Math.min(12, Number(requestedLineWidth) || 2.5));
  const all = datasets.flatMap(dataset => dataset.values);
  if (!all.length) return '<div class="empty">Für diese Auswahl wurden keine numerischen Werte gefunden.</div>';
  const start = rangeStart ?? new Date($('#trendStart').value).getTime(), end = rangeEnd ?? new Date($('#trendEnd').value).getTime();
  const units = [...new Set(datasets.map(dataset => dataset.unit || 'Wert'))];
  const leftAxisCount = Math.ceil(units.length / 2), rightAxisCount = Math.floor(units.length / 2);
  const left = 24 + leftAxisCount * 58, right = 24 + rightAxisCount * 58, plotHeight = height - top - bottom, timeSpan = Math.max(1, end - start);
  const x = timestamp => left + (timestamp - start) / timeSpan * (width - left - right);
  const scales = new Map(units.map((unit,index) => {
    const values = datasets.filter(dataset => (dataset.unit || 'Wert') === unit).flatMap(dataset => dataset.values.map(item => item.val));
    const useManual = units.length === 1;
    const min = useManual && requestedMin !== '' ? Number(requestedMin) : Math.min(...values);
    const max = useManual && requestedMax !== '' ? Number(requestedMax) : Math.max(...values);
    return [unit, { unit, index, min, max, span: Math.max(.0001, max - min), side: index % 2 ? 'right' : 'left', lane: Math.floor(index / 2) }];
  }));
  const y = (value, unit) => { const scale = scales.get(unit || 'Wert'); return height - bottom - (value - scale.min) / scale.span * plotHeight; };
  if (type === 'pie') {
    const totals = datasets.map(dataset => Math.abs(dataset.values.reduce((sum, item) => sum + Number(item.val || 0), 0) / Math.max(1, dataset.values.length)));
    const sum = totals.reduce((total, value) => total + value, 0) || 1;
    let angle = -Math.PI / 2;
    const paths = totals.map((value, index) => {
      const next = angle + value / sum * Math.PI * 2, large = next - angle > Math.PI ? 1 : 0;
      const x1 = 500 + Math.cos(angle) * 135, y1 = 175 + Math.sin(angle) * 135, x2 = 500 + Math.cos(next) * 135, y2 = 175 + Math.sin(next) * 135;
      const path = `<path d="M500 175L${x1} ${y1}A135 135 0 ${large} 1 ${x2} ${y2}Z" fill="${datasets[index].color}"><title>${escapeHtml(datasets[index].name)} · ${number(value, 3)} ${escapeHtml(datasets[index].unit || '')}</title></path>`;
      angle = next;
      return path;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Tortendiagramm">${paths}</svg>`;
  }
  if (type === 'heat') {
    const rowHeight = Math.min(44, plotHeight / Math.max(1,datasets.length)), cols = 48, cellWidth = (width-left-right) / cols;
    let cells = '';
    datasets.forEach((dataset,row) => {
      const values = dataset.values, min = Math.min(...values.map(item => item.val)), max = Math.max(...values.map(item => item.val)), span = Math.max(.0001,max-min);
      for (let col = 0; col < cols; col += 1) {
        const from = Math.floor(col * values.length / cols), to = Math.max(from + 1, Math.floor((col + 1) * values.length / cols));
        const bucket = values.slice(from,to), value = bucket.length ? bucket.reduce((sum,item) => sum + item.val,0) / bucket.length : min, intensity = .12 + .88 * ((value-min)/span);
        cells += `<rect class="heatCell" x="${left+col*cellWidth}" y="${top+row*rowHeight}" width="${Math.max(1,cellWidth)}" height="${Math.max(4,rowHeight-3)}" fill="${dataset.color}" fill-opacity="${intensity.toFixed(3)}"><title>${escapeHtml(dataset.name)} · ${number(value,3)} ${escapeHtml(dataset.unit || '')}</title></rect>`;
      }
      cells += `<text class="heatRowLabel" text-anchor="end" x="${left-8}" y="${top+row*rowHeight+rowHeight/2+4}">${escapeHtml(dataset.name)} [${escapeHtml(dataset.unit || '—')}]</text>`;
    });
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Heatmap mit ${datasets.length} Zeitreihen">${cells}<text class="chartLabel" x="${left}" y="342">${new Date(start).toLocaleString('de-DE')}</text><text class="chartLabel" text-anchor="end" x="${width-right}" y="342">${new Date(end).toLocaleString('de-DE')}</text></svg>`;
  }
  const grid = [0,.25,.5,.75,1].map(value => `<line class="gridline" x1="${left}" y1="${top + value * plotHeight}" x2="${width-right}" y2="${top + value * plotHeight}"/>`).join('');
  const axes = [...scales.values()].map(scale => {
    const axisX = scale.side === 'left' ? left - scale.lane * 58 : width - right + scale.lane * 58;
    const anchor = scale.side === 'left' ? 'end' : 'start', labelX = axisX + (scale.side === 'left' ? -7 : 7), titleX = axisX + (scale.side === 'left' ? -43 : 43), rotation = scale.side === 'left' ? -90 : 90;
    const ticks = [0,.25,.5,.75,1].map(value => `<text class="chartLabel" text-anchor="${anchor}" x="${labelX}" y="${top + value * plotHeight + 4}">${number(scale.max-value*scale.span,2)}</text>`).join('');
    return `<line class="axis" x1="${axisX}" y1="${top}" x2="${axisX}" y2="${height-bottom}"/>${ticks}<text class="axisUnit" text-anchor="middle" transform="rotate(${rotation} ${titleX} ${top+plotHeight/2})" x="${titleX}" y="${top+plotHeight/2}">${escapeHtml(scale.unit)}</text>`;
  }).join('');
  let marks = '';
  datasets.forEach((dataset, datasetIndex) => {
    const unit = dataset.unit || 'Wert';
    if (type === 'bar') {
      const shown = dataset.values.slice(-120), barWidth = Math.max(2,(width-left-right)/Math.max(1,shown.length)/Math.max(1,datasets.length));
      marks += shown.map(item => `<rect x="${x(item.ts)+datasetIndex*barWidth}" y="${y(item.val,unit)}" width="${barWidth}" height="${Math.max(0,height-bottom-y(item.val,unit))}" fill="${dataset.color}"/>`).join('');
    } else {
      const points = dataset.values.map(item => `${x(item.ts)},${y(item.val,unit)}`);
      const path = type === 'step' ? points.map((point,index) => index ? `${points[index-1].split(',')[0]},${point.split(',')[1]} ${point}` : point).join(' ') : points.join(' ');
      marks += `<polyline points="${path}" fill="none" stroke="${dataset.color}" stroke-width="${lineWidth}"/>`;
    }
  });
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${datasets.length} Zeitreihen mit Achsen für ${units.map(escapeHtml).join(', ')}">${grid}${axes}${marks}<text class="chartLabel" x="${left}" y="342">${new Date(start).toLocaleString('de-DE')}</text><text class="chartLabel" text-anchor="end" x="${width-right}" y="342">${new Date(end).toLocaleString('de-DE')}</text><rect class="multiChartHover" x="${left}" y="${top}" width="${width-left-right}" height="${plotHeight}" fill="transparent"/></svg>`;
}

function renderTrendLegend() {
  $('#trendLegend').innerHTML = state.trendSeries.map(series => `<div class="trendLegendItem" data-trend-info="${escapeHtml(series.id)}"><button class="trendColorButton" style="--trend-color:${escapeHtml(series.color)}" data-open-trend-colors="${escapeHtml(series.id)}" aria-label="Farbe für ${escapeHtml(series.name || series.id)} ändern"><i style="background-color:${escapeHtml(series.color)}"></i></button><strong>${escapeHtml(series.name || series.id)}</strong><button class="quiet" data-remove-trend="${escapeHtml(series.id)}">Entfernen</button></div>`).join('');
}

function openTrendColorPalette(seriesId, anchor) {
  const palette = $('#trendColorPalette'), rect = anchor.getBoundingClientRect();
  palette.dataset.seriesId = seriesId;
  palette.innerHTML = trendPalette.map(color => `<button type="button" style="--palette-color:${color};background:${color}!important;background-color:${color}!important" data-palette-color="${color}" aria-label="Farbe ${color}"></button>`).join('');
  palette.hidden = false;
  const paletteRect = palette.getBoundingClientRect();
  palette.style.left = `${Math.max(8, Math.min(innerWidth - paletteRect.width - 8, rect.left))}px`;
  const below = rect.bottom + 8, above = rect.top - paletteRect.height - 8;
  palette.style.top = `${below + paletteRect.height <= innerHeight - 8 ? below : Math.max(8, above)}px`;
}

function renderCurrentTrend() {
  $('#trendChart').innerHTML = multiTrendSvg(state.trendData, $('#trendType').value, $('#trendMin').value, $('#trendMax').value, null, null, $('#trendLineWidth').value);
  renderTrendLegend();
  $('#trendZoomBack').hidden = !state.trendZoomHistory.length;
  const hover = $('.multiChartHover'), tooltip = $('#tooltip');
  if (!hover) return;
  hover.addEventListener('pointermove', event => {
    const rect = hover.getBoundingClientRect(), ratio = Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)), start = new Date($('#trendStart').value).getTime(), end = new Date($('#trendEnd').value).getTime(), timestamp = start + ratio * (end-start);
    const nearest = state.trendData.map(dataset => ({ dataset, point: dataset.values.reduce((best,item) => !best || Math.abs(item.ts-timestamp)<Math.abs(best.ts-timestamp) ? item : best, null) })).filter(item => item.point);
    tooltip.innerHTML = `<strong>${new Date(timestamp).toLocaleString('de-DE')}</strong>${nearest.map(item => `<br><span style="color:${item.dataset.color}">●</span> ${escapeHtml(item.dataset.name)}: ${number(item.point.val,3)} ${escapeHtml(item.dataset.unit || '')}`).join('')}`;
    showTooltipAt(tooltip, event.clientX, event.clientY);
  });
  hover.addEventListener('pointerleave', () => tooltip.style.display = 'none');
  bindTrendNavigation();
}

function trendViewSnapshot() {
  return {
    start: $('#trendStart').value,
    end: $('#trendEnd').value,
    min: $('#trendMin').value,
    max: $('#trendMax').value,
    period: $('#trendPeriod').value
  };
}

function pushTrendZoom() {
  const snapshot = trendViewSnapshot();
  const latest = state.trendZoomHistory.at(-1);
  if (!latest || JSON.stringify(latest) !== JSON.stringify(snapshot)) state.trendZoomHistory.push(snapshot);
  if (state.trendZoomHistory.length > 30) state.trendZoomHistory.shift();
  $('#trendZoomBack').hidden = false;
}

async function restorePreviousTrendZoom() {
  const previous = state.trendZoomHistory.pop();
  if (!previous) return;
  const timeChanged = previous.start !== $('#trendStart').value || previous.end !== $('#trendEnd').value;
  $('#trendStart').value = previous.start;
  $('#trendEnd').value = previous.end;
  $('#trendMin').value = previous.min;
  $('#trendMax').value = previous.max;
  $('#trendPeriod').value = previous.period;
  $('#trendZoomBack').hidden = !state.trendZoomHistory.length;
  if (timeChanged) await loadTrend();
  else renderCurrentTrend();
}

function bindTrendNavigation() {
  const chart = $('#trendChart');
  chart.onwheel = event => {
    if (!state.trendData.length) return;
    event.preventDefault();
    const values = state.trendData.flatMap(dataset => dataset.values.map(point => point.val));
    let min = $('#trendMin').value === '' ? Math.min(...values) : Number($('#trendMin').value);
    let max = $('#trendMax').value === '' ? Math.max(...values) : Number($('#trendMax').value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return;
    if (Date.now() - state.trendWheelSession > 450) pushTrendZoom();
    state.trendWheelSession = Date.now();
    const factor = event.deltaY < 0 ? .82 : 1.22;
    const center = min + (1 - Math.max(0, Math.min(1, event.offsetY / Math.max(1, chart.clientHeight)))) * (max - min);
    min = center - (center - min) * factor;
    max = center + (max - center) * factor;
    $('#trendMin').value = String(Number(min.toPrecision(8)));
    $('#trendMax').value = String(Number(max.toPrecision(8)));
    renderCurrentTrend();
  };
  chart.ondblclick = () => {
    pushTrendZoom();
    $('#trendMin').value = '';
    $('#trendMax').value = '';
    renderCurrentTrend();
  };
  chart.onpointerdown = event => {
    if (event.button !== 0 || !state.trendData.length) return;
    const rect = chart.getBoundingClientRect();
    const startX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const selection = document.createElement('div');
    selection.className = 'trendSelection';
    selection.style.left = `${startX}px`;
    selection.style.width = '0px';
    chart.append(selection);
    const move = moveEvent => {
      const x = Math.max(0, Math.min(rect.width, moveEvent.clientX - rect.left));
      selection.style.left = `${Math.min(startX, x)}px`;
      selection.style.width = `${Math.abs(x - startX)}px`;
    };
    const up = upEvent => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      const endX = Math.max(0, Math.min(rect.width, upEvent.clientX - rect.left));
      const distance = Math.abs(endX - startX);
      selection.remove();
      if (distance < 24) return;
      const oldStart = new Date($('#trendStart').value).getTime();
      const oldEnd = new Date($('#trendEnd').value).getTime();
      const leftRatio = Math.min(startX, endX) / rect.width;
      const rightRatio = Math.max(startX, endX) / rect.width;
      pushTrendZoom();
      $('#trendStart').value = dateTimeValue(oldStart + leftRatio * (oldEnd - oldStart));
      $('#trendEnd').value = dateTimeValue(oldStart + rightRatio * (oldEnd - oldStart));
      $('#trendPeriod').value = 'custom';
      loadTrend();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
}

function parseCsvRow(line, delimiter) {
  const values = [];
  let value = '', quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(value.trim());
      value = '';
    } else value += char;
  }
  values.push(value.trim());
  return values;
}

function parseCsvTimestamp(value) {
  const raw = String(value || '').trim();
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length === 10 ? numeric * 1000 : numeric;
  }
  const german = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (german) return new Date(Number(german[3]), Number(german[2]) - 1, Number(german[1]), Number(german[4] || 0), Number(german[5] || 0), Number(german[6] || 0)).getTime();
  return Date.parse(raw);
}

async function importTrendCsv(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) throw new Error('Die CSV-Datei darf maximal 15 MB groß sein');
  const text = (await file.text()).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('Die CSV-Datei enthält keine Datenzeilen');
  const candidates = [';', '\t', ','];
  const delimiter = candidates.sort((a, b) => parseCsvRow(lines[0], b).length - parseCsvRow(lines[0], a).length)[0];
  const headers = parseCsvRow(lines[0], delimiter);
  if (headers.length < 2) throw new Error('Erwartet werden eine Zeitspalte und mindestens eine Wertespalte');
  const columns = headers.slice(1).map((header, index) => {
    const match = String(header || `CSV ${index + 1}`).match(/^(.*?)(?:\s*[\[(]([^\]\)]+)[\]\)])?$/);
    return { name: (match?.[1] || `CSV ${index + 1}`).trim(), unit: (match?.[2] || '').trim(), values: [] };
  });
  for (const line of lines.slice(1)) {
    const cells = parseCsvRow(line, delimiter);
    const ts = parseCsvTimestamp(cells[0]);
    if (!Number.isFinite(ts)) continue;
    columns.forEach((column, index) => {
      const raw = String(cells[index + 1] || '').trim();
      const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
      const val = Number(normalized);
      if (Number.isFinite(val)) column.values.push({ ts, val });
    });
  }
  const imported = columns.filter(column => column.values.length).map((column, index) => ({
    id: `csv:${file.name}:${index}:${uid()}`,
    name: column.name,
    unit: column.unit,
    color: trendColor(state.trendSeries.length + index),
    sourceType: 'csv',
    sourceName: file.name,
    csvValues: column.values.sort((a, b) => a.ts - b.ts)
  }));
  if (!imported.length) throw new Error('In der CSV-Datei wurden keine gültigen Zahlen mit Zeitstempel gefunden');
  state.trendSeries.push(...imported);
  const timestamps = imported.flatMap(series => series.csvValues.map(point => point.ts));
  $('#trendStart').value = dateTimeValue(Math.min(...timestamps));
  $('#trendEnd').value = dateTimeValue(Math.max(...timestamps));
  $('#trendPeriod').value = 'custom';
  state.trendZoomHistory = [];
  await loadTrend();
  toast(`${imported.length} CSV-Zeitreihe${imported.length === 1 ? '' : 'n'} importiert`);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportTrendCsv() {
  if (!state.trendData.length) return toast('Keine Trendwerte zum Exportieren', true);
  const rows = [['Zeitstempel', 'ISO-Zeit', 'Datenpunkt', 'Klartextname', 'Wert', 'Einheit', 'Quelle']];
  state.trendData.forEach(dataset => dataset.values.forEach(point => rows.push([
    point.ts,
    new Date(point.ts).toISOString(),
    dataset.id,
    dataset.name || dataset.id,
    String(point.val).replace('.', ','),
    dataset.unit || '',
    dataset.sourceType === 'csv' ? dataset.sourceName || 'CSV' : $('#trendSource').value
  ])));
  const content = `\uFEFF${rows.map(row => row.map(csvCell).join(';')).join('\r\n')}`;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  const name = (state.bootstrap?.settings?.siteName || 'IOT-GLT').replace(/[^a-z0-9_-]+/gi, '-');
  link.href = url;
  link.download = `${new Date().toISOString().slice(0, 10)}-Trend-${name}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function loadTrend() {
  try {
    if (!state.trendSeries.length) throw new Error('Bitte mindestens einen Datenpunkt hinzufügen');
    const source = $('#trendSource').value;
    if (!source && state.trendSeries.some(series => series.sourceType !== 'csv')) throw new Error('Keine History- oder InfluxDB-Instanz konfiguriert');
    const start = new Date($('#trendStart').value).getTime(), end = new Date($('#trendEnd').value).getTime();
    const resolution = Number($('#trendResolution').value) || 0;
    const results = await Promise.all(state.trendSeries.map(series => series.sourceType === 'csv'
      ? Promise.resolve({ values: series.csvValues.filter(point => point.ts >= start && point.ts <= end) })
      : api(`/api/history?id=${encodeURIComponent(series.id)}&source=${encodeURIComponent(source)}&start=${start}&end=${end}&resolution=${resolution}&count=${resolution ? 5000 : 10000}`)));
    state.trendData = results.map((result,index) => ({ ...state.trendSeries[index], values: result.values.filter(item => Number.isFinite(Number(item.val))).map(item => ({ ts: Number(item.ts), val: Number(item.val) })) }));
    renderCurrentTrend();
  } catch (error) { toast(error.message, true); }
}

async function showTrendStatePicker() {
  await showObjectPicker({
    title: 'ioBroker-Objektbaum · Trenddatenpunkte',
    numericOnly: true,
    multiple: true,
    selected: state.trendSeries.filter(series => series.sourceType !== 'csv'),
    onApply: rows => {
      const csvSeries = state.trendSeries.filter(series => series.sourceType === 'csv');
      state.trendSeries = [...rows.map((row, index) => ({ ...row, color: state.trendSeries.find(item => item.id === row.id)?.color || trendColor(index) })), ...csvSeries];
      renderTrendLegend();
      if (state.trendSeries.length) loadTrend();
    }
  });
}

const dashboardDefaults = [
  { id:'power', title:'Elektrische Leistung', dp:'modbus.0.energy.main.power_kw', unit:'kW', type:'gauge', period:12, min:0, max:55, cols:3, rows:3, value:15.1 },
  { id:'load', title:'Lastgang', dp:'influxdb.0.power.total', unit:'kW', type:'line', period:12, min:0, max:80, cols:6, rows:3, value:66.2 },
  { id:'points', title:'Anlagenstatus', dp:'iot-glt.0.status.activePoints', unit:'DP', type:'value', period:1, min:0, max:200, cols:3, rows:3, value:136 },
  { id:'heat', title:'Wärmeerzeugung', dp:'modbus.0.heating.total_kw', unit:'kW', type:'fill', period:24, min:0, max:700, cols:3, rows:3, value:480 },
  { id:'status', title:'Statusliste', dp:'iot-glt.0.status.*', unit:'', type:'table', period:1, min:0, max:100, cols:6, rows:3, value:62 },
  { id:'distribution', title:'Energieverteilung', dp:'influxdb.0.energy.*', unit:'kWh', type:'bar', period:24, min:0, max:100, cols:3, rows:3, value:74 }
];

function dashboardConfig() {
  if (state.dashboardWidgets.length) return state.dashboardWidgets;
  state.dashboardWidgets = structuredClone(dashboardDefaults);
  return state.dashboardWidgets;
}

function saveDashboardConfig() {
  const payload=state.dashboardWidgets.map(({ values, value, dp, ...widget })=>({ ...widget, stateId: widget.stateId || dp }));
  api('/api/dashboard',{method:'PUT',body:payload}).then(saved=>{state.dashboardWidgets=saved.map(widget=>({...widget,dp:widget.stateId}));}).catch(error=>toast(error.message,true));
}

function dashboardValues(widget) { if(Array.isArray(widget.values)&&widget.values.length)return widget.values; const span=Math.max(1,widget.max-widget.min),center=widget.min+span*.52; return Array.from({length:24},(_,index)=>Math.max(widget.min,Math.min(widget.max,center+Math.sin(index/3+widget.id.length)*span*.24+Math.cos(index/5)*span*.09))); }

function dashboardVisual(widget) {
  const values=dashboardValues(widget), min=Number(widget.min), max=Number(widget.max), span=Math.max(.001,max-min), latest=Number(widget.value ?? values.at(-1)), y=value=>110-(value-min)/span*92, x=index=>10+index/Math.max(1,values.length-1)*280;
  if (widget.type === 'line') return `<svg class="dashboardSvg" viewBox="0 0 300 125" role="img"><title>${escapeHtml(widget.title)}</title>${[20,50,80,110].map(py=>`<line class="chartGrid" x1="10" y1="${py}" x2="290" y2="${py}"/>`).join('')}<polyline class="dashboardLine" points="${values.map((value,index)=>`${x(index)},${y(value)}`).join(' ')}"/><text class="chartLabel" x="10" y="122">−${widget.period} h</text><text class="chartLabel" x="260" y="122">jetzt</text></svg>`;
  if (widget.type === 'bar') return `<svg class="dashboardSvg" viewBox="0 0 300 125" role="img"><title>${escapeHtml(widget.title)}</title>${values.slice(-10).map((value,index)=>{const height=(value-min)/span*94;return`<rect class="dashboardBar" x="${12+index*28}" y="${110-height}" width="19" height="${height}" rx="2"><title>${number(value)} ${escapeHtml(widget.unit)}</title></rect>`}).join('')}</svg>`;
  if (widget.type === 'heat') return `<div class="dashboardHeat" role="img" aria-label="${escapeHtml(widget.title)} als Heatmap">${Array.from({length:72},(_,index)=>`<i style="--heat:${(.15+.85*(values[index%values.length]-min)/span).toFixed(2)}" title="${number(values[index%values.length])} ${escapeHtml(widget.unit)}"></i>`).join('')}</div>`;
  if (widget.type === 'fill') return `<div class="dashboardFill"><div class="dashboardTank"><div class="dashboardLevel" style="--level:${Math.max(0,Math.min(100,(latest-min)/span*100))}%"></div><div class="dashboardLevelLabel">${number(latest)} ${escapeHtml(widget.unit)}</div></div></div>`;
  if (widget.type === 'table') return `<table class="dashboardTable"><tbody><tr><td>Datenpunkt</td><td>${escapeHtml(widget.dp)}</td></tr><tr><td>Aktuell</td><td>${number(latest)} ${escapeHtml(widget.unit)}</td></tr><tr><td>Zeitraum</td><td>${widget.period} Stunden</td></tr><tr><td>Skalierung</td><td>${number(min)} bis ${number(max)}</td></tr></tbody></table>`;
  if (widget.type === 'gauge') { const ratio=Math.max(0,Math.min(1,(latest-min)/span)); return `<svg class="dashboardSvg" viewBox="0 0 220 150" role="img"><title>${escapeHtml(widget.title)}</title><path class="gaugeTrack" d="M35 125A80 80 0 1 1 185 125"/><path class="gaugeValue" pathLength="100" stroke-dasharray="${(ratio*100).toFixed(1)} 100" d="M35 125A80 80 0 1 1 185 125"/><text x="110" y="92" text-anchor="middle" font-size="27">${number(latest)}</text><text x="110" y="114" text-anchor="middle" font-size="12">${escapeHtml(widget.unit)}</text></svg>`; }
  return `<div class="dashboardValue">${number(latest)} ${escapeHtml(widget.unit)}</div>`;
}

function renderDashboard() {
  const grid=$('#dashboardGrid'), widgets=dashboardConfig();
  grid.classList.toggle('editing',state.dashboardEdit);
  grid.innerHTML=widgets.map(widget=>`<article class="panel dashboardTile" draggable="${state.dashboardEdit}" data-dashboard-id="${escapeHtml(widget.id)}" style="--tile-cols:${widget.cols};--tile-rows:${widget.rows}"><div class="panelHead"><div><h2>${escapeHtml(widget.title)}</h2><small>${escapeHtml(widget.dp)} · ${widget.period} h</small></div><div class="dashboardTools"><button data-dashboard-config="${escapeHtml(widget.id)}" aria-label="Konfigurieren">⚙</button><button data-dashboard-delete="${escapeHtml(widget.id)}" aria-label="Löschen">×</button></div></div><div class="dashboardBody">${dashboardVisual(widget)}</div><button class="dashboardResize" data-dashboard-resize="${escapeHtml(widget.id)}" aria-label="Größe ändern"></button></article>`).join('');
  bindDashboardLayout();
}

function showDashboardDialog(id=null) {
  state.dashboardActiveId=id;
  const widget=dashboardConfig().find(item=>item.id===id) || { title:'Neuer Datenpunkt',dp:'',unit:'',type:'line',period:24,min:0,max:100,cols:4,rows:3,value:50 };
  modal(id?'Kachel bearbeiten':'Datenpunkt hinzufügen',`<div class="dashboardForm"><label class="wide">Beschriftung<input id="dashboardTitle" value="${escapeHtml(widget.title)}"></label><label class="wide">ioBroker-Datenpunkt<div class="objectInput"><input id="dashboardDp" readonly value="${escapeHtml(widget.dp)}" placeholder="Datenpunkt im Objektbaum auswählen"><button id="pickDashboardDp" type="button" class="quiet">Objekte</button></div></label><label>Darstellung<select id="dashboardType"><option value="line">Chart · Linie</option><option value="bar">Balkendiagramm</option><option value="heat">Heatmap</option><option value="fill">Füllstand</option><option value="gauge">Messinstrument</option><option value="table">Tabelle</option><option value="value">Einzelwert</option></select></label><label>Einheit<input id="dashboardUnit" value="${escapeHtml(widget.unit)}"></label><label>Zeitraum in Stunden<input id="dashboardPeriod" type="number" min="1" max="8760" value="${widget.period}"></label><label>Aktueller Wert<input id="dashboardValue" type="number" step="any" value="${widget.value}"></label><label>Skalierung min<input id="dashboardMin" type="number" step="any" value="${widget.min}"></label><label>Skalierung max<input id="dashboardMax" type="number" step="any" value="${widget.max}"></label><label>Breite<input id="dashboardCols" type="number" min="2" max="12" value="${widget.cols}"></label><label>Höhe<input id="dashboardRows" type="number" min="2" max="8" value="${widget.rows}"></label></div>`,[{label:'Abbrechen',click:closeModal},{label:'Speichern',primary:true,click:saveDashboardWidget}]);
  $('#dashboardType').value=widget.type;
  $('#pickDashboardDp').addEventListener('click', () => showObjectPicker({ title: 'ioBroker-Objektbaum · Dashboard', selected: $('#dashboardDp').value ? [{ id: $('#dashboardDp').value }] : [], onApply: rows => { $('#dashboardDp').value = rows[0].id; $('#dashboardTitle').value = rows[0].name || $('#dashboardTitle').value; $('#dashboardUnit').value = rows[0].unit || $('#dashboardUnit').value; } }).catch(error => toast(error.message, true)));
}

function saveDashboardWidget() {
  const title=$('#dashboardTitle').value.trim(), dp=$('#dashboardDp').value.trim();
  if (!title || !dp) return toast('Beschriftung und Datenpunkt sind erforderlich',true);
  const widget={id:state.dashboardActiveId||uid(),title,dp,unit:$('#dashboardUnit').value.trim(),type:$('#dashboardType').value,period:Math.max(1,Number($('#dashboardPeriod').value)||24),value:Number($('#dashboardValue').value)||0,min:Number($('#dashboardMin').value),max:Number($('#dashboardMax').value),cols:Math.max(2,Math.min(12,Number($('#dashboardCols').value)||4)),rows:Math.max(2,Math.min(8,Number($('#dashboardRows').value)||3))};
  state.dashboardWidgets=state.dashboardActiveId?state.dashboardWidgets.map(item=>item.id===state.dashboardActiveId?widget:item):[...state.dashboardWidgets,widget]; saveDashboardConfig(); closeModal(); renderDashboard(); toast('Dashboard-Kachel gespeichert');
}

function bindDashboardLayout() {
  const grid=$('#dashboardGrid');
  $$('[data-dashboard-config]').forEach(button=>button.addEventListener('click',()=>showDashboardDialog(button.dataset.dashboardConfig)));
  $$('[data-dashboard-delete]').forEach(button=>button.addEventListener('click',()=>{state.dashboardWidgets=state.dashboardWidgets.filter(item=>item.id!==button.dataset.dashboardDelete);saveDashboardConfig();renderDashboard();}));
  $$('.dashboardTile').forEach(tile=>{tile.addEventListener('dragstart',event=>{if(!state.dashboardEdit)return event.preventDefault();event.dataTransfer.setData('text/plain',tile.dataset.dashboardId);tile.classList.add('dragging')});tile.addEventListener('dragend',()=>tile.classList.remove('dragging'));tile.addEventListener('dragover',event=>{if(state.dashboardEdit){event.preventDefault();tile.classList.add('dragOver')}});tile.addEventListener('dragleave',()=>tile.classList.remove('dragOver'));tile.addEventListener('drop',event=>{event.preventDefault();const source=event.dataTransfer.getData('text/plain'),target=tile.dataset.dashboardId;tile.classList.remove('dragOver');if(!source||source===target)return;const from=state.dashboardWidgets.findIndex(item=>item.id===source),to=state.dashboardWidgets.findIndex(item=>item.id===target),[moved]=state.dashboardWidgets.splice(from,1);state.dashboardWidgets.splice(to,0,moved);saveDashboardConfig();renderDashboard();})});
  $$('[data-dashboard-resize]').forEach(handle=>handle.addEventListener('pointerdown',event=>{if(!state.dashboardEdit)return;event.preventDefault();event.stopPropagation();const widget=state.dashboardWidgets.find(item=>item.id===handle.dataset.dashboardResize),tile=handle.closest('.dashboardTile'),rect=grid.getBoundingClientRect(),startX=event.clientX,startY=event.clientY,startCols=widget.cols,startRows=widget.rows,cellWidth=(rect.width-132)/12;const move=e=>{widget.cols=Math.max(2,Math.min(12,Math.round(startCols+(e.clientX-startX)/(cellWidth+12))));widget.rows=Math.max(2,Math.min(8,Math.round(startRows+(e.clientY-startY)/82)));tile.style.setProperty('--tile-cols',widget.cols);tile.style.setProperty('--tile-rows',widget.rows)};const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);saveDashboardConfig();};document.addEventListener('pointermove',move);document.addEventListener('pointerup',up)}));
}

async function refreshDashboard() {
  const widgets=dashboardConfig(), ids=widgets.map(widget=>widget.dp).filter(dp=>dp&&!dp.includes('*'));
  try {
    const rows=ids.length?await api(`/api/visual-values?ids=${encodeURIComponent(ids.join(','))}`):[], values=new Map(rows.map(row=>[row.id,row.val])), source=state.bootstrap?.adapter?.historySources?.[0]?.instance, end=Date.now();
    widgets.forEach(widget=>{if(Number.isFinite(Number(values.get(widget.dp))))widget.value=Number(values.get(widget.dp));});
    if(source){await Promise.all(widgets.filter(widget=>ids.includes(widget.dp)&&['line','bar','heat','table'].includes(widget.type)).map(async widget=>{const start=end-Math.max(1,Number(widget.period)||24)*3600000,response=await api(`/api/history?id=${encodeURIComponent(widget.dp)}&source=${encodeURIComponent(source)}&start=${start}&end=${end}&aggregate=average&count=240`);widget.values=(response.values||[]).map(item=>Number(item.val)).filter(Number.isFinite);}));}
    renderDashboard();
  } catch(error) { toast(error.message,true); }
}

function pdfText(value) {
  return String(value ?? '').replace(/ß/g,'ss').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'-').replace(/([\\()])/g,'\\$1');
}

function pdfRgb(hex) {
  const value = String(hex || '#000000').replace('#','');
  return [0,2,4].map(index => (parseInt(value.slice(index,index+2),16)/255).toFixed(3));
}

function buildPdf(streamInput) {
  const streams = Array.isArray(streamInput) ? streamInput : [streamInput];
  const pageIds = streams.map((_,index) => 3+index), fontId = 3+streams.length, contentIds = streams.map((_,index) => fontId+1+index);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${streams.length} >>`,
    ...streams.map((_,index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  ];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object,index) => { offsets.push(pdf.length); pdf += `${index+1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}

function exportTrendPdf() {
  if (!state.trendData.length || !state.trendData.some(dataset => dataset.values.length)) return toast('Zuerst Trenddaten laden',true);
  const start = new Date($('#trendStart').value).getTime(), end = new Date($('#trendEnd').value).getTime(), timeSpan = Math.max(1,end-start), left = 78, right = 764, bottom = 116, top = 500, x = timestamp => left + (timestamp-start)/timeSpan*(right-left);
  const units = [...new Set(state.trendData.map(dataset => dataset.unit || 'Wert'))];
  const scales = new Map(units.map(unit => { const values = state.trendData.filter(dataset => (dataset.unit || 'Wert') === unit).flatMap(dataset => dataset.values.map(item => item.val)), min = units.length === 1 && $('#trendMin').value !== '' ? Number($('#trendMin').value) : Math.min(...values), max = units.length === 1 && $('#trendMax').value !== '' ? Number($('#trendMax').value) : Math.max(...values); return [unit,{min,max,span:Math.max(.0001,max-min)}]; }));
  const y = (value,unit) => { const scale=scales.get(unit || 'Wert'); return bottom+(value-scale.min)/scale.span*(top-bottom); };
  const siteName = state.bootstrap?.settings?.siteName || 'IOT GLT', now = new Date(), dateCode = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  let stream = `BT /F1 18 Tf 54 552 Td (${pdfText(`Trendkurven - ${siteName}`)}) Tj ET\nBT /F1 9 Tf 54 532 Td (${pdfText(`${new Date(start).toLocaleString('de-DE')} bis ${new Date(end).toLocaleString('de-DE')} | ${$('#trendSource').value} | ${$('#trendResolution').selectedOptions[0].textContent}`)}) Tj ET\n0.75 G 0.6 w ${left} ${bottom} m ${right} ${bottom} l ${right} ${top} l ${left} ${top} l h S\n`;
  [0,.25,.5,.75,1].forEach(position => { const py = bottom+position*(top-bottom); stream += `0.88 G 0.3 w ${left} ${py.toFixed(2)} m ${right} ${py.toFixed(2)} l S\n`; });
  units.forEach((unit,index) => { const scale=scales.get(unit), axisX=index%2?right:left, textX=index%2?right+7:12; stream += `0 G BT /F1 8 Tf ${index%2?right-24:12} 512 Td (${pdfText(unit)}) Tj ET\n`; [0,.25,.5,.75,1].forEach(position=>{const py=bottom+position*(top-bottom),value=scale.min+position*scale.span;stream+=`BT /F1 7 Tf ${textX} ${py-3} Td (${pdfText(number(value,2))}) Tj ET\n`;}); if(index>1) stream+=`BT /F1 7 Tf 350 ${512-index*10} Td (${pdfText(`Achse ${index+1}: ${unit}`)}) Tj ET\n`; });
  const type = $('#trendType').value;
  if (type === 'heat') {
    const cols=60,rowHeight=Math.min(34,(top-bottom)/state.trendData.length);
    state.trendData.forEach((dataset,row)=>{const values=dataset.values,min=Math.min(...values.map(item=>item.val)),max=Math.max(...values.map(item=>item.val)),span=Math.max(.0001,max-min),base=pdfRgb(dataset.color).map(Number),cellWidth=(right-left)/cols;for(let col=0;col<cols;col+=1){const from=Math.floor(col*values.length/cols),to=Math.max(from+1,Math.floor((col+1)*values.length/cols)),bucket=values.slice(from,to),value=bucket.reduce((sum,item)=>sum+item.val,0)/Math.max(1,bucket.length),ratio=.15+.85*((value-min)/span),color=base.map(channel=>(1-(1-channel)*ratio).toFixed(3));stream+=`${color.join(' ')} rg ${(left+col*cellWidth).toFixed(2)} ${(top-(row+1)*rowHeight).toFixed(2)} ${cellWidth.toFixed(2)} ${(rowHeight-1).toFixed(2)} re f\n`;}stream+=`0 G BT /F1 7 Tf 12 ${(top-row*rowHeight-rowHeight/2-3).toFixed(2)} Td (${pdfText(`${dataset.name} [${dataset.unit||'-'}]`)}) Tj ET\n`;});
  } else {
    state.trendData.forEach(dataset => { const [r,g,b] = pdfRgb(dataset.color), values = dataset.values.filter((_,index) => index % Math.max(1,Math.ceil(dataset.values.length/350)) === 0 || index === dataset.values.length-1); if (!values.length) return; stream += `${r} ${g} ${b} RG 1.5 w ${x(values[0].ts).toFixed(2)} ${y(values[0].val,dataset.unit).toFixed(2)} m `; values.slice(1).forEach(item => { stream += `${x(item.ts).toFixed(2)} ${y(item.val,dataset.unit).toFixed(2)} l `; }); stream += 'S\n'; });
  }
  state.trendData.forEach((dataset,index) => { const [r,g,b] = pdfRgb(dataset.color), px = 54+(index%3)*250, py = 88-Math.floor(index/3)*18; stream += `${r} ${g} ${b} RG 3 w ${px} ${py} m ${px+18} ${py} l S\n0 G BT /F1 9 Tf ${px+24} ${py-3} Td (${pdfText(`${dataset.name || dataset.id} [${dataset.unit || '-'}]`)}) Tj ET\n`; });
  stream += `0 G BT /F1 8 Tf 54 28 Td (${pdfText(`Erstellt: ${new Date().toLocaleString('de-DE')}`)}) Tj ET`;
  const details = state.trendData.map(dataset => { const values=dataset.values.map(item=>item.val), latest=dataset.values.at(-1); return `${dataset.name || dataset.id} | ${dataset.id} | ${dataset.unit || '-'} | Min ${number(Math.min(...values),3)} | Max ${number(Math.max(...values),3)} | Letzt ${latest ? number(latest.val,3) : '-'}`; });
  const detailStreams = [];
  for (let offset=0; offset<details.length; offset+=22) {
    const rows=details.slice(offset,offset+22);
    let page=`BT /F1 16 Tf 54 552 Td (${pdfText(`Datenpunkte ${offset+1}-${offset+rows.length} von ${details.length}`)}) Tj ET\n`;
    rows.forEach((row,index)=>{page+=`BT /F1 8 Tf 54 ${522-index*21} Td (${pdfText(row)}) Tj ET\n`;});
    detailStreams.push(page);
  }
  const url = URL.createObjectURL(buildPdf([stream,...detailStreams])), link = document.createElement('a'), safeName = siteName.replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'') || 'IOT-GLT';
  link.href = url; link.download = `${dateCode}-Chart-${safeName}.pdf`; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),10000); toast(`PDF heruntergeladen: ${link.download}`);
}

async function showEnergyStatePicker() {
  await showObjectPicker({
    title: 'ioBroker-Objektbaum · Energiedatenpunkte',
    numericOnly: true,
    multiple: true,
    selected: state.energySeries,
    onApply: rows => {
      state.energySeries = rows.map((row, index) => ({ ...row, color: state.energySeries.find(item => item.id === row.id)?.color || trendColor(index) }));
      if (!$('#energyState').value && state.energySeries[0]) $('#energyState').value = state.energySeries[0].id;
      renderEnergyHistory();
    }
  });
}

function renderEnergyHistory() {
  const start = new Date(`${$('#energyStart').value}T00:00:00`).getTime(), end = new Date(`${$('#energyEnd').value}T23:59:59`).getTime();
  $('#energyHistoryChart').innerHTML = multiTrendSvg(state.energyData, 'line', '', '', start, end);
  $('#energyLegend').innerHTML = state.energySeries.map(series => `<div class="trendLegendItem"><i style="display:block;width:22px;height:5px;border-radius:3px;background:${escapeHtml(series.color)}"></i><strong>${escapeHtml(series.name || series.id)}</strong><small>${escapeHtml(series.unit || '')}</small><button class="quiet" data-remove-energy="${escapeHtml(series.id)}">Entfernen</button></div>`).join('');
  $$('[data-remove-energy]').forEach(button => button.addEventListener('click', () => {
    state.energySeries = state.energySeries.filter(item => item.id !== button.dataset.removeEnergy);
    state.energyData = state.energyData.filter(item => item.id !== button.dataset.removeEnergy);
    renderEnergyHistory();
  }));
}

async function loadEnergyHistory() {
  try {
    if (!state.energySeries.length) throw new Error('Bitte zuerst Energiedatenpunkte hinzufügen');
    const source = $('#energySource').value;
    if (!source) throw new Error('Keine History- oder InfluxDB-Instanz konfiguriert');
    const start = new Date(`${$('#energyStart').value}T00:00:00`).getTime();
    const end = new Date(`${$('#energyEnd').value}T23:59:59`).getTime();
    const results = await Promise.all(state.energySeries.map(series => api(`/api/history?id=${encodeURIComponent(series.id)}&source=${encodeURIComponent(source)}&start=${start}&end=${end}&resolution=300&count=5000`)));
    state.energyData = results.map((result, index) => ({ ...state.energySeries[index], values: (result.values || []).filter(item => Number.isFinite(Number(item.val))).map(item => ({ ts: Number(item.ts), val: Number(item.val) })) }));
    renderEnergyHistory();
  } catch (error) { toast(error.message, true); }
}

async function loadReports() {
  state.reports = await api('/api/reports');
  const currency = state.bootstrap.adapter.currency;
  $('#reportCards').innerHTML = state.reports.length ? state.reports.map(report => `<article class="reportCard panel"><p class="eyebrow">${new Date(report.createdAt).toLocaleDateString('de-DE')}</p><h2>${escapeHtml(report.name)}</h2><small class="muted">${escapeHtml(report.stateId)}</small><div class="reportMetrics"><div><strong>${number(report.consumptionKwh)} kWh</strong><small>Verbrauch</small></div><div><strong>${number(report.cost)} ${escapeHtml(currency)}</strong><small>Kosten</small></div><div><strong>${number(report.co2Kg)} kg</strong><small>CO₂</small></div></div><footer><button class="quiet" data-send-report="${report.id}" ${can('energy','write') ? '' : 'hidden'}>Per E-Mail senden</button></footer></article>`).join('') : '<div class="empty panel">Noch keine Berichte gespeichert.</div>';
  $$('[data-send-report]').forEach(button => button.addEventListener('click', () => showSendReport(button.dataset.sendReport)));
}

async function createReport() {
  try {
    const start = new Date($('#energyStart').value).getTime();
    const end = new Date(`${$('#energyEnd').value}T23:59:59`).getTime();
    await api('/api/reports', { method: 'POST', body: { name: $('#reportName').value, stateId: $('#energyState').value, source: $('#energySource').value, mode: $('#energyMode').value, pricePerKwh: Number($('#energyPrice').value), co2Factor: Number($('#energyCo2').value), start, end } });
    toast('Energiebericht gespeichert');
    await loadReports();
  } catch (error) { toast(error.message, true); }
}

function showSendReport(id) {
  modal('Bericht versenden', '<label>Empfängeradresse<input id="reportEmail" type="email" placeholder="technik@example.org"></label>', [{ label: 'Abbrechen', click: closeModal }, { label: 'Senden', primary: true, click: async () => { try { await api(`/api/reports/${id}/send`, { method: 'POST', body: { to: $('#reportEmail').value } }); closeModal(); toast('Bericht wurde versendet'); } catch (error) { toast(error.message, true); } } }]);
}

function userActivity(timestamp, empty = 'Noch nie') {
  if (!timestamp) return empty;
  const delta = Math.max(0, Date.now() - Number(timestamp));
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'Gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
}

function renderUsers() {
  const query = state.userSearch.trim().toLowerCase(), { key, direction } = state.userSort;
  const rows = state.users.filter(user => !query || [user.displayName, user.username, user.jobTitle, user.role, user.department, user.email, user.phone].some(value => String(value || '').toLowerCase().includes(query)));
  rows.sort((a, b) => {
    if (a.role === 'admin' && b.role !== 'admin') return -1;
    if (b.role === 'admin' && a.role !== 'admin') return 1;
    const av = key === 'status' ? (a.locked ? 2 : a.mustChangePassword ? 1 : 0) : a[key];
    const bv = key === 'status' ? (b.locked ? 2 : b.mustChangePassword ? 1 : 0) : b[key];
    return String(av ?? '').localeCompare(String(bv ?? ''), 'de', { numeric: true }) * direction;
  });
  $('#userList').innerHTML = rows.length ? rows.map(user => `<tr data-user-row="${escapeHtml(user.id)}"><td><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.username)}</small></td><td><strong>${escapeHtml(user.jobTitle || (user.role === 'admin' ? 'Administrator' : 'Beobachter'))}</strong><small>${user.role === 'admin' ? 'Administrator' : 'Benutzer'}</small></td><td><strong>${escapeHtml(user.department || 'Kein Bereich')}</strong><small>${escapeHtml(user.email || user.phone || 'Keine Kontaktdaten')}</small></td><td><strong>${userActivity(user.lastLoginAt)}</strong><small>${user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('de-DE') : `${Number(user.loginCount) || 0} Anmeldungen`}</small></td><td><strong>${userActivity(user.lastSeenAt)}</strong><small>${user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString('de-DE') : 'Keine Aktivität'}</small></td><td><span class="pill ${user.locked ? 'alarm' : user.mustChangePassword ? 'warning' : 'ok'}">${user.locked ? 'Gesperrt' : user.mustChangePassword ? 'Passwortwechsel' : 'Aktiv'}</span></td><td><div class="personActions"><button class="quiet" data-edit-user="${escapeHtml(user.id)}">Bearbeiten</button><button class="quiet" data-copy-user="${escapeHtml(user.id)}">Kopieren</button>${user.id !== 'admin' ? `<button class="quiet" data-delete-user="${escapeHtml(user.id)}">Löschen</button>` : ''}</div></td></tr>`).join('') : '<tr><td colspan="7" class="empty">Keine passenden Benutzer gefunden.</td></tr>';
  $$('[data-user-row]').forEach(row => row.addEventListener('click', event => { if (!event.target.closest('button')) showUserDialog(state.users.find(user => user.id === row.dataset.userRow)); }));
  $$('[data-edit-user]').forEach(button => button.addEventListener('click', () => showUserDialog(state.users.find(user => user.id === button.dataset.editUser))));
  $$('[data-copy-user]').forEach(button => button.addEventListener('click', () => showUserDialog(state.users.find(user => user.id === button.dataset.copyUser), { copy: true })));
  $$('[data-delete-user]').forEach(button => button.addEventListener('click', async () => { if (confirm('User wirklich löschen?')) { await api(`/api/users/${button.dataset.deleteUser}`, { method: 'DELETE' }); await loadUsers(); } }));
  $$('[data-user-sort]').forEach(header => {
    header.querySelector('.userSortMark')?.remove();
    if (header.dataset.userSort === key) header.insertAdjacentHTML('beforeend', `<span class="userSortMark">${direction > 0 ? '▲' : '▼'}</span>`);
  });
}

async function loadUsers() {
  state.users = await api('/api/users');
  renderUsers();
}

function showUserDialog(user = null, options = {}) {
  const copying = Boolean(options.copy && user);
  const editing = Boolean(user && !copying);
  const person = user ? structuredClone(user) : {};
  if (copying) { person.displayName = `${person.displayName || person.username} (Kopie)`; person.username = `${person.username}.kopie`; }
  const modules = ['dashboard','alarms','visualization','trends','energy','editor'];
  const permissions = person.permissions || Object.fromEntries(modules.map(module => [module, { read: ['dashboard','alarms','visualization','trends','energy'].includes(module), write: false }]));
  const allowedNavigation = Array.isArray(person.allowedNavigationIds) ? new Set(person.allowedNavigationIds) : new Set(state.navigationTree.map(node => node.id));
  const plantPermissions = `<div class="wide"><strong>Sichtbare Anlagenbilder und Ebenen</strong><p class="muted">Nicht ausgewählte Einträge werden für diesen Benutzer vollständig aus dem Anlagenbaum ausgeblendet.</p><div class="plantPermissionList">${state.navigationTree.map(node => `<label style="padding-left:${8 + Math.max(0, (() => { let depth = 0, parent = node.parentId; while (parent && depth < 12) { depth += 1; parent = state.navigationTree.find(item => item.id === parent)?.parentId || ''; } return depth; })()) * 12}px"><input type="checkbox" data-plant-permission value="${escapeHtml(node.id)}" ${allowedNavigation.has(node.id) ? 'checked' : ''}>${treeIconSvg(node.icon)}<span>${escapeHtml(node.label)}</span></label>`).join('')}</div></div>`;
  const body = `<div class="personForm"><label>Personenname<input id="displayName" value="${escapeHtml(person.displayName || '')}"></label><label>Benutzername<input id="userName" value="${escapeHtml(person.username || '')}" ${editing ? 'disabled' : ''}></label><label>Funktion / Rolle<input id="jobTitle" value="${escapeHtml(person.jobTitle || (person.role === 'admin' ? 'Administrator' : 'Beobachter'))}"></label><label>Zugriffsebene<select id="userRole"><option value="viewer">Benutzer</option><option value="admin" ${person.role === 'admin' ? 'selected' : ''}>Administrator</option></select></label><label>Bereich / Abteilung<input id="userDepartment" value="${escapeHtml(person.department || '')}"></label><label>E-Mail<input id="userEmail" type="email" value="${escapeHtml(person.email || '')}"></label><label>Telefon<input id="userPhone" type="tel" value="${escapeHtml(person.phone || '')}"></label><label>${editing ? 'Temporäres neues Passwort (leer = unverändert)' : 'Temporäres Passwort (mindestens 10 Zeichen)'}<div class="passwordResetField"><input id="userPassword" type="password" autocomplete="new-password"><button id="toggleUserPassword" type="button" class="quiet">Anzeigen</button></div><small>Das bestehende Passwort ist durch den sicheren Hash nicht auslesbar. Hier kann ein temporäres neues Passwort gesetzt werden.</small></label><label class="wide checkLabel"><input id="forcePasswordChange" type="checkbox" ${!editing || person.mustChangePassword ? 'checked' : ''}> Bei der nächsten Anmeldung ein neues Passwort verlangen</label>${person.locked ? `<div class="accountLocked wide"><strong>Konto nach ${Number(person.failedLoginAttempts) || 7} Fehlversuchen gesperrt</strong><span>${person.lockedAt ? new Date(person.lockedAt).toLocaleString('de-DE') : ''}</span></div>` : ''}<label class="wide">Zusatzinformationen<textarea id="userNotes">${escapeHtml(person.notes || '')}</textarea></label>${plantPermissions}<div class="permissionGrid wide"><strong>Modul</strong><strong>Lesen</strong><strong>Schreiben</strong>${modules.map(module => `<span>${module}</span><input type="checkbox" data-perm="${module}" data-action="read" ${permissions[module]?.read ? 'checked' : ''}><input type="checkbox" data-perm="${module}" data-action="write" ${permissions[module]?.write ? 'checked' : ''}>`).join('')}</div><p class="muted wide">„User & Rechte“ und „Einstellungen“ sind ausschließlich für Administratoren verfügbar.</p></div>`;
  const save = async (unlock = false) => { try { const updatedPermissions = {}; $$('[data-perm]').forEach(input => { updatedPermissions[input.dataset.perm] ||= {}; updatedPermissions[input.dataset.perm][input.dataset.action] = input.checked; }); const allowedNavigationIds = $$('[data-plant-permission]:checked').map(input => input.value); await api('/api/users', { method: 'PUT', body: { id: editing ? user.id : undefined, username: $('#userName').value, displayName: $('#displayName').value, password: $('#userPassword').value, forcePasswordChange: $('#forcePasswordChange').checked, unlock, role: $('#userRole').value, jobTitle: $('#jobTitle').value, department: $('#userDepartment').value, email: $('#userEmail').value, phone: $('#userPhone').value, notes: $('#userNotes').value, permissions: updatedPermissions, allowedNavigationIds } }); closeModal(); await loadUsers(); toast(unlock ? 'Benutzerkonto entsperrt' : copying ? 'Person kopiert und gespeichert' : 'Person gespeichert'); } catch (error) { toast(error.message, true); } };
  const actions = [{ label: 'Abbrechen', click: closeModal }];
  if (editing) actions.push({ label: 'Person kopieren', click: () => showUserDialog(user, { copy: true }) });
  if (editing && person.locked) actions.push({ label: 'Konto entsperren', click: () => save(true) });
  actions.push({ label: copying ? 'Kopie speichern' : 'Speichern', primary: true, click: () => save(false) });
  modal(copying ? 'Person kopieren' : editing ? 'Person bearbeiten' : 'Person anlegen', body, actions);
  $('#toggleUserPassword').addEventListener('click', event => {
    const input = $('#userPassword'), reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    event.currentTarget.textContent = reveal ? 'Verbergen' : 'Anzeigen';
  });
  $$('[data-perm][data-action="write"]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) $(`[data-perm="${input.dataset.perm}"][data-action="read"]`).checked = true;
  }));
  $$('[data-perm][data-action="read"]').forEach(input => input.addEventListener('change', () => {
    if (!input.checked) $(`[data-perm="${input.dataset.perm}"][data-action="write"]`).checked = false;
  }));
}

function addWidget(type) {
  const page = state.pages[state.editorPage];
  if (!page) return;
  const curve = ['heatingCurve','hx'].includes(type);
  const widget = { id: uid(), type, label: type === 'analog' ? 'Messwert' : type === 'digital' ? 'Status' : type === 'hx' ? 'h,x-Diagramm' : 'Heizkurve', stateId: '', x: 80 + page.widgets.length * 12, y: 80 + page.widgets.length * 12, width: curve ? 320 : 140, unit: '', decimals: 2 };
  if (curve) widget.points = type === 'hx' ? [{ x: .08, y: .18 }, { x: .3, y: .35 }, { x: .55, y: .58 }, { x: .78, y: .75 }, { x: .92, y: .86 }] : [{ x: .08, y: .2 }, { x: .35, y: .38 }, { x: .65, y: .64 }, { x: .92, y: .82 }];
  page.widgets.push(widget);
  state.selectedWidget = widget.id;
  renderEditor();
}

function newPage() {
  const name = prompt('Name des neuen Anlagenbildes:', `Anlagenbild ${state.pages.length + 1}`);
  if (!name) return;
  state.pages.push({ id: uid(), name, width: 1600, height: 900, background: '', widgets: [] });
  state.editorPage = state.pages.length - 1;
  fillPageSelects();
  $('#editorPageSelect').value = String(state.editorPage);
  renderEditor();
}

async function savePages() {
  try { state.pages = await api('/api/pages', { method: 'PUT', body: state.pages }); fillPageSelects(); toast('Anlagenbilder gespeichert'); } catch (error) { toast(error.message, true); }
}

function uploadBackground(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('Das Bild darf maximal 8 MB groß sein', true);
  const reader = new FileReader();
  reader.onload = () => { state.pages[state.editorPage].background = reader.result; renderEditor(); };
  reader.readAsDataURL(file);
}

function stateSearchSetup() {
  let timer;
  document.addEventListener('input', event => {
    const input = event.target.closest?.('input[list="stateOptions"]');
    if (!input) return;
    clearTimeout(timer);
    if (input.value.length < 2) return;
    timer = setTimeout(async () => { try { const rows = await api(`/api/states?query=${encodeURIComponent(input.value)}`); $('#stateOptions').innerHTML = rows.slice(0, 80).map(row => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join(''); } catch { /* silently keep current options */ } }, 350);
  });
}

function setDefaultDates() {
  const now = Date.now(), day = 86400000;
  $('#trendEnd').value = dateTimeValue(now);
  $('#trendStart').value = dateTimeValue(now - day);
  $('#energyEnd').value = new Date().toISOString().slice(0, 10);
  $('#energyStart').value = new Date(now - 30 * day).toISOString().slice(0, 10);
}

$('#menuToggle').addEventListener('click', () => toggleMenu());
$('#notificationButton').addEventListener('click', () => {
  const open = $('#notificationTray').classList.toggle('open');
  $('#notificationButton').setAttribute('aria-expanded', String(open));
});
$('#closeNotifications').addEventListener('click', () => {
  $('#notificationTray').classList.remove('open');
  $('#notificationButton').setAttribute('aria-expanded', 'false');
});
$('#navigation').addEventListener('click', event => { const button = event.target.closest('button[data-view]'); if (button) showView(button.dataset.view); });
$('#loginButton').addEventListener('click', showAccountDialog);
$('#refreshAlarms').addEventListener('click', loadAlarms);
$('#addAlarm').addEventListener('click', showAddAlarm);
$('#loadTrend').addEventListener('click', loadTrend);
$('#addTrendStates').addEventListener('click', () => showTrendStatePicker().catch(error => toast(error.message,true)));
$('#trendType').addEventListener('change', renderCurrentTrend);
$('#trendLineWidth').addEventListener('input', renderCurrentTrend);
$('#trendResolution').addEventListener('change', () => state.trendSeries.length && loadTrend());
$('#trendMin').addEventListener('input', renderCurrentTrend);
$('#trendMax').addEventListener('input', renderCurrentTrend);
$('#trendSource').addEventListener('change', () => state.trendSeries.length && loadTrend());
$('#trendPeriod').addEventListener('change', event => { if (event.target.value === 'custom') return; const end = Date.now(); $('#trendEnd').value = dateTimeValue(end); $('#trendStart').value = dateTimeValue(end-Number(event.target.value)*3600000); if (state.trendSeries.length) loadTrend(); });
$('#trendLegend').addEventListener('click', event => { const colorButton = event.target.closest('[data-open-trend-colors]'); if (colorButton) return openTrendColorPalette(colorButton.dataset.openTrendColors,colorButton); const button = event.target.closest('[data-remove-trend]'); if (!button) return; state.trendSeries = state.trendSeries.filter(item => item.id !== button.dataset.removeTrend); state.trendData = state.trendData.filter(item => item.id !== button.dataset.removeTrend); renderCurrentTrend(); });
$('#trendLegend').addEventListener('pointermove', event => { const item = event.target.closest('[data-trend-info]'); if (!item) return; const series = state.trendSeries.find(entry => entry.id === item.dataset.trendInfo), dataset = state.trendData.find(entry => entry.id === item.dataset.trendInfo), latest = dataset?.values?.at(-1); if (!series) return; const tooltip = $('#tooltip'); tooltip.innerHTML = `<strong>${escapeHtml(series.name || series.id)}</strong><br>DP-Adresse: ${escapeHtml(series.id)}<br>Einheit: ${escapeHtml(series.unit || '—')}<br>Quelle: ${escapeHtml(series.sourceType === 'csv' ? series.sourceName || 'CSV' : $('#trendSource').value || '—')}<br>Auflösung: ${escapeHtml(series.sourceType === 'csv' ? 'CSV-Import' : $('#trendResolution').selectedOptions[0].textContent)}${latest ? `<br>Letzter Wert: ${number(latest.val,4)} ${escapeHtml(series.unit || '')}<br>${new Date(latest.ts).toLocaleString('de-DE')}` : ''}`; showTooltipAt(tooltip, event.clientX, event.clientY); });
$('#trendLegend').addEventListener('pointerleave', () => $('#tooltip').style.display = 'none');
$('#trendColorPalette').addEventListener('click', event => { const button = event.target.closest('[data-palette-color]'); if (!button) return; const id = $('#trendColorPalette').dataset.seriesId, color = button.dataset.paletteColor, series = state.trendSeries.find(item => item.id === id); if (series) series.color = color; state.trendData = state.trendData.map(dataset => dataset.id === id ? { ...dataset, color } : dataset); $('#trendColorPalette').hidden = true; renderCurrentTrend(); });
$('#exportTrendPdf').addEventListener('click', exportTrendPdf);
$('#exportTrendCsv').addEventListener('click', exportTrendCsv);
$('#importTrendCsv').addEventListener('click', () => $('#trendCsvInput').click());
$('#trendCsvInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  importTrendCsv(file).catch(error => toast(error.message, true)).finally(() => { event.target.value = ''; });
});
$('#trendZoomBack').addEventListener('click', () => restorePreviousTrendZoom().catch(error => toast(error.message, true)));
$('#dashboardEdit').addEventListener('click', event => { state.dashboardEdit=!state.dashboardEdit; event.currentTarget.textContent=state.dashboardEdit?'Bearbeitung beenden':'Bearbeiten'; event.currentTarget.setAttribute('aria-pressed',String(state.dashboardEdit)); $('#dashboardAdd').hidden=!state.dashboardEdit; renderDashboard(); });
$('#dashboardAdd').addEventListener('click', () => showDashboardDialog());
$('#dashboardRefresh').addEventListener('click', refreshDashboard);
$('#createReport').addEventListener('click', createReport);
$('#addEnergyStates').addEventListener('click', () => showEnergyStatePicker().catch(error => toast(error.message, true)));
$('#loadEnergyHistory').addEventListener('click', loadEnergyHistory);
$('#pickEnergyState').addEventListener('click', () => showObjectPicker({ title: 'ioBroker-Objektbaum · Verbrauchsdatenpunkt', numericOnly: true, selected: $('#energyState').value ? [{ id: $('#energyState').value }] : [], onApply: rows => { $('#energyState').value = rows[0].id; } }).catch(error => toast(error.message, true)));
$('#newUser').addEventListener('click', () => showUserDialog());
$('#settingsFont').addEventListener('change', event => applyFont(event.target.value));
$('#settingsTheme').addEventListener('change', event => applyTheme(event.target.value));
$('#saveUiSettings').addEventListener('click', async () => { try { const rawAdminUrl = $('#settingsIoBrokerUrl').value.trim(), ioBrokerAdminUrl = rawAdminUrl ? safeVisUrl(rawAdminUrl) : ''; if (rawAdminUrl && !ioBrokerAdminUrl) throw new Error('Bitte eine gültige ioBroker-Adresse eingeben'); const settings = await api('/api/settings', { method: 'PUT', body: { siteName: $('#settingsSiteName').value, fontFamily: $('#settingsFont').value, theme: $('#settingsTheme').value, autoLogoffMinutes: Number($('#settingsAutoLogoff').value), ioBrokerAdminUrl } }); state.bootstrap.settings = settings; $('#settingsIoBrokerUrl').value = settings.ioBrokerAdminUrl || ''; $('#headerSiteName').textContent = settings.siteName; applyFont(settings.fontFamily); applyTheme(settings.theme); resetAutoLogout(); toast('Oberflächeneinstellungen gespeichert'); } catch (error) { toast(error.message,true); } });
$('#managePlantTree').addEventListener('click', () => showTreeNodeDialog());
$('#togglePlantTree').addEventListener('click', event => { const layout = $('.visualizationLayout'), collapsed = !layout.classList.contains('tree-collapsed'); layout.classList.toggle('tree-collapsed', collapsed); event.currentTarget.setAttribute('aria-expanded', String(!collapsed)); event.currentTarget.setAttribute('aria-label', collapsed ? 'Anlagenbaum einblenden' : 'Anlagenbaum ausblenden'); });
$('#toggleTrendSettings').addEventListener('click', event => toggleSettingsPanel(event.currentTarget, $('#trendControls'), $('#view-trends'), 'settings-collapsed'));
$('#toggleEnergySettings').addEventListener('click', event => toggleSettingsPanel(event.currentTarget, $('#energyControls'), $('#view-energy'), 'energy-settings-collapsed'));
$('#userSearch').addEventListener('input', event => { state.userSearch = event.target.value; renderUsers(); });
$$('[data-user-sort]').forEach(header => header.addEventListener('click', () => { const key = header.dataset.userSort; state.userSort = { key, direction: state.userSort.key === key ? -state.userSort.direction : 1 }; renderUsers(); }));
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) closeModal(); });
['pointerdown','keydown','touchstart'].forEach(eventName => document.addEventListener(eventName, resetAutoLogout, { passive: true }));
setDefaultDates();
setInterval(() => $('#clock').textContent = new Date().toLocaleString('de-DE'), 1000);
setInterval(() => { if (state.currentView === 'dashboard') refreshDashboard().catch(() => {}); if (state.currentView === 'alarms') loadAlarms().catch(() => {}); if (state.currentView === 'visualization') renderLivePage().catch(() => {}); if (state.currentView === 'trends' && $('#trendLive').value === 'live' && state.trendSeries.length) loadTrend().catch(() => {}); }, 15000);
bootstrap().catch(error => { $('#connectionDot').classList.remove('ok'); toast(`Verbindung fehlgeschlagen: ${error.message}`, true); });
