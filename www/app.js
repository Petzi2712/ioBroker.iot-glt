'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { bootstrap: null, user: null, csrf: '', pages: [], navigationTree: [], selectedTreeId: '', expandedTreeIds: new Set(), currentView: 'dashboard', editorPage: 0, selectedWidget: null, stateCache: new Map(), reports: [], trendSeries: [], trendData: [], trendZoomHistory: [], trendWheelSession: 0, energySeries: [], energyData: [], energyScrollTimer: null, users: [], userSearch: '', userSort: { key: 'displayName', direction: 1 }, autoLogoutTimer: null, lastKeepAlive: 0, treeDragActive: false, dashboardEdit: false, dashboardActiveId: null, dashboardWidgets: [] };
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
    $�M<��$z{-���jםch den sicheren Hash nicht auslesbar. Hier kann ein temporäres neues Passwort gesetzt werden.</small></label><label class="wide checkLabel"><input id="forcePasswordChange" type="checkbox" ${!editing || person.mustChangePassword ? 'checked' : ''}> Bei der nächsten Anmeldung ein neues Passwort verlangen</label>${person.locked ? `<div class="accountLocked wide"><strong>Konto nach ${Number(person.failedLoginAttempts) || 7} Fehlversuchen gesperrt</strong><span>${person.lockedAt ? new Date(person.lockedAt).toLocaleString('de-DE') : ''}</span></div>` : ''}<label class="wide">Zusatzinformationen<textarea id="userNotes">${escapeHtml(person.notes || '')}</textarea></label>${plantPermissions}<div class="permissionGrid wide"><strong>Modul</strong><strong>Lesen</strong><strong>Schreiben</strong>${modules.map(module => `<span>${module}</span><input type="checkbox" data-perm="${module}" data-action="read" ${permissions[module]?.read ? 'checked' : ''}><input type="checkbox" data-perm="${module}" data-action="write" ${permissions[module]?.write ? 'checked' : ''}>`).join('')}</div><p class="muted wide">„User & Rechte“ und „Einstellungen“ sind ausschließlich für Administratoren verfügbar.</p></div>`;
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
$('#energyChartType').addEventListener('change', renderEnergyHistory);
$('#exportEnergyCsv').addEventListener('click', exportEnergyCsv);
$('#importEnergyCsv').addEventListener('click', () => $('#energyCsvInput').click());
$('#energyCsvInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  importEnergyCsv(file).catch(error => toast(error.message, true)).finally(() => { event.target.value = ''; });
});
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
