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
  return Number.isFinite(n) ? new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(n) : 'â€”';
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
  dialog.innerHTML = `<form method="dialog"><header><h2>${escapeHtml(title)}</h2><button value="cancel" aria-label="SchlieÃŸen">Ã—</button></header><div class="objectPicker"><label class="objectPickerSearch">Objekte durchsuchen<input class="objectPickerSearchInput" type="search" placeholder="Name, Rolle oder vollstÃ¤ndige DP-Adresse"></label><div class="objectPickerResults"><div class="empty">Objektbaum wird geladen â€¦</div></div></div><footer><button type="button" class="quiet objectPickerCancel">Abbrechen</button><button type="button" class="primary objectPickerApply">${multiple ? 'Auswahl Ã¼bernehmen' : 'Datenpunkt Ã¼bernehmen'}</button></footer></form>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('.objectPickerCancel').addEventListener('click', close);
  dialog.querySelector('header button').addEventListener('click', event => { event.preventDefault(); close(); });
  dialog.querySelector('.objectPickerApply').addEventListener('click', () => {
    const rows = [...selectedMap.values()];
    if (!rows.length) return toast('Bitte mindestens einen Datenpunkt auswÃ¤hlen', true);
    close();
    onApply?.(multiple ? rows : rows.slice(-1));
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.showModal();
  let timer;
  const search = async query => {
    const rows = await api(`/${numericOnly ? 'api/trend-states' : 'api/states'}?query=${encodeURIComponent(query)}`);
    const target = dialog.querySelector('.objectPickerResults');
    target.innerHTML = rows.length ? rows.map(row => `<label class="objectPickerRow"><input type="${multiple ? 'checkbox' : 'radio'}" name="objectPickerItem" value="${escapeHtml(row.id)}" ${selectedMap.has(row.id) ? 'checked' : ''}><span><strong>${escapeHtml(row.name || row.id)}</strong><small>${escapeHtml(row.id)}${row.role ? ` Â· ${escapeHtml(row.role)}` : ''}</small></span><small>${escapeHtml(row.unit || '')}</small></label>`).join('') : '<div class="empty">Keine passenden Datenpunkte gefunden.</div>';
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
  $('#headerSiteName').textContent = data.settings?.siteName || 'GebÃ¤ude Zentrale';
  $('#settingsSiteName').value = data.settings?.siteName || 'GebÃ¤ude Zentrale';
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
  $('#trendSource').innerHTML = sources.length ? sources.map(source => `<option value="${escapeHtml(source.instance)}">${source.type === 'influxdb' ? 'InfluxDB' : 'History'} Â· ${escapeHtml(source.instance)}</option>`).join('') : '<option value="">Keine Zeitreihendatenbank konfiguriert</option>';
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
    toast('Die Sitzung wurde wegen InaktivitÃ¤t beendet');
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
  modal('Benutzerkonto', `<div class="accountSummary"><span class="accountAvatar">${escapeHtml($('#headerUserAvatar').textContent)}</span><div><strong>${escapeHtml(state.user.displayName || state.user.username)}</strong><small>${escapeHtml(state.user.username)} Â· ${state.user.role === 'admin' ? 'Administrator' : 'Benutzer'}</small></div></div><p class="muted">FÃ¼r einen Benutzerwechsel unten die neuen Zugangsdaten eintragen.</p><label>Benutzername<input id="loginUser" autocomplete="username"></label><label>Passwort<input id="loginPassword" type="password" autocomplete="current-password"></label>`, [
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
  modal('Passwort Ã¤ndern', '<p class="muted">Das Standardpasswort muss vor der weiteren Administration ersetzt werden.</p><label>Aktuelles Passwort<input id="oldPassword" type="password"></label><label>Neues Passwort (mindestens 10 Zeichen)<input id="newPassword" type="password"></label>', [
    { label: 'Jetzt Ã¤ndern', primary: true, click: async () => {
      try {
        await api('/api/change-password', { method: 'POST', body: { currentPassword: $('#oldPassword').value, newPassword: $('#newPassword').value } });
        closeModal();
        toast('Passwort wurde geÃ¤ndert');
        await bootstrap();
   ßNzöÚ$z{-®éÜj×&VÂ#ãÆ–çWB–CÒ&f÷&6U77v÷&D6†ævR"G—SÒ&6†V6¶&÷‚"G²VF—F–ærÇÂW'6öâæ×W7D6†ævU77v÷&Bòv6†V6¶VBr¢rwÓâ&V’FW"ì:F6‡7FVâæÖVÆGVærV–âæWVW277v÷'BfW&ÆævVãÂöÆ&VÃâG·W'6öâæÆö6¶VBòÆF—b6Æ73Ò&66÷VçDÆö6¶VBv–FR#ãÇ7G&öæsä¶öçFòæ6‚G´çVÖ&W"‡W'6öâæf–ÆVDÆöv–äGFV×G2’ÇÂwÒfV†ÇfW'7V6†VâvW7W''CÂ÷7G&öæsãÇ7ãâG·W'6öâæÆö6¶VDBòæWrFFR‡W'6öâæÆö6¶VDB’çFôÆö6ÆU7G&–ær‚vFRÔDRr’¢rwÓÂ÷7ããÂöF—cæ¢rwÓÆÆ&VÂ6Æ73Ò'v–FR#å§W6G¦–æf÷&ÖF–öæVãÇFW‡F&V–CÒ'W6W$æ÷FW2#âG¶W66T‡FÖÂ‡W'6öâææ÷FW2ÇÂrr—ÓÂ÷FW‡F&VãÂöÆ&VÃâG·ÆçEW&Ö—76–öç7ÓÆF—b6Æ73Ò'W&Ö—76–öäw&–Bv–FR#ãÇ7G&öæsäÖöGVÃÂ÷7G&öæsãÇ7G&öæsäÆW6VãÂ÷7G&öæsãÇ7G&öæså66‡&V–&VãÂ÷7G&öæsâG¶ÖöGVÆW2æÖ†ÖöGVÆRÓâÇ7ãâG¶ÖöGVÆWÓÂ÷7ããÆ–çWBG—SÒ&6†V6¶&÷‚"FF×W&ÓÒ"G¶ÖöGVÆWÒ"FFÖ7F–öãÒ'&VB"G·W&Ö—76–öç5¶ÖöGVÆUÓòç&VBòv6†V6¶VBr¢rwÓãÆ–çWBG—SÒ&6†V6¶&÷‚"FF×W&ÓÒ"G¶ÖöGVÆWÒ"FFÖ7F–öãÒ'w&—FR"G·W&Ö—76–öç5¶ÖöGVÆUÓòçw&—FRòv6†V6¶VBr¢rwÓæ’æ¦ö–â‚rr—ÓÂöF—cãÇ6Æ73Ò&×WFVBv–FR#î(	åW6W"b&V6‡F^(	ÂVæB(	äV–ç7FVÆÇVævVî(	Â6–æBW766†Æ–\9öÆ–6‚l;Ç"FÖ–æ—7G&F÷&VâfW&l;Æv&"ãÂ÷ãÂöF—cæ°Ð¢6öç7B6fRÒ7–æ2‡VæÆö6²ÒfÇ6R’Óâ²G'’²6öç7BWFFVEW&Ö—76–öç2Ò·Ó²BB‚u¶FF×W&ÕÒr’æf÷$V6‚†–çWBÓâ²WFFVEW&Ö—76–öç5¶–çWBæFF6WBçW&ÕÒÇÃÒ·Ó²WFFVEW&Ö—76–öç5¶–çWBæFF6WBçW&ÕÕ¶–çWBæFF6WBæ7F–öåÒÒ–çWBæ6†V6¶VC²Ò“²6öç7BÆÆ÷vVDæf–vF–öä–G2ÒBB‚u¶FF×ÆçB×W&Ö—76–öåÓ¦6†V6¶VBr’æÖ†–çWBÓâ–çWBçfÇVR“²v—B’‚rö’÷W6W'2rÂ²ÖWF†öC¢uUBrÂ&öG“¢²–C¢VF—F–æròW6W"æ–B¢VæFVf–æVBÂW6W&æÖS¢B‚r7W6W$æÖRr’çfÇVRÂF—7Æ”æÖS¢B‚r6F—7Æ”æÖRr’çfÇVRÂ77v÷&C¢B‚r7W6W%77v÷&Br’çfÇVRÂf÷&6U77v÷&D6†ævS¢B‚r6f÷&6U77v÷&D6†ævRr’æ6†V6¶VBÂVæÆö6²Â&öÆS¢B‚r7W6W%&öÆRr’çfÇVRÂ¦ö%F—FÆS¢B‚r6¦ö%F—FÆRr’çfÇVRÂFW'FÖVçC¢B‚r7W6W$FW'FÖVçBr’çfÇVRÂVÖ–Ã¢B‚r7W6W$VÖ–Âr’çfÇVRÂ†öæS¢B‚r7W6W%†öæRr’çfÇVRÂæ÷FW3¢B‚r7W6W$æ÷FW2r’çfÇVRÂW&Ö—76–öç3¢WFFVEW&Ö—76–öç2ÂÆÆ÷vVDæf–vF–öä–G2ÒÒ“²6Æ÷6TÖöFÂ‚“²v—BÆöEW6W'2‚“²Fö7B‡VæÆö6²òt&VçWG¦W&¶öçFòVçG7W''Br¢6÷––æròuW'6öâ¶÷–W'BVæBvW7V–6†W'Br¢uW'6öâvW7V–6†W'Br“²Ò6F6‚†W'&÷"’²Fö7B†W'&÷"æÖW76vRÂG'VR“²ÒÓ°Ð¢6öç7B7F–öç2Ò·²Æ&VÃ¢t&'&V6†VârÂ6Æ–6³¢6Æ÷6TÖöFÂÕÓ°Ð¢–b†VF—F–ær’7F–öç2çW6‚‡²Æ&VÃ¢uW'6öâ¶÷–W&VârÂ6Æ–6³¢‚’Óâ6†÷uW6W$F–Æör‡W6W"Â²6÷“¢G'VRÒ’Ò“°Ð¢–b†VF—F–ærbbW'6öâæÆö6¶VB’7F–öç2çW6‚‡²Æ&VÃ¢t¶öçFòVçG7W'&VârÂ6Æ–6³¢‚’Óâ6fR‡G'VR’Ò“°Ð¢7F–öç2çW6‚‡²Æ&VÃ¢6÷––æròt¶÷–R7V–6†W&âr¢u7V–6†W&ârÂ&–Ö'“¢G'VRÂ6Æ–6³¢‚’Óâ6fR†fÇ6R’Ò“°Ð¢ÖöFÂ†6÷––æròuW'6öâ¶÷–W&Vâr¢VF—F–æròuW'6öâ&V&&V—FVâr¢uW'6öâæÆVvVârÂ&öG’Â7F–öç2“°Ð¢B‚r7FövvÆUW6W%77v÷&Br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ°Ð¢6öç7B–çWBÒB‚r7W6W%77v÷&Br’Â&WfVÂÒ–çWBçG—RÓÓÒw77v÷&Bs°Ð¢–çWBçG—RÒ&WfVÂòwFW‡Br¢w77v÷&Bs°Ð¢WfVçBæ7W'&VçEF&vWBçFW‡D6öçFVçBÒ&WfVÂòufW&&W&vVâr¢tç¦V–vVâs°Ð¢Ò“°Ð¢BB‚u¶FF×W&ÕÕ¶FFÖ7F–öãÒ'w&—FR%Òr’æf÷$V6‚†–çWBÓâ–çWBæFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ°Ð¢–b†–çWBæ6†V6¶VB’B†¶FF×W&ÓÒ"G¶–çWBæFF6WBçW&×Ò%Õ¶FFÖ7F–öãÒ'&VB%Ö’æ6†V6¶VBÒG'VS°Ð¢Ò’“°Ð¢BB‚u¶FF×W&ÕÕ¶FFÖ7F–öãÒ'&VB%Òr’æf÷$V6‚†–çWBÓâ–çWBæFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ°Ð¢–b‚–çWBæ6†V6¶VB’B†¶FF×W&ÓÒ"G¶–çWBæFF6WBçW&×Ò%Õ¶FFÖ7F–öãÒ'w&—FR%Ö’æ6†V6¶VBÒfÇ6S°Ð¢Ò’“°Ð§ÐÐ Ð¦gVæ7F–öâFEv–FvWB‡G—R’°Ð¢6öç7BvRÒ7FFRçvW5·7FFRæVF—F÷%vUÓ°Ð¢–b‚vR’&WGW&ã°Ð¢6öç7B7W'fRÒ²v†VF–æt7W'fRrÂv‡‚uÒæ–æ6ÇVFW2‡G—R“°Ð¢6öç7Bv–FvWBÒ²–C¢V–B‚’ÂG—RÂÆ&VÃ¢G—RÓÓÒvæÆörròtÖW77vW'Br¢G—RÓÓÒvF–v—FÂròu7FGW2r¢G—RÓÓÒv‡‚ròv‚Ç‚ÔF–w&ÖÒr¢t†V—¦·W'fRrÂ7FFT–C¢rrÂƒ¢ƒ²vRçv–FvWG2æÆVæwF‚¢"Â“¢ƒ²vRçv–FvWG2æÆVæwF‚¢"Âv–GFƒ¢7W'fRò3#¢CÂVæ—C¢rrÂFV6–ÖÇ3¢"Ó°Ð¢–b†7W'fR’v–FvWBçö–çG2ÒG—RÓÓÒv‡‚rò·²ƒ¢ã‚Â“¢ã‚ÒÂ²ƒ¢ã2Â“¢ã3RÒÂ²ƒ¢ãSRÂ“¢ãS‚ÒÂ²ƒ¢ãs‚Â“¢ãsRÒÂ²ƒ¢ã“"Â“¢ãƒbÕÒ¢·²ƒ¢ã‚Â“¢ã"ÒÂ²ƒ¢ã3RÂ“¢ã3‚ÒÂ²ƒ¢ãcRÂ“¢ãcBÒÂ²ƒ¢ã“"Â“¢ãƒ"ÕÓ°Ð¢vRçv–FvWG2çW6‚‡v–FvWB“°Ð¢7FFRç6VÆV7FVEv–FvWBÒv–FvWBæ–C°Ð¢&VæFW$VF—F÷"‚“°Ð§ÐÐ Ð¦gVæ7F–öâæWuvR‚’°Ð¢6öç7BæÖRÒ&ö×B‚tæÖRFW2æWVVâæÆvVæ&–ÆFW3¢rÂæÆvVæ&–ÆBG·7FFRçvW2æÆVæwF‚²Ö“°Ð¢–b‚æÖR’&WGW&ã°Ð¢7FFRçvW2çW6‚‡²–C¢V–B‚’ÂæÖRÂv–GFƒ¢cÂ†V–v‡C¢“Â&6¶w&÷VæC¢rrÂv–FvWG3¢µÒÒ“°Ð¢7FFRæVF—F÷%vRÒ7FFRçvW2æÆVæwF‚Ò°Ð¢f–ÆÅvU6VÆV7G2‚“°Ð¢B‚r6VF—F÷%vU6VÆV7Br’çfÇVRÒ7G&–ær‡7FFRæVF—F÷%vR“°Ð¢&VæFW$VF—F÷"‚“°Ð§ÐÐ Ð¦7–æ2gVæ7F–öâ6fUvW2‚’°Ð¢G'’²7FFRçvW2Òv—B’‚rö’÷vW2rÂ²ÖWF†öC¢uUBrÂ&öG“¢7FFRçvW2Ò“²f–ÆÅvU6VÆV7G2‚“²Fö7B‚tæÆvVæ&–ÆFW"vW7V–6†W'Br“²Ò6F6‚†W'&÷"’²Fö7B†W'&÷"æÖW76vRÂG'VR“²ÐÐ§ÐÐ Ð¦gVæ7F–öâWÆöD&6¶w&÷VæB†f–ÆR’°Ð¢–b‚f–ÆR’&WGW&ã°Ð¢–b†f–ÆRç6—¦Râ‚¢#B¢#B’&WGW&âFö7B‚tF2&–ÆBF&bÖ†–ÖÂ‚Ô"w&ü9ò6V–ârÂG'VR“°Ð¢6öç7B&VFW"ÒæWrf–ÆU&VFW"‚“°Ð¢&VFW"æöæÆöBÒ‚’Óâ²7FFRçvW5·7FFRæVF—F÷%vUÒæ&6¶w&÷VæBÒ&VFW"ç&W7VÇC²&VæFW$VF—F÷"‚“²Ó°Ð¢&VFW"ç&VD4FFU$Â†f–ÆR“°Ð§ÐÐ Ð¦gVæ7F–öâ7FFU6V&6…6WGW‚’°Ð¢ÆWBF–ÖW#°Ð¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"‚v–çWBrÂWfVçBÓâ°Ð¢6öç7B–çWBÒWfVçBçF&vWBæ6Æ÷6W7Còâ‚v–çWE¶Æ—7CÒ'7FFT÷F–öç2%Òr“°Ð¢–b‚–çWB’&WGW&ã°Ð¢6ÆV%F–ÖV÷WB‡F–ÖW"“°Ð¢–b†–çWBçfÇVRæÆVæwF‚Â"’&WGW&ã°Ð¢F–ÖW"Ò6WEF–ÖV÷WB†7–æ2‚’Óâ²G'’²6öç7B&÷w2Òv—B’†ö’÷7FFW3÷VW'“ÒG¶Væ6öFUU$”6ö×öæVçB†–çWBçfÇVR—Ö“²B‚r77FFT÷F–öç2r’æ–ææW$…DÔÂÒ&÷w2ç6Æ–6RƒÂƒ’æÖ‡&÷rÓâÆ÷F–öâfÇVSÒ"G¶W66T‡FÖÂ‡&÷ræ–B—Ò#âG¶W66T‡FÖÂ‡&÷rææÖR—ÓÂö÷F–öãæ’æ¦ö–â‚rr“²Ò6F6‚²ò¢6–ÆVçFÇ’¶VW7W'&VçB÷F–öç2¢òÒÒÂ3S“°Ð¢Ò“°Ð§ÐÐ Ð¦gVæ7F–öâ6WDFVfVÇDFFW2‚’°Ð¢6öç7Bæ÷rÒFFRææ÷r‚’ÂF’ÒƒcC°Ð¢B‚r7G&VæDVæBr’çfÇVRÒFFUF–ÖUfÇVR†æ÷r“°Ð¢B‚r7G&VæE7F'Br’çfÇVRÒFFUF–ÖUfÇVR†æ÷rÒF’“°Ð¢B‚r6VæW&w”VæBr’çfÇVRÒæWrFFR‚’çFô•4õ7G&–ær‚’ç6Æ–6RƒÂ“°Ð¢B‚r6VæW&w•7F'Br’çfÇVRÒæWrFFR†æ÷rÒ3¢F’’çFô•4õ7G&–ær‚’ç6Æ–6RƒÂ“°Ð§ÐÐ Ð¢B‚r6ÖVçUFövvÆRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’ÓâFövvÆTÖVçR‚’“°Ð¢B‚r6æ÷F–f–6F–öä'WGFöâr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ°Ð¢6öç7B÷VâÒB‚r6æ÷F–f–6F–öåG&’r’æ6Æ74Æ—7BçFövvÆR‚v÷Vâr“°Ð¢B‚r6æ÷F–f–6F–öä'WGFöâr’ç6WDGG&–'WFR‚v&–ÖW‡æFVBrÂ7G&–ær†÷Vâ’“°Ð§Ò“°Ð¢B‚r66Æ÷6Tæ÷F–f–6F–öç2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ°Ð¢B‚r6æ÷F–f–6F–öåG&’r’æ6Æ74Æ—7Bç&VÖ÷fR‚v÷Vâr“°Ð¢B‚r6æ÷F–f–6F–öä'WGFöâr’ç6WDGG&–'WFR‚v&–ÖW‡æFVBrÂvfÇ6Rr“°Ð§Ò“°Ð¢B‚r6æf–vF–öâr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²6öç7B'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚v'WGFöå¶FF×f–WuÒr“²–b†'WGFöâ’6†÷uf–Wr†'WGFöâæFF6WBçf–Wr“²Ò“°Ð¢B‚r6Æöv–ä'WGFöâr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ6†÷t66÷VçDF–Æör“°Ð¢B‚r7&Vg&W6„Æ&×2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂÆöDÆ&×2“°Ð¢B‚r6FDÆ&Òr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ6†÷tFDÆ&Ò“°Ð¢B‚r6ÆöEG&VæBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂÆöEG&VæB“°Ð¢B‚r6FEG&VæE7FFW2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uG&VæE7FFU–6¶W"‚’æ6F6‚†W'&÷"ÓâFö7B†W'&÷"æÖW76vRÇG'VR’’“°Ð¢B‚r7G&VæEG—Rr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ&VæFW$7W'&VçEG&VæB“°Ð¢B‚r7G&VæDÆ–æUv–GF‚r’æFDWfVçDÆ—7FVæW"‚v–çWBrÂ&VæFW$7W'&VçEG&VæB“°Ð¢B‚r7G&VæE&W6öÇWF–öâr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ7FFRçG&VæE6W&–W2æÆVæwF‚bbÆöEG&VæB‚’“°Ð¢B‚r7G&VæDÖ–âr’æFDWfVçDÆ—7FVæW"‚v–çWBrÂ&VæFW$7W'&VçEG&VæB“°Ð¢B‚r7G&VæDÖ‚r’æFDWfVçDÆ—7FVæW"‚v–çWBrÂ&VæFW$7W'&VçEG&VæB“°Ð¢B‚r7G&VæE6÷W&6Rr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ7FFRçG&VæE6W&–W2æÆVæwF‚bbÆöEG&VæB‚’“°Ð¢B‚r7G&VæEW&–öBr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂWfVçBÓâ²–b†WfVçBçF&vWBçfÇVRÓÓÒv7W7FöÒr’&WGW&ã²6öç7BVæBÒFFRææ÷r‚“²B‚r7G&VæDVæBr’çfÇVRÒFFUF–ÖUfÇVR†VæB“²B‚r7G&VæE7F'Br’çfÇVRÒFFUF–ÖUfÇVR†VæBÔçVÖ&W"†WfVçBçF&vWBçfÇVR’£3c“²–b‡7FFRçG&VæE6W&–W2æÆVæwF‚’ÆöEG&VæB‚“²Ò“°Ð¢B‚r7G&VæDÆVvVæBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²6öç7B6öÆ÷$'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FFÖ÷Vâ×G&VæBÖ6öÆ÷'5Òr“²–b†6öÆ÷$'WGFöâ’&WGW&â÷VåG&VæD6öÆ÷%ÆWGFR†6öÆ÷$'WGFöâæFF6WBæ÷VåG&VæD6öÆ÷'2Æ6öÆ÷$'WGFöâ“²6öç7B'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FF×&VÖ÷fR×G&VæEÒr“²–b‚'WGFöâ’&WGW&ã²7FFRçG&VæE6W&–W2Ò7FFRçG&VæE6W&–W2æf–ÇFW"†—FVÒÓâ—FVÒæ–BÓÒ'WGFöâæFF6WBç&VÖ÷fUG&VæB“²7FFRçG&VæDFFÒ7FFRçG&VæDFFæf–ÇFW"†—FVÒÓâ—FVÒæ–BÓÒ'WGFöâæFF6WBç&VÖ÷fUG&VæB“²&VæFW$7W'&VçEG&VæB‚“²Ò“°Ð¢B‚r7G&VæDÆVvVæBr’æFDWfVçDÆ—7FVæW"‚wö–çFW&Ö÷fRrÂWfVçBÓâ²6öç7B—FVÒÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FF×G&VæBÖ–æfõÒr“²–b‚—FVÒ’&WGW&ã²6öç7B6W&–W2Ò7FFRçG&VæE6W&–W2æf–æB†VçG'’ÓâVçG'’æ–BÓÓÒ—FVÒæFF6WBçG&VæD–æfò’ÂFF6WBÒ7FFRçG&VæDFFæf–æB†VçG'’ÓâVçG'’æ–BÓÓÒ—FVÒæFF6WBçG&VæD–æfò’ÂÆFW7BÒFF6WCòçfÇVW3òæB‚Ó“²–b‚6W&–W2’&WGW&ã²6öç7BFööÇF—ÒB‚r7FööÇF—r“²FööÇF—æ–ææW$…DÔÂÒÇ7G&öæsâG¶W66T‡FÖÂ‡6W&–W2ææÖRÇÂ6W&–W2æ–B—ÓÂ÷7G&öæsãÆ'#äEÔG&W76S¢G¶W66T‡FÖÂ‡6W&–W2æ–B—ÓÆ'#äV–æ†V—C¢G¶W66T‡FÖÂ‡6W&–W2çVæ—BÇÂ~(	Br—ÓÆ'#åVVÆÆS¢G¶W66T‡FÖÂ‡6W&–W2ç6÷W&6UG—RÓÓÒv77brò6W&–W2ç6÷W&6TæÖRÇÂt55br¢B‚r7G&VæE6÷W&6Rr’çfÇVRÇÂ~(	Br—ÓÆ'#äVfÌ;g7Væs¢G¶W66T‡FÖÂ‡6W&–W2ç6÷W&6UG—RÓÓÒv77bròt55bÔ–×÷'Br¢B‚r7G&VæE&W6öÇWF–öâr’ç6VÆV7FVD÷F–öç5³ÒçFW‡D6öçFVçB—ÒG¶ÆFW7BòÆ'#äÆWG§FW"vW'C¢G¶çVÖ&W"†ÆFW7BçfÂÃB—ÒG¶W66T‡FÖÂ‡6W&–W2çVæ—BÇÂrr—ÓÆ'#âG¶æWrFFR†ÆFW7BçG2’çFôÆö6ÆU7G&–ær‚vFRÔDRr—Ö¢rwÖ²6†÷uFööÇF—B‡FööÇF—ÂWfVçBæ6Æ–VçE‚ÂWfVçBæ6Æ–VçE’“²Ò“°Ð¢B‚r7G&VæDÆVvVæBr’æFDWfVçDÆ—7FVæW"‚wö–çFW&ÆVfRrÂ‚’ÓâB‚r7FööÇF—r’ç7G–ÆRæF—7Æ’ÒvæöæRr“°Ð¢B‚r7G&VæD6öÆ÷%ÆWGFRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²6öç7B'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FF×ÆWGFRÖ6öÆ÷%Òr“²–b‚'WGFöâ’&WGW&ã²6öç7B–BÒB‚r7G&VæD6öÆ÷%ÆWGFRr’æFF6WBç6W&–W4–BÂ6öÆ÷"Ò'WGFöâæFF6WBçÆWGFT6öÆ÷"Â6W&–W2Ò7FFRçG&VæE6W&–W2æf–æB†—FVÒÓâ—FVÒæ–BÓÓÒ–B“²–b‡6W&–W2’6W&–W2æ6öÆ÷"Ò6öÆ÷#²7FFRçG&VæDFFÒ7FFRçG&VæDFFæÖ†FF6WBÓâFF6WBæ–BÓÓÒ–Bò²ââæFF6WBÂ6öÆ÷"Ò¢FF6WB“²B‚r7G&VæD6öÆ÷%ÆWGFRr’æ†–FFVâÒG'VS²&VæFW$7W'&VçEG&VæB‚“²Ò“°Ð¢B‚r6W‡÷'EG&VæEFbr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂW‡÷'EG&VæEFb“°Ð¢B‚r6W‡÷'EG&VæD77br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂW‡÷'EG&VæD77b“°Ð¢B‚r6–×÷'EG&VæD77br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’ÓâB‚r7G&VæD77d–çWBr’æ6Æ–6²‚’“°Ð¢B‚r7G&VæD77d–çWBr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂWfVçBÓâ°Ð¢6öç7Bf–ÆRÒWfVçBçF&vWBæf–ÆW3òå³Ó°Ð¢–×÷'EG&VæD77b†f–ÆR’æ6F6‚†W'&÷"ÓâFö7B†W'&÷"æÖW76vRÂG'VR’’æf–æÆÇ’‚‚’Óâ²WfVçBçF&vWBçfÇVRÒrs²Ò“°Ð§Ò“°Ð¢B‚r7G&VæE¦ööÔ&6²r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ&W7F÷&U&Wf–÷W5G&VæE¦ööÒ‚’æ6F6‚†W'&÷"ÓâFö7B†W'&÷"æÖW76vRÂG'VR’’“°Ð¢B‚r6F6†&ö&DVF—Br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²7FFRæF6†&ö&DVF—CÒ7FFRæF6†&ö&DVF—C²WfVçBæ7W'&VçEF&vWBçFW‡D6öçFVçC×7FFRæF6†&ö&DVF—Còt&V&&V—GVær&VVæFVâs¢t&V&&V—FVâs²WfVçBæ7W'&VçEF&vWBç6WDGG&–'WFR‚v&–×&W76VBrÅ7G&–ær‡7FFRæF6†&ö&DVF—B’“²B‚r6F6†&ö&DFBr’æ†–FFVãÒ7FFRæF6†&ö&DVF—C²&VæFW$F6†&ö&B‚“²Ò“°Ð¢B‚r6F6†&ö&DFBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷tF6†&ö&DF–Æör‚’“°Ð¢B‚r6F6†&ö&E&Vg&W6‚r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ&Vg&W6„F6†&ö&B“°Ð¢B‚r67&VFU&W÷'Br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7&VFU&W÷'B“°Ð¢B‚r6FDVæW&w•7FFW2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷tVæW&w•7FFU–6¶W"‚’æ6F6‚†W'&÷"ÓâFö7B†W'&÷"æÖW76vRÂG'VR’’“°Ð¢B‚r6ÆöDVæW&w”†—7F÷'’r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂÆöDVæW&w”†—7F÷'’“°Ð¢B‚r6VæW&w”6†'EG—Rr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ&VæFW$VæW&w”†—7F÷'’“°Ð¢B‚r6W‡÷'DVæW&w”77br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂW‡÷'DVæW&w”77b“°Ð¢B‚r6–×÷'DVæW&w”77br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’ÓâB‚r6VæW&w”77d–çWBr’æ6Æ–6²‚’“°Ð¢B‚r6VæW&w”77d–çWBr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂWfVçBÓâ°Ð¢6öç7Bf–ÆRÒWfVçBçF&vWBæf–ÆW3òå³Ó°Ð¢–×÷'DVæW&w”77b†f–ÆR’æ6F6‚†W'&÷"ÓâFö7B†W'&÷"æÖW76vRÂG'VR’’æf–æÆÇ’‚‚’Óâ²WfVçBçF&vWBçfÇVRÒrs²Ò“°Ð§Ò“°Ð¢B‚r7–6´VæW&w•7FFRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷tö&¦V7E–6¶W"‡²F—FÆS¢v–ô'&ö¶W"Ôö&¦V·F&VÒ+rfW&'&V6‡6FFVçVæ·BrÂçVÖW&–4öæÇ“¢G'VRÂ6VÆV7FVC¢B‚r6VæW&w•7FFRr’çfÇVRò·²–C¢B‚r6VæW&w•7FFRr’çfÇVRÕÒ¢µÒÂöäÇ“¢&÷w2Óâ²B‚r6VæW&w•7FFRr’çfÇVRÒ&÷w5³Òæ–C²ÒÒ’æ6F6‚†W'&÷"ÓâFö7B†W'&÷"æÖW76vRÂG'VR’’“°Ð¢B‚r6æWuW6W"r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uW6W$F–Æör‚’“°Ð¢B‚r76WGF–æw4föçBr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂWfVçBÓâÇ”föçB†WfVçBçF&vWBçfÇVR’“°Ð¢B‚r76WGF–æw5F†VÖRr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂWfVçBÓâÇ•F†VÖR†WfVçBçF&vWBçfÇVR’“°Ð¢B‚r76fUV•6WGF–æw2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²G'’²6öç7B&tFÖ–åW&ÂÒB‚r76WGF–æw4–ô'&ö¶W%W&Âr’çfÇVRçG&–Ò‚’Â–ô'&ö¶W$FÖ–åW&ÂÒ&tFÖ–åW&Âò6fUf—5W&Â‡&tFÖ–åW&Â’¢rs²–b‡&tFÖ–åW&Âbb–ô'&ö¶W$FÖ–åW&Â’F‡&÷ræWrW'&÷"‚t&—GFRV–æR|;ÆÇF–vR–ô'&ö¶W"ÔG&W76RV–ævV&Vâr“²6öç7B6WGF–æw2Òv—B’‚rö’÷6WGF–æw2rÂ²ÖWF†öC¢uUBrÂ&öG“¢²6—FTæÖS¢B‚r76WGF–æw56—FTæÖRr’çfÇVRÂföçDfÖ–Ç“¢B‚r76WGF–æw4föçBr’çfÇVRÂF†VÖS¢B‚r76WGF–æw5F†VÖRr’çfÇVRÂWFôÆövöfdÖ–çWFW3¢çVÖ&W"‚B‚r76WGF–æw4WFôÆövöfbr’çfÇVR’Â–ô'&ö¶W$FÖ–åW&ÂÒÒ“²7FFRæ&ö÷G7G&ç6WGF–æw2Ò6WGF–æw3²B‚r76WGF–æw4–ô'&ö¶W%W&Âr’çfÇVRÒ6WGF–æw2æ–ô'&ö¶W$FÖ–åW&ÂÇÂrs²B‚r6†VFW%6—FTæÖRr’çFW‡D6öçFVçBÒ6WGF–æw2ç6—FTæÖS²Ç”föçB‡6WGF–æw2æföçDfÖ–Ç’“²Ç•F†VÖR‡6WGF–æw2çF†VÖR“²&W6WDWFôÆöv÷WB‚“²Fö7B‚tö&W&fÌ:F6†VæV–ç7FVÆÇVævVâvW7V–6†W'Br“²Ò6F6‚†W'&÷"’²Fö7B†W'&÷"æÖW76vRÇG'VR“²ÒÒ“°Ð¢B‚r6ÖævUÆçEG&VRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uG&VTæöFTF–Æör‚’“°Ð¢B‚r7FövvÆUÆçEG&VRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²6öç7BÆ–÷WBÒB‚rçf—7VÆ—¦F–öäÆ–÷WBr’Â6öÆÆ6VBÒÆ–÷WBæ6Æ74Æ—7Bæ6öçF–ç2‚wG&VRÖ6öÆÆ6VBr“²Æ–÷WBæ6Æ74Æ—7BçFövvÆR‚wG&VRÖ6öÆÆ6VBrÂ6öÆÆ6VB“²WfVçBæ7W'&VçEF&vWBç6WDGG&–'WFR‚v&–ÖW‡æFVBrÂ7G&–ær‚6öÆÆ6VB’“²WfVçBæ7W'&VçEF&vWBç6WDGG&–'WFR‚v&–ÖÆ&VÂrÂ6öÆÆ6VBòtæÆvVæ&VÒV–æ&ÆVæFVâr¢tæÆvVæ&VÒW6&ÆVæFVâr“²Ò“°Ð¢B‚r7FövvÆUG&VæE6WGF–æw2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâFövvÆU6WGF–æw5æVÂ†WfVçBæ7W'&VçEF&vWBÂB‚r7G&VæD6öçG&öÇ2r’ÂB‚r7f–Wr×G&VæG2r’Âw6WGF–æw2Ö6öÆÆ6VBr’“°Ð¢B‚r7FövvÆTVæW&w•6WGF–æw2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâFövvÆU6WGF–æw5æVÂ†WfVçBæ7W'&VçEF&vWBÂB‚r6VæW&w”6öçG&öÇ2r’ÂB‚r7f–WrÖVæW&w’r’ÂvVæW&w’×6WGF–æw2Ö6öÆÆ6VBr’“°Ð¢B‚r7W6W%6V&6‚r’æFDWfVçDÆ—7FVæW"‚v–çWBrÂWfVçBÓâ²7FFRçW6W%6V&6‚ÒWfVçBçF&vWBçfÇVS²&VæFW%W6W'2‚“²Ò“°Ð¢BB‚u¶FF×W6W"×6÷'EÒr’æf÷$V6‚††VFW"Óâ†VFW"æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ²6öç7B¶W’Ò†VFW"æFF6WBçW6W%6÷'C²7FFRçW6W%6÷'BÒ²¶W’ÂF—&V7F–öã¢7FFRçW6W%6÷'Bæ¶W’ÓÓÒ¶W’ò×7FFRçW6W%6÷'BæF—&V7F–öâ¢Ó²&VæFW%W6W'2‚“²Ò’“°Ð¢B‚r6ÖöFÂr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²–b†WfVçBçF&vWBÓÓÒB‚r6ÖöFÂr’’6Æ÷6TÖöFÂ‚“²Ò“°Ð¥²wö–çFW&F÷vârÂv¶W–F÷vârÂwF÷V6‡7F'BuÒæf÷$V6‚†WfVçDæÖRÓâFö7VÖVçBæFDWfVçDÆ—7FVæW"†WfVçDæÖRÂ&W6WDWFôÆöv÷WBÂ²76—fS¢G'VRÒ’“°Ð§6WDFVfVÇDFFW2‚“°Ð§6WD–çFW'fÂ‚‚’ÓâB‚r66Æö6²r’çFW‡D6öçFVçBÒæWrFFR‚’çFôÆö6ÆU7G&–ær‚vFRÔDRr’Â“°Ð§6WD–çFW'fÂ‚‚’Óâ²–b‡7FFRæ7W'&VçEf–WrÓÓÒvF6†&ö&Br’&Vg&W6„F6†&ö&B‚’æ6F6‚‚‚’Óâ·Ò“²–b‡7FFRæ7W'&VçEf–WrÓÓÒvÆ&×2r’ÆöDÆ&×2‚’æ6F6‚‚‚’Óâ·Ò“²–b‡7FFRæ7W'&VçEf–WrÓÓÒwf—7VÆ—¦F–öâr’&VæFW$Æ—fUvR‚’æ6F6‚‚‚’Óâ·Ò“²–b‡7FFRæ7W'&VçEf–WrÓÓÒwG&VæG2rbbB‚r7G&VæDÆ—fRr’çfÇVRÓÓÒvÆ—fRrbb7FFRçG&VæE6W&–W2æÆVæwF‚’ÆöEG&VæB‚’æ6F6‚‚‚’Óâ·Ò“²ÒÂS“°Ð¦&ö÷G7G&‚’æ6F6‚†W'&÷"Óâ²B‚r66öææV7F–öäF÷Br’æ6Æ74Æ—7Bç&VÖ÷fR‚vö²r“²Fö7B†fW&&–æGVærfV†ÆvW66†ÆvVã¢G¶W'&÷"æÖW76vWÖÂG'VR“²Ò“°Ð