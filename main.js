'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const express = require('express');
const utils = require('@iobroker/adapter-core');
const packageJson = require('./package.json');
const { MODULES, hashPassword, verifyPassword, defaultPermissions, can } = require('./lib/security');
const { calculateEnergyReport } = require('./lib/energy');

class IotGltAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'iot-glt' });
    this.server = null;
    this.sessions = new Map();
    this.model = null;
    this.dataDir = utils.getAbsoluteInstanceDataDir(this);
    this.modelPath = path.join(this.dataDir, 'iot-glt-model.json');
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    this.model = await this.loadModel();
    await this.setStateAsync('info.connection', false, true);
    this.startWebServer();
  }

  async onUnload(callback) {
    try {
      if (this.server) await new Promise(resolve => this.server.close(resolve));
      await this.setStateAsync('info.connection', false, true);
      callback();
    } catch {
      callback();
    }
  }

  async loadModel() {
    let stored = {};
    let loadedFromFile = false;
    try { stored = JSON.parse(await fs.readFile(this.modelPath, 'utf8')); loadedFromFile = true; }
    catch {
      try { stored = JSON.parse(await fs.readFile(`${this.modelPath}.bak`, 'utf8')); loadedFromFile = true; this.log.warn('Recovered IOT GLT configuration from the local backup file.'); }
      catch {
      const state = await this.getStateAsync('data.config');
      try { const legacy = JSON.parse(state?.val || '{}'); if (!legacy.storage) stored = legacy; }
      catch { this.log.warn('Stored GLT configuration was invalid and has been reset.'); }
      }
    }
    const defaults = {
      users: [{
        id: 'admin', username: 'admin', displayName: 'Administrator', role: 'admin',
        passwordHash: hashPassword('iot-glt'), mustChangePassword: true,
        permissions: defaultPermissions('admin')
      }],
      pages: [{ id: 'overview', name: 'Übersicht', width: 1600, height: 900, background: '', widgets: [] }],
      navigationTree: [
        { id: 'site', parentId: '', label: 'THA', icon: 'folder', url: '' },
        { id: 'building-a', parentId: 'site', label: 'Gebäude A', icon: 'building', url: '' },
        { id: 'general', parentId: 'building-a', label: 'Allgemein', icon: 'systems', url: '' },
        { id: 'ahu-01', parentId: 'general', label: 'Lüftungsanlage AHU-01', icon: 'ventilation', url: '/vis-2/index.html?project=main#AHU-01' },
        { id: 'heating-north', parentId: 'general', label: 'Heizkreis Nord', icon: 'heating', url: '/vis-2/index.html?project=main#Heizkreis-Nord' },
        { id: 'temperatures', parentId: 'general', label: 'Temperaturen', icon: 'temperature', url: '/vis-2/index.html?project=main#Temperaturen' },
        { id: 'main-meter', parentId: 'building-a', label: 'Hauptzähler', icon: 'electric', url: '/vis-2/index.html?project=main#Hauptzaehler' },
        { id: 'pv', parentId: 'building-a', label: 'PV-Anlage', icon: 'solar', url: '/vis-2/index.html?project=main#PV-Anlage' },
        { id: 'water', parentId: 'building-a', label: 'Wasserzähler', icon: 'water', url: '/vis-2/index.html?project=main#Wasserzaehler' },
        { id: 'heat-meter', parentId: 'building-a', label: 'Wärmemengenzähler', icon: 'heatmeter', url: '/vis-2/index.html?project=main#Waermemenge' }
      ],
      dashboardWidgets: [{ id: 'adapter-connection', title: 'IOT GLT Verbindung', stateId: `${this.namespace}.info.connection`, unit: '', type: 'value', period: 1, min: 0, max: 1, cols: 3, rows: 3 }],
      alarmDefinitions: [],
      reports: [],
      settings: { siteName: 'Gebäude Zentrale', accent: '#fe6e00', fontFamily: 'apple', theme: 'light', autoLogoffMinutes: 30, ioBrokerAdminUrl: '' }
    };
    const model = { ...defaults, ...stored };
    model.users = Array.isArray(model.users) && model.users.length ? model.users : defaults.users;
    model.users.forEach(user => {
      if (user.role === 'admin') user.permissions = defaultPermissions('admin');
      else {
        const requested = user.permissions || {};
        user.permissions = Object.fromEntries(MODULES.map(module => {
          if (['users', 'iobroker', 'settings'].includes(module)) return [module, { read: false, write: false }];
          const write = Boolean(requested[module]?.write);
          return [module, { read: write || Boolean(requested[module]?.read), write }];
        }));
      }
      user.failedLoginAttempts = Number(user.failedLoginAttempts) || 0;
      user.locked = Boolean(user.locked);
      user.lockedUntil = Number(user.lockedUntil) || null;
      user.lastLoginAt = Number(user.lastLoginAt) || null;
      user.lastSeenAt = Number(user.lastSeenAt) || null;
      user.loginCount = Number(user.loginCount) || 0;
      if (Array.isArray(user.allowedNavigationIds)) user.allowedNavigationIds = [...new Set(user.allowedNavigationIds.map(String))];
    });
    model.pages = Array.isArray(model.pages) && model.pages.length ? model.pages : defaults.pages;
    model.navigationTree = Array.isArray(model.navigationTree) && model.navigationTree.length ? model.navigationTree : defaults.navigationTree;
    model.dashboardWidgets = Array.isArray(model.dashboardWidgets) ? model.dashboardWidgets : [];
    model.alarmDefinitions = Array.isArray(model.alarmDefinitions) ? model.alarmDefinitions : [];
    model.reports = Array.isArray(model.reports) ? model.reports : [];
    model.settings = { ...defaults.settings, ...(model.settings || {}) };
    if (!model.settings.accent || model.settings.accent === '#1fd1a5') model.settings.accent = '#fe6e00';
    if (!stored.users) {
      this.log.warn('Initial login: admin / iot-glt. Change this password immediately after login.');
      await this.saveModel(model);
    } else if (!loadedFromFile) {
      this.log.info('Migrating IOT GLT configuration into the local instance data directory.');
      await this.saveModel(model);
    }
    return model;
  }

  async saveModel(model = this.model) {
    await fs.mkdir(this.dataDir, { recursive: true });
    try { await fs.copyFile(this.modelPath, `${this.modelPath}.bak`); } catch { /* first save has no backup yet */ }
    await fs.writeFile(this.modelPath, JSON.stringify(model, null, 2), { encoding: 'utf8', mode: 0o600 });
    await this.setStateAsync('data.config', JSON.stringify({ storage: 'local-file', file: 'iot-glt-model.json', updatedAt: Date.now() }), true);
  }

  sessionUser(req) {
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
    const session = this.sessions.get(cookies.iotglt_session);
    if (!session || session.expires < Date.now()) return null;
    session.expires = Date.now() + Math.max(5, Number(this.model.settings.autoLogoffMinutes) || 30) * 60000;
    const user = this.model.users.find(item => item.id === session.userId);
    if (!user || user.locked) return null;
    if (!user.lastSeenAt || Date.now() - user.lastSeenAt > 60000) {
      user.lastSeenAt = Date.now();
      this.saveModel().catch(error => this.log.warn(`Could not persist user activity: ${error.message}`));
    }
    return { ...user, passwordHash: undefined, csrf: session.csrf };
  }

  publicUser() {
    if (!this.config.defaultReadOnly) return null;
    return { id: 'public', username: 'Gast', displayName: 'Gast', role: 'viewer', permissions: defaultPermissions('viewer') };
  }

  requirePermission(module, action = 'read', allowMustChange = false) {
    return (req, res, next) => {
      const user = req.gltUser;
      if (user?.mustChangePassword && !allowMustChange) return res.status(428).json({ error: 'Vor der weiteren Nutzung muss das Passwort geändert werden' });
      if (['users', 'iobroker', 'settings'].includes(module) && user?.role !== 'admin') return res.status(403).json({ error: 'Dieser Bereich ist ausschließlich für Administratoren freigegeben' });
      if (!can(user, module, action)) return res.status(user ? 403 : 401).json({ error: 'Keine Berechtigung' });
      if (action === 'write' && user.id !== 'public' && req.headers['x-csrf-token'] !== user.csrf) {
        return res.status(403).json({ error: 'Ungültiges Sicherheitstoken' });
      }
      next();
    };
  }

  requireAnyPermission(modules, action = 'read') {
    return (req, res, next) => {
      const user = req.gltUser;
      if (user?.mustChangePassword) return res.status(428).json({ error: 'Vor der weiteren Nutzung muss das Passwort geändert werden' });
      if (!modules.some(module => can(user, module, action))) return res.status(user ? 403 : 401).json({ error: 'Keine Berechtigung' });
      if (action === 'write' && user.id !== 'public' && req.headers['x-csrf-token'] !== user.csrf) return res.status(403).json({ error: 'Ungültiges Sicherheitstoken' });
      next();
    };
  }

  requireAuthenticated(allowMustChange = false) {
    return (req, res, next) => {
      const user = req.gltUser;
      if (!user || user.id === 'public') return res.status(401).json({ error: 'Anmeldung erforderlich' });
      if (user.mustChangePassword && !allowMustChange) return res.status(428).json({ error: 'Vor der weiteren Nutzung muss das Passwort geändert werden' });
      next();
    };
  }

  cleanUser(user) {
    const { passwordHash, ...safe } = user;
    return safe;
  }

  navigationForUser(user) {
    const tree = this.model.navigationTree || [];
    if (!user || user.role === 'admin' || !Array.isArray(user.allowedNavigationIds)) return tree;
    const visible = new Set(user.allowedNavigationIds);
    const byId = new Map(tree.map(node => [node.id, node]));
    for (const id of [...visible]) {
      let parentId = byId.get(id)?.parentId;
      while (parentId && !visible.has(parentId)) {
        visible.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
    }
    return tree.filter(node => visible.has(node.id));
  }

  sendToPromise(instance, command, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Zeitüberschreitung bei ${instance}`)), 20000);
      this.sendTo(instance, command, message, response => {
        clearTimeout(timer);
        if (response?.error) reject(new Error(String(response.error)));
        else resolve(response);
      });
    });
  }

  async history(id, start, end, aggregate = 'none', count = 500, instance = this.config.historyInstance, step = 0) {
    if (!instance) throw new Error('Keine History-Instanz konfiguriert');
    const response = await this.sendToPromise(instance, 'getHistory', {
      id, options: { start, end, aggregate, count: Math.min(Number(count) || 500, 10000), addId: false, ...(step > 0 ? { step } : {}) }
    });
    return Array.isArray(response) ? response : response?.result || [];
  }

  evaluateAlarm(definition, state) {
    const value = state?.val;
    const target = definition.value;
    const active = ({
      eq: value == target,
      ne: value != target,
      gt: Number(value) > Number(target),
      gte: Number(value) >= Number(target),
      lt: Number(value) < Number(target),
      lte: Number(value) <= Number(target),
      truthy: Boolean(value)
    })[definition.operator || 'truthy'];
    return { ...definition, active: Boolean(active), currentValue: value, ts: state?.ts || null };
  }

  startWebServer() {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '12mb' }));
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self' http: https:");
      req.gltUser = this.sessionUser(req) || this.publicUser();
      const sessionToken = String(req.headers.cookie || '').match(/iotglt_session=([^;]+)/)?.[1];
      if (sessionToken && req.gltUser?.id && req.gltUser.id !== 'public') {
        const logoffMinutes = Math.max(5, Number(this.model.settings.autoLogoffMinutes) || 30);
        res.setHeader('Set-Cookie', `iotglt_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logoffMinutes * 60}`);
      }
      next();
    });

    app.get('/api/bootstrap', (req, res) => {
      const user = req.gltUser;
      res.json({
        user,
        loginRequired: !user,
        mustChangePassword: Boolean(user?.mustChangePassword),
        modules: user ? Object.fromEntries(MODULES.map(key => [key, ['users', 'iobroker', 'settings'].includes(key) ? user.role === 'admin' : (user.role === 'admin' || user.permissions?.[key]?.read)])) : {},
        pages: can(user, 'visualization') ? this.model.pages : [],
        navigationTree: can(user, 'visualization') ? this.navigationForUser(user) : [],
        dashboardWidgets: can(user, 'dashboard') ? this.model.dashboardWidgets : [],
        settings: this.model.settings,
        adapter: { name: this.name, instance: this.instance, version: packageJson.version, currency: this.config.currency || 'EUR', co2Factor: Number(this.config.co2Factor || 0.38), visBaseUrl: String(this.config.visBaseUrl || ''), historySources: [{ type: 'history', instance: this.config.historyInstance }, { type: 'influxdb', instance: this.config.influxInstance }].filter(source => source.instance) }
      });
    });

    app.post('/api/login', async (req, res, next) => {
      try {
      const username = String(req.body?.username || '').trim().toLowerCase();
      const user = this.model.users.find(item => item.username.toLowerCase() === username);
      if (user?.locked && user.lockedUntil && user.lockedUntil <= Date.now()) { user.locked = false; user.failedLoginAttempts = 0; user.lockedAt = null; user.lockedUntil = null; }
      if (user?.locked) return res.status(423).json({ error: 'Das Benutzerkonto ist gesperrt. Bitte den Administrator kontaktieren.' });
      if (!user || !verifyPassword(req.body?.password, user.passwordHash)) {
        if (user) {
          user.failedLoginAttempts = (Number(user.failedLoginAttempts) || 0) + 1;
          if (user.failedLoginAttempts >= 7) { user.locked = true; user.lockedAt = Date.now(); user.lockedUntil = Date.now() + 15 * 60000; }
          await this.saveModel();
        }
        return res.status(401).json({ error: user?.locked ? 'Das Benutzerkonto wurde nach 7 Fehlversuchen gesperrt' : 'Benutzername oder Passwort falsch' });
      }
      user.failedLoginAttempts = 0;
      user.locked = false;
      user.lockedAt = null;
      user.lockedUntil = null;
      user.lastLoginAt = Date.now();
      user.lastSeenAt = user.lastLoginAt;
      user.loginCount = (Number(user.loginCount) || 0) + 1;
      await this.saveModel();
      const token = crypto.randomBytes(32).toString('hex');
      const csrf = crypto.randomBytes(24).toString('hex');
      const logoffMinutes = Math.max(5, Number(this.model.settings.autoLogoffMinutes) || 30);
      this.sessions.set(token, { userId: user.id, csrf, expires: Date.now() + logoffMinutes * 60000 });
      res.setHeader('Set-Cookie', `iotglt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logoffMinutes * 60}`);
      res.json({ user: { ...this.cleanUser(user), csrf } });
      } catch (error) { next(error); }
    });

    app.post('/api/logout', (req, res) => {
      const token = String(req.headers.cookie || '').match(/iotglt_session=([^;]+)/)?.[1];
      if (token) this.sessions.delete(token);
      res.setHeader('Set-Cookie', 'iotglt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      res.json({ ok: true });
    });

    app.post('/api/session/keepalive', (req, res) => {
      if (!req.gltUser || req.gltUser.id === 'public') return res.status(401).json({ error: 'Sitzung abgelaufen' });
      res.json({ ok: true });
    });

    app.post('/api/change-password', this.requireAuthenticated(true), async (req, res) => {
      if (req.headers['x-csrf-token'] !== req.gltUser.csrf) return res.status(403).json({ error: 'Ungültiges Sicherheitstoken' });
      const user = this.model.users.find(item => item.id === req.gltUser.id);
      if (!user || !verifyPassword(req.body?.currentPassword, user.passwordHash)) return res.status(400).json({ error: 'Aktuelles Passwort ist falsch' });
      if (String(req.body?.newPassword || '').length < 10) return res.status(400).json({ error: 'Das neue Passwort muss mindestens 10 Zeichen haben' });
      user.passwordHash = hashPassword(req.body.newPassword);
      user.mustChangePassword = false;
      user.failedLoginAttempts = 0;
      user.locked = false;
      user.lockedAt = null;
      user.lockedUntil = null;
      await this.saveModel();
      res.json({ ok: true });
    });

    app.get('/api/states', this.requireAnyPermission(['dashboard', 'alarms', 'visualization', 'trends', 'energy', 'editor']), async (req, res, next) => {
      try {
        const query = String(req.query.query || '').toLowerCase();
        const objects = await this.getForeignObjectsAsync('*', 'state');
        const ids = Object.keys(objects).filter(id => !query || id.toLowerCase().includes(query) || String(objects[id]?.common?.name || '').toLowerCase().includes(query)).slice(0, 200);
        const states = await this.getForeignStatesAsync(ids);
        res.json(ids.map(id => ({ id, name: objects[id]?.common?.name || id, type: objects[id]?.common?.type, role: objects[id]?.common?.role, unit: objects[id]?.common?.unit || '', write: Boolean(objects[id]?.common?.write), val: states[id]?.val, ts: states[id]?.ts })));
      } catch (error) { next(error); }
    });

    app.get('/api/trend-states', this.requireAnyPermission(['trends', 'energy']), async (req, res, next) => {
      try {
        const query = String(req.query.query || '').toLowerCase();
        const objects = await this.getForeignObjectsAsync('*', 'state');
        const ids = Object.keys(objects).filter(id => {
          const object = objects[id];
          const numeric = object?.common?.type === 'number' || ['value', 'level', 'temperature', 'humidity', 'pressure', 'power', 'energy'].some(role => String(object?.common?.role || '').includes(role));
          return numeric && (!query || id.toLowerCase().includes(query) || String(object?.common?.name || '').toLowerCase().includes(query));
        }).slice(0, 300);
        res.json(ids.map(id => ({ id, name: objects[id]?.common?.name || id, unit: objects[id]?.common?.unit || '', role: objects[id]?.common?.role || '' })));
      } catch (error) { next(error); }
    });

    app.get('/api/visual-values', this.requireAnyPermission(['dashboard', 'visualization']), async (req, res, next) => {
      try {
        const allowed = new Set([
          ...(can(req.gltUser, 'visualization') ? this.model.pages.flatMap(page => (page.widgets || []).map(widget => widget.stateId)) : []),
          ...(can(req.gltUser, 'dashboard') ? this.model.dashboardWidgets.map(widget => widget.stateId || widget.dp) : [])
        ].filter(Boolean));
        const ids = String(req.query.ids || '').split(',').map(id => id.trim()).filter(id => allowed.has(id)).slice(0, 200);
        const objects = await Promise.all(ids.map(id => this.getForeignObjectAsync(id)));
        const states = ids.length ? await this.getForeignStatesAsync(ids) : {};
        res.json(ids.map((id, index) => ({ id, unit: objects[index]?.common?.unit || '', write: Boolean(objects[index]?.common?.write), val: states[id]?.val, ts: states[id]?.ts })));
      } catch (error) { next(error); }
    });

    app.get('/api/dashboard-states', this.requirePermission('dashboard', 'write'), async (req, res, next) => {
      try {
        const query = String(req.query.query || '').toLowerCase();
        const objects = await this.getForeignObjectsAsync('*', 'state');
        const ids = Object.keys(objects).filter(id => !query || id.toLowerCase().includes(query) || String(objects[id]?.common?.name || '').toLowerCase().includes(query)).slice(0, 250);
        res.json(ids.map(id => ({ id, name: objects[id]?.common?.name || id, unit: objects[id]?.common?.unit || '', type: objects[id]?.common?.type || '', role: objects[id]?.common?.role || '' })));
      } catch (error) { next(error); }
    });

    app.put('/api/dashboard', this.requirePermission('dashboard', 'write'), async (req, res, next) => {
      try {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Dashboard-Konfiguration muss eine Liste sein' });
        const types = new Set(['line', 'bar', 'heat', 'fill', 'gauge', 'table', 'value']);
        this.model.dashboardWidgets = req.body.slice(0, 100).map(item => ({
          id: String(item.id || crypto.randomUUID()).slice(0, 120), title: String(item.title || 'Datenpunkt').slice(0, 160), stateId: String(item.stateId || item.dp || '').slice(0, 512), unit: String(item.unit || '').slice(0, 40), type: types.has(item.type) ? item.type : 'line', period: Math.max(1, Math.min(8760, Number(item.period) || 24)), min: Number.isFinite(Number(item.min)) ? Number(item.min) : 0, max: Number.isFinite(Number(item.max)) ? Number(item.max) : 100, cols: Math.max(2, Math.min(12, Number(item.cols) || 4)), rows: Math.max(2, Math.min(8, Number(item.rows) || 3))
        })).filter(item => item.stateId);
        await this.saveModel();
        res.json(this.model.dashboardWidgets);
      } catch (error) { next(error); }
    });

    app.put('/api/state', this.requirePermission('visualization', 'write'), async (req, res, next) => {
      try {
        const id = String(req.body?.id || '');
        const object = await this.getForeignObjectAsync(id);
        if (!object || object.type !== 'state' || !object.common?.write) return res.status(400).json({ error: 'Datenpunkt ist nicht beschreibbar' });
        await this.setForeignStateAsync(id, req.body.value, false);
        res.json({ ok: true });
      } catch (error) { next(error); }
    });

    app.get('/api/history', this.requireAnyPermission(['dashboard', 'trends', 'energy']), async (req, res, next) => {
      try {
        const requestedId = String(req.query.id || '');
        if (!can(req.gltUser, 'trends') && !can(req.gltUser, 'energy') && !this.model.dashboardWidgets.some(widget => (widget.stateId || widget.dp) === requestedId)) return res.status(403).json({ error: 'Datenpunkt ist nicht für das Dashboard freigegeben' });
        const end = Number(req.query.end) || Date.now();
        const start = Number(req.query.start) || end - 86400000;
        const allowedSources = new Set([this.config.historyInstance, this.config.influxInstance].filter(Boolean));
        const source = String(req.query.source || this.config.historyInstance || this.config.influxInstance || '');
        if (!allowedSources.has(source)) return res.status(400).json({ error: 'Zeitreihenquelle ist nicht konfiguriert' });
        const resolutionSeconds = Math.max(0, Math.min(Number(req.query.resolution) || 0, 86400));
        const aggregate = resolutionSeconds > 0 ? 'average' : String(req.query.aggregate || 'none');
        res.json({ id: requestedId, source, resolutionSeconds, values: await this.history(requestedId, start, end, aggregate, Number(req.query.count || 2000), source, resolutionSeconds * 1000) });
      } catch (error) { next(error); }
    });

    app.get('/api/alarms', this.requirePermission('alarms'), async (req, res, next) => {
      try {
        const ids = this.model.alarmDefinitions.map(item => item.stateId);
        const states = ids.length ? await this.getForeignStatesAsync(ids) : {};
        res.json(this.model.alarmDefinitions.map(item => this.evaluateAlarm(item, states[item.stateId])));
      } catch (error) { next(error); }
    });

    app.put('/api/alarms', this.requirePermission('alarms', 'write'), async (req, res) => {
      this.model.alarmDefinitions = Array.isArray(req.body) ? req.body.slice(0, 500).map(item => ({
        id: item.id || crypto.randomUUID(), name: String(item.name || 'Meldung'), stateId: String(item.stateId || ''), operator: String(item.operator || 'truthy'), value: item.value, severity: ['warning', 'alarm'].includes(item.severity) ? item.severity : 'warning', technicalLocation: String(item.technicalLocation || ''), note: String(item.note || ''), acknowledgedBy: String(item.acknowledgedBy || ''), acknowledgedAt: Number(item.acknowledgedAt) || null, notificationSentAt: Number(item.notificationSentAt) || null, notificationChannel: String(item.notificationChannel || '')
      })) : [];
      await this.saveModel();
      res.json(this.model.alarmDefinitions);
    });

    app.patch('/api/alarms/:id', this.requirePermission('alarms', 'write'), async (req, res) => {
      const alarm = this.model.alarmDefinitions.find(item => item.id === req.params.id);
      if (!alarm) return res.status(404).json({ error: 'Melderegel nicht gefunden' });
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) alarm.note = String(req.body.note || '').slice(0, 4000);
      if (req.body?.acknowledge) {
        alarm.acknowledgedBy = req.gltUser?.username || 'unbekannt';
        alarm.acknowledgedAt = Date.now();
      }
      await this.saveModel();
      res.json(alarm);
    });

    app.put('/api/pages', this.requirePermission('editor', 'write'), async (req, res) => {
      if (!Array.isArray(req.body) || !req.body.length) return res.status(400).json({ error: 'Mindestens ein Anlagenbild ist erforderlich' });
      this.model.pages = req.body.slice(0, 100);
      await this.saveModel();
      res.json(this.model.pages);
    });

    app.put('/api/navigation-tree', this.requirePermission('editor', 'write'), async (req, res, next) => {
      try {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Der Anlagenbaum muss eine Liste sein' });
        const icons = new Set(['folder', 'building', 'floor', 'systems', 'heating', 'ventilation', 'cooling', 'temperature', 'electric', 'water', 'heatmeter', 'solar', 'room', 'meter']);
        const normalizeUrl = value => {
          const url = String(value || '').trim().slice(0, 2048);
          if (!url || url.startsWith('/') || url.startsWith('./') || /^https?:\/\//i.test(url)) return url;
          if (/^www\.[^\s]+$/i.test(url)) return `https://${url}`;
          const ipMatch = url.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[/?#].*)?$/);
          if (ipMatch && ipMatch[1].split('.').every(part => Number(part) >= 0 && Number(part) <= 255)) return `http://${url}`;
          if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i.test(url)) return `https://${url}`;
          throw new Error('VIS-Link muss relativ, eine Webadresse oder eine IP-Adresse sein');
        };
        const nodes = req.body.slice(0, 500).map(item => {
          const id = String(item.id || crypto.randomUUID()).slice(0, 120);
          const url = normalizeUrl(item.url);
          return { id, parentId: String(item.parentId || '').slice(0, 120), label: String(item.label || 'Neue Ansicht').trim().slice(0, 160) || 'Neue Ansicht', icon: icons.has(item.icon) ? item.icon : 'systems', url };
        });
        const ids = new Set(nodes.map(item => item.id));
        nodes.forEach(item => { if (item.parentId === item.id || (item.parentId && !ids.has(item.parentId))) item.parentId = ''; });
        this.model.navigationTree = nodes;
        await this.saveModel();
        res.json(this.model.navigationTree);
      } catch (error) { next(error); }
    });

    app.put('/api/settings', this.requirePermission('settings', 'write'), async (req, res) => {
      this.model.settings.siteName = String(req.body?.siteName || 'Gebäude Zentrale').trim().slice(0, 120) || 'Gebäude Zentrale';
      this.model.settings.fontFamily = req.body?.fontFamily === 'material' ? 'material' : 'apple';
      this.model.settings.theme = ['light', 'dark', 'system'].includes(req.body?.theme) ? req.body.theme : 'light';
      this.model.settings.autoLogoffMinutes = Math.max(5, Math.min(1440, Number(req.body?.autoLogoffMinutes) || 30));
      this.model.settings.ioBrokerAdminUrl = String(req.body?.ioBrokerAdminUrl || '').trim().slice(0, 2048);
      await this.saveModel();
      res.json(this.model.settings);
    });

    app.get('/api/users', this.requirePermission('users'), (req, res) => res.json(this.model.users.map(user => this.cleanUser(user))));
    app.put('/api/users', this.requirePermission('users', 'write'), async (req, res) => {
      const input = req.body || {};
      if (!input.id && !String(input.username || '').trim()) return res.status(400).json({ error: 'Benutzername fehlt' });
      if (!input.id && String(input.password || '').length < 10) return res.status(400).json({ error: 'Neue Passwörter benötigen mindestens 10 Zeichen' });
      let user = input.id ? this.model.users.find(item => item.id === input.id) : null;
      if (!user) {
        if (this.model.users.some(item => item.username.toLowerCase() === String(input.username).toLowerCase())) return res.status(409).json({ error: 'Benutzername existiert bereits' });
        user = { id: crypto.randomUUID(), username: String(input.username || '').trim(), passwordHash: hashPassword(input.password), role: input.role === 'admin' ? 'admin' : 'viewer', mustChangePassword: true, failedLoginAttempts: 0, locked: false, lockedAt: null, lockedUntil: null };
        this.model.users.push(user);
      }
      user.displayName = String(input.displayName || input.username || user.username);
      if (user.role === 'admin' && input.role !== 'admin' && this.model.users.filter(item => item.role === 'admin').length <= 1) return res.status(400).json({ error: 'Der letzte Administrator kann nicht herabgestuft werden' });
      user.role = input.role === 'admin' ? 'admin' : 'viewer';
      user.jobTitle = String(input.jobTitle || (user.role === 'admin' ? 'Administrator' : 'Beobachter')).slice(0, 120);
      user.department = String(input.department || '').slice(0, 160);
      user.email = String(input.email || '').slice(0, 254);
      user.phone = String(input.phone || '').slice(0, 80);
      user.notes = String(input.notes || '').slice(0, 4000);
      if (Array.isArray(input.allowedNavigationIds)) {
        const validIds = new Set(this.model.navigationTree.map(node => node.id));
        user.allowedNavigationIds = [...new Set(input.allowedNavigationIds.map(String).filter(id => validIds.has(id)))];
      } else if (user.role === 'admin') {
        delete user.allowedNavigationIds;
      }
      if (user.role === 'admin') user.permissions = defaultPermissions('admin');
      else {
        const requested = input.permissions || {};
        user.permissions = Object.fromEntries(MODULES.map(module => {
          if (['users', 'iobroker', 'settings'].includes(module)) return [module, { read: false, write: false }];
          const write = Boolean(requested[module]?.write);
          return [module, { read: write || Boolean(requested[module]?.read), write }];
        }));
      }
      if (input.password) {
        user.passwordHash = hashPassword(input.password);
        user.mustChangePassword = input.forcePasswordChange !== false;
        user.failedLoginAttempts = 0;
        user.locked = false;
        user.lockedAt = null;
        user.lockedUntil = null;
      }
      if (input.unlock) { user.failedLoginAttempts = 0; user.locked = false; user.lockedAt = null; user.lockedUntil = null; }
      await this.saveModel();
      res.json(this.cleanUser(user));
    });

    app.delete('/api/users/:id', this.requirePermission('users', 'write'), async (req, res) => {
      if (req.params.id === req.gltUser.id || req.params.id === 'admin') return res.status(400).json({ error: 'Dieser Benutzer kann nicht gelöscht werden' });
      this.model.users = this.model.users.filter(item => item.id !== req.params.id);
      await this.saveModel();
      res.json({ ok: true });
    });

    app.get('/api/reports', this.requirePermission('energy'), (req, res) => res.json(this.model.reports));
    app.post('/api/reports', this.requirePermission('energy', 'write'), async (req, res, next) => {
      try {
        const spec = req.body || {};
        const allowedSources = new Set([this.config.historyInstance, this.config.influxInstance].filter(Boolean));
        const source = String(spec.source || this.config.historyInstance || this.config.influxInstance || '');
        if (!allowedSources.has(source)) return res.status(400).json({ error: 'Zeitreihenquelle ist nicht konfiguriert' });
        const values = await this.history(String(spec.stateId), Number(spec.start), Number(spec.end), 'none', 5000, source);
        const result = calculateEnergyReport({ series: values, mode: spec.mode, pricePerKwh: spec.pricePerKwh, co2Factor: spec.co2Factor ?? this.config.co2Factor });
        const report = { id: crypto.randomUUID(), createdAt: Date.now(), createdBy: req.gltUser.username, name: String(spec.name || 'Energiebericht'), stateId: String(spec.stateId), source, start: Number(spec.start), end: Number(spec.end), mode: spec.mode || 'counter', pricePerKwh: Number(spec.pricePerKwh || 0), co2Factor: Number(spec.co2Factor ?? this.config.co2Factor), ...result };
        this.model.reports.unshift(report);
        this.model.reports = this.model.reports.slice(0, 500);
        await this.saveModel();
        res.json(report);
      } catch (error) { next(error); }
    });

    app.post('/api/reports/:id/send', this.requirePermission('energy', 'write'), async (req, res, next) => {
      try {
        if (!this.config.emailInstance) return res.status(400).json({ error: 'Keine E-Mail-Instanz konfiguriert' });
        const report = this.model.reports.find(item => item.id === req.params.id);
        if (!report) return res.status(404).json({ error: 'Bericht nicht gefunden' });
        const currency = this.config.currency || 'EUR';
        await this.sendToPromise(this.config.emailInstance, 'send', { to: req.body?.to, subject: `IOT GLT – ${report.name}`, text: `${report.name}\nVerbrauch: ${report.consumptionKwh.toFixed(2)} kWh\nKosten: ${report.cost.toFixed(2)} ${currency}\nCO₂: ${report.co2Kg.toFixed(2)} kg` });
        res.json({ ok: true });
      } catch (error) { next(error); }
    });

    app.use('/assets', express.static(path.join(__dirname, 'www'), { index: false, maxAge: '1h' }));
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'www', 'index.html')));
    app.use('/api', (req, res) => res.status(404).json({ error: 'API-Endpunkt nicht gefunden' }));
    app.use((error, req, res, next) => {
      this.log.warn(`${req.method} ${req.path}: ${error.message}`);
      res.status(500).json({ error: error.message || 'Interner Fehler' });
    });

    const port = Number(this.config.port || 8095);
    const bind = this.config.bind || '0.0.0.0';
    this.server = app.listen(port, bind, async () => {
      this.log.info(`IOT GLT available at http://${bind}:${port}`);
      await this.setStateAsync('info.connection', true, true);
    });
    this.server.on('error', error => this.log.error(`Web server failed: ${error.message}`));
  }
}

if (require.main !== module) module.exports = options => new IotGltAdapter(options);
else new IotGltAdapter();
