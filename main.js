'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const utils = require('@iobroker/adapter-core');
const { hashPassword, verifyPassword, defaultPermissions, can } = require('./lib/security');
const { calculateEnergyReport } = require('./lib/energy');

class IotGltAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'iot-glt' });
    this.server = null;
    this.sessions = new Map();
    this.model = null;
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
    const state = await this.getStateAsync('data.config');
    let stored = {};
    try { stored = JSON.parse(state?.val || '{}'); } catch { this.log.warn('Stored GLT configuration was invalid and has been reset.'); }
    const defaults = {
      users: [{
        id: 'admin', username: 'admin', displayName: 'Administrator', role: 'admin',
        passwordHash: hashPassword('iot-glt'), mustChangePassword: true,
        permissions: defaultPermissions('admin')
      }],
      pages: [{ id: 'overview', name: 'Übersicht', width: 1600, height: 900, background: '', widgets: [] }],
      alarmDefinitions: [],
      reports: [],
      settings: { siteName: 'IOT GLT', accent: '#1fd1a5' }
    };
    const model = { ...defaults, ...stored };
    model.users = Array.isArray(model.users) && model.users.length ? model.users : defaults.users;
    model.pages = Array.isArray(model.pages) && model.pages.length ? model.pages : defaults.pages;
    model.alarmDefinitions = Array.isArray(model.alarmDefinitions) ? model.alarmDefinitions : [];
    model.reports = Array.isArray(model.reports) ? model.reports : [];
    if (!stored.users) {
      this.log.warn('Initial login: admin / iot-glt. Change this password immediately after login.');
      await this.saveModel(model);
    }
    return model;
  }

  async saveModel(model = this.model) {
    await this.setStateAsync('data.config', JSON.stringify(model), true);
  }

  sessionUser(req) {
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
    const session = this.sessions.get(cookies.iotglt_session);
    if (!session || session.expires < Date.now()) return null;
    session.expires = Date.now() + Number(this.config.sessionHours || 12) * 3600000;
    const user = this.model.users.find(item => item.id === session.userId);
    return user ? { ...user, passwordHash: undefined, csrf: session.csrf } : null;
  }

  publicUser() {
    if (!this.config.defaultReadOnly) return null;
    return { id: 'public', username: 'Gast', displayName: 'Gast', role: 'viewer', permissions: defaultPermissions('viewer') };
  }

  requirePermission(module, action = 'read') {
    return (req, res, next) => {
      const user = req.gltUser;
      if (!can(user, module, action)) return res.status(user ? 403 : 401).json({ error: 'Keine Berechtigung' });
      if (action === 'write' && user.id !== 'public' && req.headers['x-csrf-token'] !== user.csrf) {
        return res.status(403).json({ error: 'Ungültiges Sicherheitstoken' });
      }
      next();
    };
  }

  cleanUser(user) {
    const { passwordHash, ...safe } = user;
    return safe;
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

  async history(id, start, end, aggregate = 'none', count = 500) {
    const instance = this.config.historyInstance;
    if (!instance) throw new Error('Keine History-Instanz konfiguriert');
    const response = await this.sendToPromise(instance, 'getHistory', {
      id, options: { start, end, aggregate, count: Math.min(Number(count) || 500, 5000), addId: false }
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
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'");
      req.gltUser = this.sessionUser(req) || this.publicUser();
      next();
    });

    app.get('/api/bootstrap', (req, res) => {
      const user = req.gltUser;
      res.json({
        user,
        loginRequired: !user,
        mustChangePassword: Boolean(user?.mustChangePassword),
        modules: user ? Object.fromEntries(Object.keys(user.permissions || {}).map(key => [key, user.role === 'admin' || user.permissions[key]?.read])) : {},
        pages: can(user, 'visualization') ? this.model.pages : [],
        settings: this.model.settings,
        adapter: { name: this.name, instance: this.instance, currency: this.config.currency || 'EUR', co2Factor: Number(this.config.co2Factor || 0.38) }
      });
    });

    app.post('/api/login', (req, res) => {
      const username = String(req.body?.username || '').trim().toLowerCase();
      const user = this.model.users.find(item => item.username.toLowerCase() === username);
      if (!user || !verifyPassword(req.body?.password, user.passwordHash)) return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
      const token = crypto.randomBytes(32).toString('hex');
      const csrf = crypto.randomBytes(24).toString('hex');
      this.sessions.set(token, { userId: user.id, csrf, expires: Date.now() + Number(this.config.sessionHours || 12) * 3600000 });
      res.setHeader('Set-Cookie', `iotglt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Number(this.config.sessionHours || 12) * 3600}`);
      res.json({ user: { ...this.cleanUser(user), csrf } });
    });

    app.post('/api/logout', (req, res) => {
      const token = String(req.headers.cookie || '').match(/iotglt_session=([^;]+)/)?.[1];
      if (token) this.sessions.delete(token);
      res.setHeader('Set-Cookie', 'iotglt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      res.json({ ok: true });
    });

    app.post('/api/change-password', this.requirePermission('visualization', 'read'), async (req, res) => {
      if (req.headers['x-csrf-token'] !== req.gltUser.csrf) return res.status(403).json({ error: 'Ungültiges Sicherheitstoken' });
      const user = this.model.users.find(item => item.id === req.gltUser.id);
      if (!user || !verifyPassword(req.body?.currentPassword, user.passwordHash)) return res.status(400).json({ error: 'Aktuelles Passwort ist falsch' });
      if (String(req.body?.newPassword || '').length < 10) return res.status(400).json({ error: 'Das neue Passwort muss mindestens 10 Zeichen haben' });
      user.passwordHash = hashPassword(req.body.newPassword);
      user.mustChangePassword = false;
      await this.saveModel();
      res.json({ ok: true });
    });

    app.get('/api/states', this.requirePermission('editor'), async (req, res, next) => {
      try {
        const query = String(req.query.query || '').toLowerCase();
        const objects = await this.getForeignObjectsAsync('*', 'state');
        const ids = Object.keys(objects).filter(id => !query || id.toLowerCase().includes(query) || String(objects[id]?.common?.name || '').toLowerCase().includes(query)).slice(0, 200);
        const states = await this.getForeignStatesAsync(ids);
        res.json(ids.map(id => ({ id, name: objects[id]?.common?.name || id, type: objects[id]?.common?.type, role: objects[id]?.common?.role, unit: objects[id]?.common?.unit || '', write: Boolean(objects[id]?.common?.write), val: states[id]?.val, ts: states[id]?.ts })));
      } catch (error) { next(error); }
    });

    app.get('/api/visual-values', this.requirePermission('visualization'), async (req, res, next) => {
      try {
        const allowed = new Set(this.model.pages.flatMap(page => (page.widgets || []).map(widget => widget.stateId)).filter(Boolean));
        const ids = String(req.query.ids || '').split(',').map(id => id.trim()).filter(id => allowed.has(id)).slice(0, 200);
        const objects = await Promise.all(ids.map(id => this.getForeignObjectAsync(id)));
        const states = ids.length ? await this.getForeignStatesAsync(ids) : {};
        res.json(ids.map((id, index) => ({ id, unit: objects[index]?.common?.unit || '', write: Boolean(objects[index]?.common?.write), val: states[id]?.val, ts: states[id]?.ts })));
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

    app.get('/api/history', this.requirePermission('trends'), async (req, res, next) => {
      try {
        const end = Number(req.query.end) || Date.now();
        const start = Number(req.query.start) || end - 86400000;
        res.json({ id: req.query.id, values: await this.history(String(req.query.id), start, end, String(req.query.aggregate || 'none'), Number(req.query.count || 800)) });
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
        id: item.id || crypto.randomUUID(), name: String(item.name || 'Meldung'), stateId: String(item.stateId || ''), operator: String(item.operator || 'truthy'), value: item.value, severity: ['warning', 'alarm'].includes(item.severity) ? item.severity : 'warning'
      })) : [];
      await this.saveModel();
      res.json(this.model.alarmDefinitions);
    });

    app.put('/api/pages', this.requirePermission('editor', 'write'), async (req, res) => {
      if (!Array.isArray(req.body) || !req.body.length) return res.status(400).json({ error: 'Mindestens ein Anlagenbild ist erforderlich' });
      this.model.pages = req.body.slice(0, 100);
      await this.saveModel();
      res.json(this.model.pages);
    });

    app.get('/api/users', this.requirePermission('users'), (req, res) => res.json(this.model.users.map(user => this.cleanUser(user))));
    app.put('/api/users', this.requirePermission('users', 'write'), async (req, res) => {
      const input = req.body || {};
      if (!input.id && !String(input.username || '').trim()) return res.status(400).json({ error: 'Benutzername fehlt' });
      if (!input.id && String(input.password || '').length < 10) return res.status(400).json({ error: 'Neue Passwörter benötigen mindestens 10 Zeichen' });
      let user = input.id ? this.model.users.find(item => item.id === input.id) : null;
      if (!user) {
        if (this.model.users.some(item => item.username.toLowerCase() === String(input.username).toLowerCase())) return res.status(409).json({ error: 'Benutzername existiert bereits' });
        user = { id: crypto.randomUUID(), username: String(input.username || '').trim(), passwordHash: hashPassword(input.password), role: input.role === 'admin' ? 'admin' : 'viewer' };
        this.model.users.push(user);
      }
      user.displayName = String(input.displayName || input.username || user.username);
      user.role = input.role === 'admin' ? 'admin' : 'viewer';
      user.permissions = user.role === 'admin' ? defaultPermissions('admin') : (input.permissions || defaultPermissions('viewer'));
      if (input.password) user.passwordHash = hashPassword(input.password);
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
        const values = await this.history(String(spec.stateId), Number(spec.start), Number(spec.end), 'none', 5000);
        const result = calculateEnergyReport({ series: values, mode: spec.mode, pricePerKwh: spec.pricePerKwh, co2Factor: spec.co2Factor ?? this.config.co2Factor });
        const report = { id: crypto.randomUUID(), createdAt: Date.now(), createdBy: req.gltUser.username, name: String(spec.name || 'Energiebericht'), stateId: String(spec.stateId), start: Number(spec.start), end: Number(spec.end), mode: spec.mode || 'counter', pricePerKwh: Number(spec.pricePerKwh || 0), co2Factor: Number(spec.co2Factor ?? this.config.co2Factor), ...result };
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
