'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { bootstrap: null, user: null, csrf: '', pages: [], navigationTree: [], selectedTreeId: '', expandedTreeIds: new Set(), currentView: 'dashboard', editorPage: 0, selectedWidget: null, stateCache: new Map(), reports: [], trendSeries: [], trendData: [], autoLogoutTimer: null, lastKeepAlive: 0, treeDragActive: false, dashboardEdit: false, dashboardActiveId: null, dashboardWidgets: [] };
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

function can(module, action = 'read') {
  return state.user?.role === 'admin' || Boolean(state.user?.permissions?.[module]?.[action]);
}

function applyFont(value) {
  document.body.classList.toggle('font-material', value === 'material');
  document.body.classList.toggle('font-apple', value !== 'material');
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
  $('#headerSiteName').textContent = data.settings?.siteName || 'GebÃ¤ude Zentrale';
  $('#settingsSiteName').value = data.settings?.siteName || 'GebÃ¤ude Zentrale';
  $('#settingsFont').value = data.settings?.fontFamily === 'material' ? 'material' : 'apple';
  $('#settingsAutoLogoff').value = String(data.settings?.autoLogoffMinutes || 30);
  $('#settingsIoBrokerUrl').value = data.settings?.ioBrokerAdminUrl || '';
  const authenticated = state.user?.id && state.user.id !== 'public';
  $('#headerUserName').textContent = authenticated ? (state.user.displayName || state.user.username) : 'Anmelden';
  $('#headerUserAvatar').textContent = authenticated ? String(state.user.displayName || state.user.username || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() : '?';
  $('#sideUser').textContent = state.user?.displayName || state.user?.username || 'Nicht angemeldet';
  $('#sideRole').textContent = state.user?.role === 'admin' ? 'Administrator' : 'Nur lesen';
  $$('#navigation button').forEach(button => {
    const module = button.dataset.view;
    button.hidden = !data.modules?.[module];
    button.disabled = !data.modules?.[module];
  });
  $('#addAlarm').hidden = !can('alarms', 'write');
  $('#dashboardEdit').hidden = !can('dashboard', 'write');
  $('#managePlantTree').hidden = !can('editor', 'write');
  $('#newUser').hidden = !can('users', 'write');
  const sources = data.adapter?.historySources || [];
  $('#trendSource').innerHTML = sources.length ? sources.map(source => `<option value="${escapeHtml(source.instance)}">${source.type === 'influxdb' ? 'InfluxDB' : 'History'} Â· ${escapeHtml(source.instance)}</option>`).join('') : '<option value="">Keine Zeitreihendatenbank konfiguriert</option>';
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
  return `<svg viewBox="0 0 320 170" aria-label="${escapeHtml(widget.label)}"><g>${[0,1,2,3,4].map(i => `<line class="curveGrid" x1="20" y1="${20 + i * 32.5}" x2="300" y2="${20 + i * 32.5}"/>`).join('')}</g><polyline class="curvePath" points="${coords}"/>${handles}<text x="22" y="16" fill="#8ba3c0" font-size="10">${widget.type === 'hx' ? 'Feuchte / Enthalpie' : 'AuÃŸentemperatur / Vorlauf'}</text></svg>`;
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
      try { await api('/api/state', { method: 'PUT', body: { id: widget.stateId, value: !Boolean(point.val) } }); toast('Sollwert Ã¼bertragen'); setTimeout(renderLivePage, 600); } catch (error) { toast(error.message, true); }
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
    const start = ÛN»ÒÚ$z{-®éÜj×¶W66T‡FÖÂ‡W6W"æ¦ö%F—FÆRÇÂ‡W6W"ç&öÆRÓÓÒvFÖ–âròtFÖ–æ—7G&F÷"r¢t&Vö&6‡FW"r’—ÓÂ÷7G&öæsãÇ6ÖÆÃâG¶W66T‡FÖÂ‡W6W"ç&öÆRÓÓÒvFÖ–âròu7—7FVÖFÖ–æ—7G&F–öâr¢t&VçWG¦W"r—ÓÂ÷6ÖÆÃãÂöF—cãÆF—cãÇ7ãâG¶W66T‡FÖÂ‡W6W"æFW'FÖVçBÇÂt¶V–â&W&V–6‚r—ÓÂ÷7ããÇ6ÖÆÃâG¶W66T‡FÖÂ‡W6W"æVÖ–ÂÇÂW6W"ç†öæRÇÂt¶V–æR¶öçF·FFFVâr—ÓÂ÷6ÖÆÃãÂöF—cãÇ7â6Æ73Ò'–ÆÂG·W6W"æÆö6¶VBòvÆ&Òr¢W6W"æ×W7D6†ævU77v÷&Bòwv&æ–ærr¢vö²wÒ#âG·W6W"æÆö6¶VBòtvW7W''Br¢W6W"æ×W7D6†ævU77v÷&Bòu77v÷'GvV6‡6VÂöffVâr¢t·F—bwÓÂ÷7ããÆF—b6Æ73Ò'W'6öä7F–öç2#ãÆ'WGFöâ6Æ73Ò'V–WB"FFÖVF—B×W6W#Ò"G·W6W"æ–GÒ#ä&V&&V—FVãÂö'WGFöããÆ'WGFöâ6Æ73Ò'V–WB"FFÖ6÷’×W6W#Ò"G·W6W"æ–GÒ#ä¶÷–W&VãÂö'WGFöãâG·W6W"æ–BÓÒvFÖ–âròÆ'WGFöâ6Æ73Ò'V–WB"FFÖFVÆWFR×W6W#Ò"G·W6W"æ–GÒ#äÌ;g66†VãÂö'WGFöãæ¢rwÓÂöF—cãÂöF—cæ’æ¦ö–â‚rr“°¢BB‚u¶FF×W6W"×&÷uÒr’æf÷$V6‚‡&÷rÓâ&÷ræFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²–b‚WfVçBçF&vWBæ6Æ÷6W7B‚v'WGFöâr’’6†÷uW6W$F–Æör‡W6W'2æf–æB‡W6W"ÓâW6W"æ–BÓÓÒ&÷ræFF6WBçW6W%&÷r’“²Ò’“°¢BB‚u¶FFÖVF—B×W6W%Òr’æf÷$V6‚†'WGFöâÓâ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uW6W$F–Æör‡W6W'2æf–æB‡W6W"ÓâW6W"æ–BÓÓÒ'WGFöâæFF6WBæVF—EW6W"’’’“°¢BB‚u¶FFÖ6÷’×W6W%Òr’æf÷$V6‚†'WGFöâÓâ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uW6W$F–Æör‡W6W'2æf–æB‡W6W"ÓâW6W"æ–BÓÓÒ'WGFöâæFF6WBæ6÷•W6W"’Â²6÷“¢G'VRÒ’’“°¢BB‚u¶FFÖFVÆWFR×W6W%Òr’æf÷$V6‚†'WGFöâÓâ'WGFöâæFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²–b†6öæf—&Ò‚uW6W"v—&¶Æ–6‚Ì;g66†Vãòr’’²v—B’†ö’÷W6W'2òG¶'WGFöâæFF6WBæFVÆWFUW6W'ÖÂ²ÖWF†öC¢tDTÄUDRrÒ“²v—BÆöEW6W'2‚“²ÒÒ’“°§Ğ ¦gVæ7F–öâ6†÷uW6W$F–Æör‡W6W"ÒçVÆÂÂ÷F–öç2Ò·Ò’°¢6öç7B6÷––ærÒ&ööÆVâ†÷F–öç2æ6÷’bbW6W"“°¢6öç7BVF—F–ærÒ&ööÆVâ‡W6W"bb6÷––ær“°¢6öç7BW'6öâÒW6W"ò7G'V7GW&VD6ÆöæR‡W6W"’¢·Ó°¢–b†6÷––ær’²W'6öâæF—7Æ”æÖRÒG·W'6öâæF—7Æ”æÖRÇÂW'6öâçW6W&æÖWÒ„¶÷–R–²W'6öâçW6W&æÖRÒG·W'6öâçW6W&æÖWÒæ¶÷–V²Ğ¢6öç7BÖöGVÆW2Ò²vF6†&ö&BrÂvÆ&×2rÂwf—7VÆ—¦F–öârÂwG&VæG2rÂvVæW&w’rÂvVF—F÷"uÓ°¢6öç7BW&Ö—76–öç2ÒW'6öâçW&Ö—76–öç2ÇÂö&¦V7Bæg&öÔVçG&–W2†ÖöGVÆW2æÖ†ÖöGVÆRÓâ¶ÖöGVÆRÂ²&VC¢²vF6†&ö&BrÂvÆ&×2rÂwf—7VÆ—¦F–öârÂwG&VæG2rÂvVæW&w’uÒæ–æ6ÇVFW2†ÖöGVÆR’Âw&—FS¢fÇ6RÕÒ’“°¢6öç7B&öG’ÒÆF—b6Æ73Ò'W'6öäf÷&Ò#ãÆÆ&VÃåW'6öæVææÖSÆ–çWB–CÒ&F—7Æ”æÖR"fÇVSÒ"G¶W66T‡FÖÂ‡W'6öâæF—7Æ”æÖRÇÂrr—Ò#ãÂöÆ&VÃãÆÆ&VÃä&VçWG¦W&æÖSÆ–çWB–CÒ'W6W$æÖR"fÇVSÒ"G¶W66T‡FÖÂ‡W'6öâçW6W&æÖRÇÂrr—Ò"G¶VF—F–æròvF—6&ÆVBr¢rwÓãÂöÆ&VÃãÆÆ&VÃägVæ·F–öâò&öÆÆSÆ–çWB–CÒ&¦ö%F—FÆR"fÇVSÒ"G¶W66T‡FÖÂ‡W'6öâæ¦ö%F—FÆRÇÂ‡W'6öâç&öÆRÓÓÒvFÖ–âròtFÖ–æ—7G&F÷"r¢t&Vö&6‡FW"r’—Ò#ãÂöÆ&VÃãÆÆ&VÃå§Vw&–fg6V&VæSÇ6VÆV7B–CÒ'W6W%&öÆR#ãÆ÷F–öâfÇVSÒ'f–WvW"#ä&VçWG¦W#Âö÷F–öããÆ÷F–öâfÇVSÒ&FÖ–â"G·W'6öâç&öÆRÓÓÒvFÖ–âròw6VÆV7FVBr¢rwÓäFÖ–æ—7G&F÷#Âö÷F–öããÂ÷6VÆV7CãÂöÆ&VÃãÆÆ&VÃä&W&V–6‚ò'FV–ÇVæsÆ–çWB–CÒ'W6W$FW'FÖVçB"fÇVSÒ"G¶W66T‡FÖÂ‡W'6öâæFW'FÖVçBÇÂrr—Ò#ãÂöÆ&VÃãÆÆ&VÃäRÔÖ–ÃÆ–çWB–CÒ'W6W$VÖ–Â"G—SÒ&VÖ–Â"fÇVSÒ"G¶W66T‡FÖÂ‡W'6öâæVÖ–ÂÇÂrr—Ò#ãÂöÆ&VÃãÆÆ&VÃåFVÆVföãÆ–çWB–CÒ'W6W%†öæR"G—SÒ'FVÂ"fÇVSÒ"G¶W66T‡FÖÂ‡W'6öâç†öæRÇÂrr—Ò#ãÂöÆ&VÃãÆÆ&VÃâG¶VF—F–æròuFV×÷,:G&W2æWVW277v÷'B†ÆVW"ÒVçfW,:FæFW'B’r¢uFV×÷,:G&W277v÷'B†Ö–æFW7FVç2¦V–6†Vâ’wÓÆ–çWB–CÒ'W6W%77v÷&B"G—SÒ'77v÷&B"WFö6ö×ÆWFSÒ&æWr×77v÷&B#ãÂöÆ&VÃãÆÆ&VÂ6Æ73Ò'v–FR6†V6´Æ&VÂ#ãÆ–çWB–CÒ&f÷&6U77v÷&D6†ævR"G—SÒ&6†V6¶&÷‚"G²VF—F–ærÇÂW'6öâæ×W7D6†ævU77v÷&Bòv6†V6¶VBr¢rwÓâ&V’FW"ì:F6‡7FVâæÖVÆGVærV–âæWVW277v÷'BfW&ÆævVãÂöÆ&VÃâG·W'6öâæÆö6¶VBòÆF—b6Æ73Ò&66÷VçDÆö6¶VBv–FR#ãÇ7G&öæsä¶öçFòæ6‚G´çVÖ&W"‡W'6öâæf–ÆVDÆöv–äGFV×G2’ÇÂwÒfV†ÇfW'7V6†VâvW7W''CÂ÷7G&öæsãÇ7ãâG·W'6öâæÆö6¶VDBòæWrFFR‡W'6öâæÆö6¶VDB’çFôÆö6ÆU7G&–ær‚vFRÔDRr’¢rwÓÂ÷7ããÂöF—cæ¢rwÓÆÆ&VÂ6Æ73Ò'v–FR#å§W6G¦–æf÷&ÖF–öæVãÇFW‡F&V–CÒ'W6W$æ÷FW2#âG¶W66T‡FÖÂ‡W'6öâææ÷FW2ÇÂrr—ÓÂ÷FW‡F&VãÂöÆ&VÃãÆF—b6Æ73Ò'W&Ö—76–öäw&–Bv–FR#ãÇ7G&öæsäÖöGVÃÂ÷7G&öæsãÇ7G&öæsäÆW6VãÂ÷7G&öæsãÇ7G&öæså66‡&V–&VãÂ÷7G&öæsâG¶ÖöGVÆW2æÖ†ÖöGVÆRÓâÇ7ãâG¶ÖöGVÆWÓÂ÷7ããÆ–çWBG—SÒ&6†V6¶&÷‚"FF×W&ÓÒ"G¶ÖöGVÆWÒ"FFÖ7F–öãÒ'&VB"G·W&Ö—76–öç5¶ÖöGVÆUÓòç&VBòv6†V6¶VBr¢rwÓãÆ–çWBG—SÒ&6†V6¶&÷‚"FF×W&ÓÒ"G¶ÖöGVÆWÒ"FFÖ7F–öãÒ'w&—FR"G·W&Ö—76–öç5¶ÖöGVÆUÓòçw&—FRòv6†V6¶VBr¢rwÓæ’æ¦ö–â‚rr—ÓÂöF—cãÇ6Æ73Ò&×WFVBv–FR#î(	åW6W"b&V6‡F^(	ÂVæB(	äV–ç7FVÆÇVævVî(	Â6–æBW766†Æ–\9öÆ–6‚l;Ç"FÖ–æ—7G&F÷&VâfW&l;Æv&"ãÂ÷ãÂöF—cæ°¢6öç7B6fRÒ7–æ2‡VæÆö6²ÒfÇ6R’Óâ²G'’²6öç7BWFFVEW&Ö—76–öç2Ò·Ó²BB‚u¶FF×W&ÕÒr’æf÷$V6‚†–çWBÓâ²WFFVEW&Ö—76–öç5¶–çWBæFF6WBçW&ÕÒÇÃÒ·Ó²WFFVEW&Ö—76–öç5¶–çWBæFF6WBçW&ÕÕ¶–çWBæFF6WBæ7F–öåÒÒ–çWBæ6†V6¶VC²Ò“²v—B’‚rö’÷W6W'2rÂ²ÖWF†öC¢uUBrÂ&öG“¢²–C¢VF—F–æròW6W"æ–B¢VæFVf–æVBÂW6W&æÖS¢B‚r7W6W$æÖRr’çfÇVRÂF—7Æ”æÖS¢B‚r6F—7Æ”æÖRr’çfÇVRÂ77v÷&C¢B‚r7W6W%77v÷&Br’çfÇVRÂf÷&6U77v÷&D6†ævS¢B‚r6f÷&6U77v÷&D6†ævRr’æ6†V6¶VBÂVæÆö6²Â&öÆS¢B‚r7W6W%&öÆRr’çfÇVRÂ¦ö%F—FÆS¢B‚r6¦ö%F—FÆRr’çfÇVRÂFW'FÖVçC¢B‚r7W6W$FW'FÖVçBr’çfÇVRÂVÖ–Ã¢B‚r7W6W$VÖ–Âr’çfÇVRÂ†öæS¢B‚r7W6W%†öæRr’çfÇVRÂæ÷FW3¢B‚r7W6W$æ÷FW2r’çfÇVRÂW&Ö—76–öç3¢WFFVEW&Ö—76–öç2ÒÒ“²6Æ÷6TÖöFÂ‚“²v—BÆöEW6W'2‚“²Fö7B‡VæÆö6²òt&VçWG¦W&¶öçFòVçG7W''Br¢6÷––æròuW'6öâ¶÷–W'BVæBvW7V–6†W'Br¢uW'6öâvW7V–6†W'Br“²Ò6F6‚†W'&÷"’²Fö7B†W'&÷"æÖW76vRÂG'VR“²ÒÓ°¢6öç7B7F–öç2Ò·²Æ&VÃ¢t&'&V6†VârÂ6Æ–6³¢6Æ÷6TÖöFÂÕÓ°¢–b†VF—F–ær’7F–öç2çW6‚‡²Æ&VÃ¢uW'6öâ¶÷–W&VârÂ6Æ–6³¢‚’Óâ6†÷uW6W$F–Æör‡W6W"Â²6÷“¢G'VRÒ’Ò“°¢–b†VF—F–ærbbW'6öâæÆö6¶VB’7F–öç2çW6‚‡²Æ&VÃ¢t¶öçFòVçG7W'&VârÂ6Æ–6³¢‚’Óâ6fR‡G'VR’Ò“°¢7F–öç2çW6‚‡²Æ&VÃ¢6÷––æròt¶÷–R7V–6†W&âr¢u7V–6†W&ârÂ&–Ö'“¢G'VRÂ6Æ–6³¢‚’Óâ6fR†fÇ6R’Ò“°¢ÖöFÂ†6÷––æròuW'6öâ¶÷–W&Vâr¢VF—F–æròuW'6öâ&V&&V—FVâr¢uW'6öâæÆVvVârÂ&öG’Â7F–öç2“°¢BB‚u¶FF×W&ÕÕ¶FFÖ7F–öãÒ'w&—FR%Òr’æf÷$V6‚†–çWBÓâ–çWBæFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ°¢–b†–çWBæ6†V6¶VB’B†¶FF×W&ÓÒ"G¶–çWBæFF6WBçW&×Ò%Õ¶FFÖ7F–öãÒ'&VB%Ö’æ6†V6¶VBÒG'VS°¢Ò’“°¢BB‚u¶FF×W&ÕÕ¶FFÖ7F–öãÒ'&VB%Òr’æf÷$V6‚†–çWBÓâ–çWBæFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ°¢–b‚–çWBæ6†V6¶VB’B†¶FF×W&ÓÒ"G¶–çWBæFF6WBçW&×Ò%Õ¶FFÖ7F–öãÒ'w&—FR%Ö’æ6†V6¶VBÒfÇ6S°¢Ò’“°§Ğ ¦gVæ7F–öâFEv–FvWB‡G—R’°¢6öç7BvRÒ7FFRçvW5·7FFRæVF—F÷%vUÓ°¢–b‚vR’&WGW&ã°¢6öç7B7W'fRÒ²v†VF–æt7W'fRrÂv‡‚uÒæ–æ6ÇVFW2‡G—R“°¢6öç7Bv–FvWBÒ²–C¢V–B‚’ÂG—RÂÆ&VÃ¢G—RÓÓÒvæÆörròtÖW77vW'Br¢G—RÓÓÒvF–v—FÂròu7FGW2r¢G—RÓÓÒv‡‚ròv‚Ç‚ÔF–w&ÖÒr¢t†V—¦·W'fRrÂ7FFT–C¢rrÂƒ¢ƒ²vRçv–FvWG2æÆVæwF‚¢"Â“¢ƒ²vRçv–FvWG2æÆVæwF‚¢"Âv–GFƒ¢7W'fRò3#¢CÂVæ—C¢rrÂFV6–ÖÇ3¢"Ó°¢–b†7W'fR’v–FvWBçö–çG2ÒG—RÓÓÒv‡‚rò·²ƒ¢ã‚Â“¢ã‚ÒÂ²ƒ¢ã2Â“¢ã3RÒÂ²ƒ¢ãSRÂ“¢ãS‚ÒÂ²ƒ¢ãs‚Â“¢ãsRÒÂ²ƒ¢ã“"Â“¢ãƒbÕÒ¢·²ƒ¢ã‚Â“¢ã"ÒÂ²ƒ¢ã3RÂ“¢ã3‚ÒÂ²ƒ¢ãcRÂ“¢ãcBÒÂ²ƒ¢ã“"Â“¢ãƒ"ÕÓ°¢vRçv–FvWG2çW6‚‡v–FvWB“°¢7FFRç6VÆV7FVEv–FvWBÒv–FvWBæ–C°¢&VæFW$VF—F÷"‚“°§Ğ ¦gVæ7F–öâæWuvR‚’°¢6öç7BæÖRÒ&ö×B‚tæÖRFW2æWVVâæÆvVæ&–ÆFW3¢rÂæÆvVæ&–ÆBG·7FFRçvW2æÆVæwF‚²Ö“°¢–b‚æÖR’&WGW&ã°¢7FFRçvW2çW6‚‡²–C¢V–B‚’ÂæÖRÂv–GFƒ¢cÂ†V–v‡C¢“Â&6¶w&÷VæC¢rrÂv–FvWG3¢µÒÒ“°¢7FFRæVF—F÷%vRÒ7FFRçvW2æÆVæwF‚Ò°¢f–ÆÅvU6VÆV7G2‚“°¢B‚r6VF—F÷%vU6VÆV7Br’çfÇVRÒ7G&–ær‡7FFRæVF—F÷%vR“°¢&VæFW$VF—F÷"‚“°§Ğ ¦7–æ2gVæ7F–öâ6fUvW2‚’°¢G'’²7FFRçvW2Òv—B’‚rö’÷vW2rÂ²ÖWF†öC¢uUBrÂ&öG“¢7FFRçvW2Ò“²f–ÆÅvU6VÆV7G2‚“²Fö7B‚tæÆvVæ&–ÆFW"vW7V–6†W'Br“²Ò6F6‚†W'&÷"’²Fö7B†W'&÷"æÖW76vRÂG'VR“²Ğ§Ğ ¦gVæ7F–öâWÆöD&6¶w&÷VæB†f–ÆR’°¢–b‚f–ÆR’&WGW&ã°¢–b†f–ÆRç6—¦Râ‚¢#B¢#B’&WGW&âFö7B‚tF2&–ÆBF&bÖ†–ÖÂ‚Ô"w&ü9ò6V–ârÂG'VR“°¢6öç7B&VFW"ÒæWrf–ÆU&VFW"‚“°¢&VFW"æöæÆöBÒ‚’Óâ²7FFRçvW5·7FFRæVF—F÷%vUÒæ&6¶w&÷VæBÒ&VFW"ç&W7VÇC²&VæFW$VF—F÷"‚“²Ó°¢&VFW"ç&VD4FFU$Â†f–ÆR“°§Ğ ¦gVæ7F–öâ7FFU6V&6…6WGW‚’°¢ÆWBF–ÖW#°¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"‚v–çWBrÂWfVçBÓâ°¢6öç7B–çWBÒWfVçBçF&vWBæ6Æ÷6W7Còâ‚v–çWE¶Æ—7CÒ'7FFT÷F–öç2%Òr“°¢–b‚–çWB’&WGW&ã°¢6ÆV%F–ÖV÷WB‡F–ÖW"“°¢–b†–çWBçfÇVRæÆVæwF‚Â"’&WGW&ã°¢F–ÖW"Ò6WEF–ÖV÷WB†7–æ2‚’Óâ²G'’²6öç7B&÷w2Òv—B’†ö’÷7FFW3÷VW'“ÒG¶Væ6öFUU$”6ö×öæVçB†–çWBçfÇVR—Ö“²B‚r77FFT÷F–öç2r’æ–ææW$…DÔÂÒ&÷w2ç6Æ–6RƒÂƒ’æÖ‡&÷rÓâÆ÷F–öâfÇVSÒ"G¶W66T‡FÖÂ‡&÷ræ–B—Ò#âG¶W66T‡FÖÂ‡&÷rææÖR—ÓÂö÷F–öãæ’æ¦ö–â‚rr“²Ò6F6‚²ò¢6–ÆVçFÇ’¶VW7W'&VçB÷F–öç2¢òÒÒÂ3S“°¢Ò“°§Ğ ¦gVæ7F–öâ6WDFVfVÇDFFW2‚’°¢6öç7Bæ÷rÒFFRææ÷r‚’ÂF’ÒƒcC°¢B‚r7G&VæDVæBr’çfÇVRÒFFUF–ÖUfÇVR†æ÷r“°¢B‚r7G&VæE7F'Br’çfÇVRÒFFUF–ÖUfÇVR†æ÷rÒF’“°¢B‚r6VæW&w”VæBr’çfÇVRÒæWrFFR‚’çFô•4õ7G&–ær‚’ç6Æ–6RƒÂ“°¢B‚r6VæW&w•7F'Br’çfÇVRÒæWrFFR†æ÷rÒ3¢F’’çFô•4õ7G&–ær‚’ç6Æ–6RƒÂ“°§Ğ ¢B‚r6ÖVçUFövvÆRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’ÓâFövvÆTÖVçR‚’“°¢B‚r6æ÷F–f–6F–öä'WGFöâr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ°¢6öç7B÷VâÒB‚r6æ÷F–f–6F–öåG&’r’æ6Æ74Æ—7BçFövvÆR‚v÷Vâr“°¢B‚r6æ÷F–f–6F–öä'WGFöâr’ç6WDGG&–'WFR‚v&–ÖW‡æFVBrÂ7G&–ær†÷Vâ’“°§Ò“°¢B‚r66Æ÷6Tæ÷F–f–6F–öç2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ°¢B‚r6æ÷F–f–6F–öåG&’r’æ6Æ74Æ—7Bç&VÖ÷fR‚v÷Vâr“°¢B‚r6æ÷F–f–6F–öä'WGFöâr’ç6WDGG&–'WFR‚v&–ÖW‡æFVBrÂvfÇ6Rr“°§Ò“°¢B‚r6æf–vF–öâr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²6öç7B'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚v'WGFöå¶FF×f–WuÒr“²–b†'WGFöâ’6†÷uf–Wr†'WGFöâæFF6WBçf–Wr“²Ò“°¢B‚r6Æöv–ä'WGFöâr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ6†÷t66÷VçDF–Æör“°¢B‚r7&Vg&W6„Æ&×2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂÆöDÆ&×2“°¢B‚r6FDÆ&Òr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ6†÷tFDÆ&Ò“°¢B‚r6ÆöEG&VæBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂÆöEG&VæB“°¢B‚r6FEG&VæE7FFW2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uG&VæE7FFU–6¶W"‚’æ6F6‚†W'&÷"ÓâFö7B†W'&÷"æÖW76vRÇG'VR’’“°¢B‚r7G&VæEG—Rr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ&VæFW$7W'&VçEG&VæB“°¢B‚r7G&VæE&W6öÇWF–öâr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ7FFRçG&VæE6W&–W2æÆVæwF‚bbÆöEG&VæB‚’“°¢B‚r7G&VæDÖ–âr’æFDWfVçDÆ—7FVæW"‚v–çWBrÂ&VæFW$7W'&VçEG&VæB“°¢B‚r7G&VæDÖ‚r’æFDWfVçDÆ—7FVæW"‚v–çWBrÂ&VæFW$7W'&VçEG&VæB“°¢B‚r7G&VæE6÷W&6Rr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂ‚’Óâ7FFRçG&VæE6W&–W2æÆVæwF‚bbÆöEG&VæB‚’“°¢B‚r7G&VæEW&–öBr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂWfVçBÓâ²–b†WfVçBçF&vWBçfÇVRÓÓÒv7W7FöÒr’&WGW&ã²6öç7BVæBÒFFRææ÷r‚“²B‚r7G&VæDVæBr’çfÇVRÒFFUF–ÖUfÇVR†VæB“²B‚r7G&VæE7F'Br’çfÇVRÒFFUF–ÖUfÇVR†VæBÔçVÖ&W"†WfVçBçF&vWBçfÇVR’£3c“²–b‡7FFRçG&VæE6W&–W2æÆVæwF‚’ÆöEG&VæB‚“²Ò“°¢B‚r7G&VæDÆVvVæBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²6öç7B6öÆ÷$'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FFÖ÷Vâ×G&VæBÖ6öÆ÷'5Òr“²–b†6öÆ÷$'WGFöâ’&WGW&â÷VåG&VæD6öÆ÷%ÆWGFR†6öÆ÷$'WGFöâæFF6WBæ÷VåG&VæD6öÆ÷'2Æ6öÆ÷$'WGFöâ“²6öç7B'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FF×&VÖ÷fR×G&VæEÒr“²–b‚'WGFöâ’&WGW&ã²7FFRçG&VæE6W&–W2Ò7FFRçG&VæE6W&–W2æf–ÇFW"†—FVÒÓâ—FVÒæ–BÓÒ'WGFöâæFF6WBç&VÖ÷fUG&VæB“²7FFRçG&VæDFFÒ7FFRçG&VæDFFæf–ÇFW"†—FVÒÓâ—FVÒæ–BÓÒ'WGFöâæFF6WBç&VÖ÷fUG&VæB“²&VæFW$7W'&VçEG&VæB‚“²Ò“°¢B‚r7G&VæDÆVvVæBr’æFDWfVçDÆ—7FVæW"‚wö–çFW&Ö÷fRrÂWfVçBÓâ²6öç7B—FVÒÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FF×G&VæBÖ–æfõÒr“²–b‚—FVÒ’&WGW&ã²6öç7B6W&–W2Ò7FFRçG&VæE6W&–W2æf–æB†VçG'’ÓâVçG'’æ–BÓÓÒ—FVÒæFF6WBçG&VæD–æfò’ÂFF6WBÒ7FFRçG&VæDFFæf–æB†VçG'’ÓâVçG'’æ–BÓÓÒ—FVÒæFF6WBçG&VæD–æfò’ÂÆFW7BÒFF6WCòçfÇVW3òæB‚Ó“²–b‚6W&–W2’&WGW&ã²6öç7BFööÇF—ÒB‚r7FööÇF—r“²FööÇF—æ–ææW$…DÔÂÒÇ7G&öæsâG¶W66T‡FÖÂ‡6W&–W2ææÖRÇÂ6W&–W2æ–B—ÓÂ÷7G&öæsãÆ'#äEÔG&W76S¢G¶W66T‡FÖÂ‡6W&–W2æ–B—ÓÆ'#äV–æ†V—C¢G¶W66T‡FÖÂ‡6W&–W2çVæ—BÇÂ~(	Br—ÓÆ'#åVVÆÆS¢G¶W66T‡FÖÂ‚B‚r7G&VæE6÷W&6Rr’çfÇVRÇÂ~(	Br—ÓÆ'#äVfÌ;g7Væs¢G¶W66T‡FÖÂ‚B‚r7G&VæE&W6öÇWF–öâr’ç6VÆV7FVD÷F–öç5³ÒçFW‡D6öçFVçB—ÒG¶ÆFW7BòÆ'#äÆWG§FW"vW'C¢G¶çVÖ&W"†ÆFW7BçfÂÃB—ÒG¶W66T‡FÖÂ‡6W&–W2çVæ—BÇÂrr—ÓÆ'#âG¶æWrFFR†ÆFW7BçG2’çFôÆö6ÆU7G&–ær‚vFRÔDRr—Ö¢rwÖ²FööÇF—ç7G–ÆRæÆVgBÒG¶WfVçBæ6Æ–VçE‚³'×†²FööÇF—ç7G–ÆRçF÷ÒG¶WfVçBæ6Æ–VçE’³'×†²FööÇF—ç7G–ÆRæF—7Æ’Òv&Æö6²s²Ò“°¢B‚r7G&VæDÆVvVæBr’æFDWfVçDÆ—7FVæW"‚wö–çFW&ÆVfRrÂ‚’ÓâB‚r7FööÇF—r’ç7G–ÆRæF—7Æ’ÒvæöæRr“°¢B‚r7G&VæD6öÆ÷%ÆWGFRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²6öç7B'WGFöâÒWfVçBçF&vWBæ6Æ÷6W7B‚u¶FF×ÆWGFRÖ6öÆ÷%Òr“²–b‚'WGFöâ’&WGW&ã²6öç7B–BÒB‚r7G&VæD6öÆ÷%ÆWGFRr’æFF6WBç6W&–W4–BÂ6öÆ÷"Ò'WGFöâæFF6WBçÆWGFT6öÆ÷"Â6W&–W2Ò7FFRçG&VæE6W&–W2æf–æB†—FVÒÓâ—FVÒæ–BÓÓÒ–B“²–b‡6W&–W2’6W&–W2æ6öÆ÷"Ò6öÆ÷#²7FFRçG&VæDFFÒ7FFRçG&VæDFFæÖ†FF6WBÓâFF6WBæ–BÓÓÒ–Bò²ââæFF6WBÂ6öÆ÷"Ò¢FF6WB“²B‚r7G&VæD6öÆ÷%ÆWGFRr’æ†–FFVâÒG'VS²&VæFW$7W'&VçEG&VæB‚“²Ò“°¢B‚r6W‡÷'EG&VæEFbr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂW‡÷'EG&VæEFb“°¢B‚r6F6†&ö&DVF—Br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²7FFRæF6†&ö&DVF—CÒ7FFRæF6†&ö&DVF—C²WfVçBæ7W'&VçEF&vWBçFW‡D6öçFVçC×7FFRæF6†&ö&DVF—Còt&V&&V—GVær&VVæFVâs¢t&V&&V—FVâs²WfVçBæ7W'&VçEF&vWBç6WDGG&–'WFR‚v&–×&W76VBrÅ7G&–ær‡7FFRæF6†&ö&DVF—B’“²B‚r6F6†&ö&DFBr’æ†–FFVãÒ7FFRæF6†&ö&DVF—C²&VæFW$F6†&ö&B‚“²Ò“°¢B‚r6F6†&ö&DFBr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷tF6†&ö&DF–Æör‚’“°¢B‚r6F6†&ö&E&Vg&W6‚r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ&Vg&W6„F6†&ö&B“°¢B‚r67&VFU&W÷'Br’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7&VFU&W÷'B“°¢B‚r6æWuW6W"r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uW6W$F–Æör‚’“°¢B‚r76WGF–æw4föçBr’æFDWfVçDÆ—7FVæW"‚v6†ævRrÂWfVçBÓâÇ”föçB†WfVçBçF&vWBçfÇVR’“°¢B‚r76fUV•6WGF–æw2r’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ7–æ2‚’Óâ²G'’²6öç7B&tFÖ–åW&ÂÒB‚r76WGF–æw4–ô'&ö¶W%W&Âr’çfÇVRçG&–Ò‚’Â–ô'&ö¶W$FÖ–åW&ÂÒ&tFÖ–åW&Âò6fUf—5W&Â‡&tFÖ–åW&Â’¢rs²–b‡&tFÖ–åW&Âbb–ô'&ö¶W$FÖ–åW&Â’F‡&÷ræWrW'&÷"‚t&—GFRV–æR|;ÆÇF–vR–ô'&ö¶W"ÔG&W76RV–ævV&Vâr“²6öç7B6WGF–æw2Òv—B’‚rö’÷6WGF–æw2rÂ²ÖWF†öC¢uUBrÂ&öG“¢²6—FTæÖS¢B‚r76WGF–æw56—FTæÖRr’çfÇVRÂföçDfÖ–Ç“¢B‚r76WGF–æw4föçBr’çfÇVRÂWFôÆövöfdÖ–çWFW3¢çVÖ&W"‚B‚r76WGF–æw4WFôÆövöfbr’çfÇVR’Â–ô'&ö¶W$FÖ–åW&ÂÒÒ“²7FFRæ&ö÷G7G&ç6WGF–æw2Ò6WGF–æw3²B‚r76WGF–æw4–ô'&ö¶W%W&Âr’çfÇVRÒ6WGF–æw2æ–ô'&ö¶W$FÖ–åW&ÂÇÂrs²B‚r6†VFW%6—FTæÖRr’çFW‡D6öçFVçBÒ6WGF–æw2ç6—FTæÖS²Ç”föçB‡6WGF–æw2æföçDfÖ–Ç’“²&W6WDWFôÆöv÷WB‚“²Fö7B‚tö&W&fÌ:F6†VæV–ç7FVÆÇVævVâvW7V–6†W'Br“²Ò6F6‚†W'&÷"’²Fö7B†W'&÷"æÖW76vRÇG'VR“²ÒÒ“°¢B‚r6ÖævUÆçEG&VRr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂ‚’Óâ6†÷uG&VTæöFTF–Æör‚’“°¢B‚r6ÖöFÂr’æFDWfVçDÆ—7FVæW"‚v6Æ–6²rÂWfVçBÓâ²–b†WfVçBçF&vWBÓÓÒB‚r6ÖöFÂr’’6Æ÷6TÖöFÂ‚“²Ò“°¥²wö–çFW&F÷vârÂv¶W–F÷vârÂwF÷V6‡7F'BuÒæf÷$V6‚†WfVçDæÖRÓâFö7VÖVçBæFDWfVçDÆ—7FVæW"†WfVçDæÖRÂ&W6WDWFôÆöv÷WBÂ²76—fS¢G'VRÒ’“°§6WDFVfVÇDFFW2‚“°§6WD–çFW'fÂ‚‚’ÓâB‚r66Æö6²r’çFW‡D6öçFVçBÒæWrFFR‚’çFôÆö6ÆU7G&–ær‚vFRÔDRr’Â“°§6WD–çFW'fÂ‚‚’Óâ²–b‡7FFRæ7W'&VçEf–WrÓÓÒvF6†&ö&Br’&Vg&W6„F6†&ö&B‚’æ6F6‚‚‚’Óâ·Ò“²–b‡7FFRæ7W'&VçEf–WrÓÓÒvÆ&×2r’ÆöDÆ&×2‚’æ6F6‚‚‚’Óâ·Ò“²–b‡7FFRæ7W'&VçEf–WrÓÓÒwf—7VÆ—¦F–öâr’&VæFW$Æ—fUvR‚’æ6F6‚‚‚’Óâ·Ò“²–b‡7FFRæ7W'&VçEf–WrÓÓÒwG&VæG2rbbB‚r7G&VæDÆ—fRr’çfÇVRÓÓÒvÆ—fRrbb7FFRçG&VæE6W&–W2æÆVæwF‚’ÆöEG&VæB‚’æ6F6‚‚‚’Óâ·Ò“²ÒÂS“°¦&ö÷G7G&‚’æ6F6‚†W'&÷"Óâ²B‚r66öææV7F–öäF÷Br’æ6Æ74Æ—7Bç&VÖ÷fR‚vö²r“²Fö7B†fW&&–æGVærfV†ÆvW66†ÆvVã¢G¶W'&÷"æÖW76vWÖÂG'VR“²Ò“°