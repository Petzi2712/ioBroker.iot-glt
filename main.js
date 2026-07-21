'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const express = require('express');
const utils = require('@iobroker/adapter-core');
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
      pages: [{ id: 'overview', name: 'Ãœbersicht', width: 1600, height: 900, background: '', widgets: [] }],
      navigationTree: [
        { id: 'site', parentId: '', label: 'THA', icon: 'folder', url: '' },
        { id: 'building-a', parentId: 'site', label: 'GebÃ¤ude A', icon: 'building', url: '' },
        { id: 'general', parentId: 'building-a', label: 'Allgemein', icon: 'systems', url: '' },
        { id: 'ahu-01', parentId: 'general', label: 'LÃ¼ftungsanlage AHU-01', icon: 'ventilation', url: '/vis-2/index.html?project=main#AHU-01' },
        { id: 'heating-north', parentId: 'general', label: 'Heizkreis Nord', icon: 'heating', url: '/vis-2/index.html?project=main#Heizkreis-Nord' },
        { id: 'temperatures', parentId: 'general', label: 'Temperaturen', icon: 'temperature', url: '/vis-2/index.html?project=main#Temperaturen' },
        { id: 'main-meter', parentId: 'building-a', label: 'HauptzÃ¤hler', icon: 'electric', url: '/vis-2/index.html?project=main#Hauptzaehler' },
        { id: 'pv', parentId: 'building-a', label: 'PV-Anlage', icon: 'solar', url: '/vis-2/index.html?project=main#PV-Anlage' },
        { id: 'water', parentId: 'building-a', label: 'WasserzÃ¤hler', icon: 'water', url: '/vis-2/index.html?project=main#Wasserzaehler' },
        { id: 'heat-meter', parentId: 'building-a', label: 'WÃ¤rmemengenzÃ¤hler', icon: 'heatmeter', url: '/vis-2/index.html?project=main#Waermemenge' }
      ],
      dashboardWidgets: [{ id: 'adapter-connection', title: 'IOT GLT Verbindung', stateId: `${this.namespace}.info.connection`, unit: '', type: 'value', period: 1, min: 0, max: 1, cols: 3, rows: 3 }],
      alarmDefinitions: [],
      reports: [],
      settings: { siteName: 'GebÃ¤ude Zentrale', accent: '#fe6e00', fontFamily: 'apple', autoLogoffMinutes: 30, ioBrokerAdminUrl: '' }
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
    return user && !user.locked ? { ...user, passwordHash: undefined, csrf: session.csrf } : null;
  }

  publicUser() {
    if (!this.config.defaultReadOnly) return null;
    return { id: 'public', username: 'Gast', displayName: 'Gast', role: 'viewer', permissions: defaultPermissions('viewer') };
  }

  requirePermission(module, action = 'read', allowMustChange = false) {
    return (req, res, next) => {
      const user = req.gltUser;
      if (user?.mustChangePassword && !allowMustChange) return res.status(428).json({ error: 'Vor der weiteren Nutzung muss das Passwort geÃ¤ndert werden' });
      if (['users', 'iobroker', 'settings'].includes(module) && user?.role !== 'admin') return res.status(403).json({ error: 'Dieser Bereich ist ausschlieÃŸlich fÃ¼r Administratoren freigegeben' });
      if (!can(user, module, action)) return res.status(user ? 403 : 401).json({ error: 'Keine Berechtigung' });
      if (action === 'write' && user.id !== 'public' && req.headers['x-csrf-token'] !== user.csrf) {
        return res.status(403).json({ error: 'UngÃ¼ltiges Sicherheitstoken' });
      }
      next();
    };
  }

  requireAnyPermission(modules, action = 'read') {
    return (req, res, next) => {
      const user = req.gltUser;
      if (user?.mustChangePassword) return res.status(428).json({ error: 'Vor der weiteren Nutzung muss das Passwort geÃ¤ndert werden' });
      if (!modules.some(module => can(user, module, action))) return res.status(user ? 403 : 401).json({ error: 'Keine Berechtigung' });
      if (action === 'write' && user.id !== 'public' && req.headers['x-csrf-token'] !== user.csrf) return res.status(403).json({ error: 'UngÃ¼ltiges Sicherheitstoken' });
      next();
    };
  }

  requireAuthenticated(allowMustChange = false) {
    return (req, res, next) => {
      const user = req.gltUser;
      if (!user || user.id === 'public') return res.status(401).json({ error: 'Anmeldung erforderlich' });
      if (user.mustChangePassword && !allowMustChange) return res.status(428).json({ error: 'Vor der weiteren Nutzung muss das Passwort geÃ¤ndert werden' });
      next();
    };
  }

  cleanUser(user) {
    const { passwordHash, ...safe } = user;
    return safe;
  }

  sendToPromise(instance, command, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ZeitÃ¼berschreitung bei ${instance}`)), 20000);
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
        navigationTree: can(user, 'visualization') ? this.model.navigationTree : [],
        dashboardWidgets: can(user, 'dashboard') ? this.model.dashboardWidgets : [],
        settings: this.model.settings,
        adapter: { name: this.name, instance: this.instance, currency: this.config.currency || 'EUR', co2Factor: Number(this.config.co2Factor || 0.38), visBaseUrl: String(this.config.visBaseUrl || ''), historySources: [{ type: 'history', instance: this.config.historyInstance }, { type: 'influxdb', instance: this.config.influxInstance }].filter(source => source.instance) }
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
      if (req.headers['x-csrf-token'] !== req.gltUse×O8¶‰žËkºwµç@€É•Ì¹©Í½¸¡¥‘Ì¹µ…À ¡¥°¥¹‘•à¤€ôø€¡ì¥°Õ¹¥Ðè½‰©•ÑÍm¥¹‘•átü¹½µµ½¸ü¹Õ¹¥Ðñð€œœ°ÝÉ¥Ñ”è	½½±•…¸¡½‰©•ÑÍm¥¹‘•átü¹½µµ½¸ü¹ÝÉ¥Ñ”¤°Ù…°èÍÑ…Ñ•Ím¥‘tü¹Ù…°°ÑÌèÍÑ…Ñ•Ím¥‘tü¹ÑÌô¤¤¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹•Ð œ½…Á¤½‘…Í¡‰½…ÉµÍÑ…Ñ•Ìœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ ‘…Í¡‰½…Éœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÅÕ•Éä€ôMÑÉ¥¹œ¡É•Ä¹ÅÕ•Éä¹ÅÕ•Éäñð€œœ¤¹Ñ½1½Ý•É…Í” ¤ì(€€€€€€€½¹ÍÐ½‰©•ÑÌ€ô…Ý…¥ÐÑ¡¥Ì¹•Ñ½É•¥¹=‰©•ÑÍÍå¹Œ œ¨œ°€ÍÑ…Ñ”œ¤ì(€€€€€€€½¹ÍÐ¥‘Ì€ô=‰©•Ð¹­•åÌ¡½‰©•ÑÌ¤¹™¥±Ñ•È¡¥€ôø€…ÅÕ•Éäñð¥¹Ñ½1½Ý•É…Í” ¤¹¥¹±Õ‘•Ì¡ÅÕ•Éä¤ñðMÑÉ¥¹œ¡½‰©•ÑÍm¥‘tü¹½µµ½¸ü¹¹…µ”ñð€œœ¤¹Ñ½1½Ý•É…Í” ¤¹¥¹±Õ‘•Ì¡ÅÕ•Éä¤¤¹Í±¥” À°€ÈÔÀ¤ì(€€€€€€€É•Ì¹©Í½¸¡¥‘Ì¹µ…À¡¥€ôø€¡ì¥°¹…µ”è½‰©•ÑÍm¥‘tü¹½µµ½¸ü¹¹…µ”ñð¥°Õ¹¥Ðè½‰©•ÑÍm¥‘tü¹½µµ½¸ü¹Õ¹¥Ðñð€œœ°ÑåÁ”è½‰©•ÑÍm¥‘tü¹½µµ½¸ü¹ÑåÁ”ñð€œœ°É½±”è½‰©•ÑÍm¥‘tü¹½µµ½¸ü¹É½±”ñð€œœô¤¤¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹ÁÕÐ œ½…Á¤½‘…Í¡‰½…Éœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ ‘…Í¡‰½…Éœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡É•Ä¹‰½‘ä¤¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€…Í¡‰½…Éµ-½¹™¥ÕÉ…Ñ¥½¸µÕÍÌ•¥¹”1¥ÍÑ”Í•¥¸œô¤ì(€€€€€€€½¹ÍÐÑåÁ•Ì€ô¹•ÜM•Ð¡l±¥¹”œ°€‰…Èœ°€¡•…Ðœ°€™¥±°œ°€…Õ”œ°€Ñ…‰±”œ°€Ù…±Õ”t¤ì(€€€€€€€Ñ¡¥Ì¹µ½‘•°¹‘…Í¡‰½…É‘]¥‘•ÑÌ€ôÉ•Ä¹‰½‘ä¹Í±¥” À°€ÄÀÀ¤¹µ…À¡¥Ñ•´€ôø€¡ì(€€€€€€€€€¥èMÑÉ¥¹œ¡¥Ñ•´¹¥ñðÉåÁÑ¼¹É…¹‘½µUU% ¤¤¹Í±¥” À°€ÄÈÀ¤°Ñ¥Ñ±”èMÑÉ¥¹œ¡¥Ñ•´¹Ñ¥Ñ±”ñð€…Ñ•¹ÁÕ¹­Ðœ¤¹Í±¥” À°€ÄØÀ¤°ÍÑ…Ñ•%èMÑÉ¥¹œ¡¥Ñ•´¹ÍÑ…Ñ•%ñð¥Ñ•´¹‘Àñð€œœ¤¹Í±¥” À°€ÔÄÈ¤°Õ¹¥ÐèMÑÉ¥¹œ¡¥Ñ•´¹Õ¹¥Ðñð€œœ¤¹Í±¥” À°€ÐÀ¤°ÑåÁ”èÑåÁ•Ì¹¡…Ì¡¥Ñ•´¹ÑåÁ”¤€ü¥Ñ•´¹ÑåÁ”€è€±¥¹”œ°Á•É¥½è5…Ñ ¹µ…à Ä°5…Ñ ¹µ¥¸ àÜØÀ°9Õµ‰•È¡¥Ñ•´¹Á•É¥½¤ñð€ÈÐ¤¤°µ¥¸è9Õµ‰•È¹¥Í¥¹¥Ñ”¡9Õµ‰•È¡¥Ñ•´¹µ¥¸¤¤€ü9Õµ‰•È¡¥Ñ•´¹µ¥¸¤€è€À°µ…àè9Õµ‰•È¹¥Í¥¹¥Ñ”¡9Õµ‰•È¡¥Ñ•´¹µ…à¤¤€ü9Õµ‰•È¡¥Ñ•´¹µ…à¤€è€ÄÀÀ°½±Ìè5…Ñ ¹µ…à È°5…Ñ ¹µ¥¸ ÄÈ°9Õµ‰•È¡¥Ñ•´¹½±Ì¤ñð€Ð¤¤°É½ÝÌè5…Ñ ¹µ…à È°5…Ñ ¹µ¥¸ à°9Õµ‰•È¡¥Ñ•´¹É½ÝÌ¤ñð€Ì¤¤(€€€€€€€ô¤¤¹™¥±Ñ•È¡¥Ñ•´€ôø¥Ñ•´¹ÍÑ…Ñ•%¤ì(€€€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€€€É•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹‘…Í¡‰½…É‘]¥‘•ÑÌ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹ÁÕÐ œ½…Á¤½ÍÑ…Ñ”œ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ Ù¥ÍÕ…±¥é…Ñ¥½¸œ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐ¥€ôMÑÉ¥¹œ¡É•Ä¹‰½‘äü¹¥ñð€œœ¤ì(€€€€€€€½¹ÍÐ½‰©•Ð€ô…Ý…¥ÐÑ¡¥Ì¹•Ñ½É•¥¹=‰©•ÑÍå¹Œ¡¥¤ì(€€€€€€€¥˜€ …½‰©•Ðñð½‰©•Ð¹ÑåÁ”€„ôô€ÍÑ…Ñ”œñð€…½‰©•Ð¹½µµ½¸ü¹ÝÉ¥Ñ”¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€…Ñ•¹ÁÕ¹­Ð¥ÍÐ¹¥¡Ð‰•Í¡É•¥‰‰…Èœô¤ì(€€€€€€€…Ý…¥ÐÑ¡¥Ì¹Í•Ñ½É•¥¹MÑ…Ñ•Íå¹Œ¡¥°É•Ä¹‰½‘ä¹Ù…±Õ”°™…±Í”¤ì(€€€€€€€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”ô¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹•Ð œ½…Á¤½¡¥ÍÑ½Éäœ°Ñ¡¥Ì¹É•ÅÕ¥É•¹åA•Éµ¥ÍÍ¥½¸¡l‘…Í¡‰½…Éœ°€ÑÉ•¹‘Ìt¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÉ•ÅÕ•ÍÑ•‘%€ôMÑÉ¥¹œ¡É•Ä¹ÅÕ•Éä¹¥ñð€œœ¤ì(€€€€€€€¥˜€ ……¸¡É•Ä¹±ÑUÍ•È°€ÑÉ•¹‘Ìœ¤€˜˜€…Ñ¡¥Ì¹µ½‘•°¹‘…Í¡‰½…É‘]¥‘•ÑÌ¹Í½µ”¡Ý¥‘•Ð€ôø€¡Ý¥‘•Ð¹ÍÑ…Ñ•%ñðÝ¥‘•Ð¹‘À¤€ôôôÉ•ÅÕ•ÍÑ•‘%¤¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÌ¤¹©Í½¸¡ì•ÉÉ½Èè€…Ñ•¹ÁÕ¹­Ð¥ÍÐ¹¥¡Ð›ñÈ‘…Ì…Í¡‰½…É™É•¥••‰•¸œô¤ì(€€€€€€€½¹ÍÐ•¹€ô9Õµ‰•È¡É•Ä¹ÅÕ•Éä¹•¹¤ñð…Ñ”¹¹½Ü ¤ì(€€€€€€€½¹ÍÐÍÑ…ÉÐ€ô9Õµ‰•È¡É•Ä¹ÅÕ•Éä¹ÍÑ…ÉÐ¤ñð•¹€´€àØÐÀÀÀÀÀì(€€€€€€€½¹ÍÐ…±±½Ý•‘M½ÕÉ•Ì€ô¹•ÜM•Ð¡mÑ¡¥Ì¹½¹™¥œ¹¡¥ÍÑ½Éå%¹ÍÑ…¹”°Ñ¡¥Ì¹½¹™¥œ¹¥¹™±Õá%¹ÍÑ…¹•t¹™¥±Ñ•È¡	½½±•…¸¤¤ì(€€€€€€€½¹ÍÐÍ½ÕÉ”€ôMÑÉ¥¹œ¡É•Ä¹ÅÕ•Éä¹Í½ÕÉ”ñðÑ¡¥Ì¹½¹™¥œ¹¡¥ÍÑ½Éå%¹ÍÑ…¹”ñðÑ¡¥Ì¹½¹™¥œ¹¥¹™±Õá%¹ÍÑ…¹”ñð€œœ¤ì(€€€€€€€¥˜€ ……±±½Ý•‘M½ÕÉ•Ì¹¡…Ì¡Í½ÕÉ”¤¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€i•¥ÑÉ•¥¡•¹ÅÕ•±±”¥ÍÐ¹¥¡Ð­½¹™¥ÕÉ¥•ÉÐœô¤ì(€€€€€€€½¹ÍÐÉ•Í½±ÕÑ¥½¹M•½¹‘Ì€ô5…Ñ ¹µ…à À°5…Ñ ¹µ¥¸¡9Õµ‰•È¡É•Ä¹ÅÕ•Éä¹É•Í½±ÕÑ¥½¸¤ñð€À°€àØÐÀÀ¤¤ì(€€€€€€€½¹ÍÐ…É•…Ñ”€ôÉ•Í½±ÕÑ¥½¹M•½¹‘Ì€ø€À€ü€…Ù•É…”œ€èMÑÉ¥¹œ¡É•Ä¹ÅÕ•Éä¹…É•…Ñ”ñð€¹½¹”œ¤ì(€€€€€€€É•Ì¹©Í½¸¡ì¥èÉ•ÅÕ•ÍÑ•‘%°Í½ÕÉ”°É•Í½±ÕÑ¥½¹M•½¹‘Ì°Ù…±Õ•Ìè…Ý…¥ÐÑ¡¥Ì¹¡¥ÍÑ½Éä¡É•ÅÕ•ÍÑ•‘%°ÍÑ…ÉÐ°•¹°…É•…Ñ”°9Õµ‰•È¡É•Ä¹ÅÕ•Éä¹½Õ¹Ðñð€ÈÀÀÀ¤°Í½ÕÉ”°É•Í½±ÕÑ¥½¹M•½¹‘Ì€¨€ÄÀÀÀ¤ô¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹•Ð œ½…Á¤½…±…ÉµÌœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ …±…ÉµÌœ¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐ¥‘Ì€ôÑ¡¥Ì¹µ½‘•°¹…±…Éµ•™¥¹¥Ñ¥½¹Ì¹µ…À¡¥Ñ•´€ôø¥Ñ•´¹ÍÑ…Ñ•%¤ì(€€€€€€€½¹ÍÐÍÑ…Ñ•Ì€ô¥‘Ì¹±•¹Ñ €ü…Ý…¥ÐÑ¡¥Ì¹•Ñ½É•¥¹MÑ…Ñ•ÍÍå¹Œ¡¥‘Ì¤€èíôì(€€€€€€€É•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹…±…Éµ•™¥¹¥Ñ¥½¹Ì¹µ…À¡¥Ñ•´€ôøÑ¡¥Ì¹•Ù…±Õ…Ñ•±…É´¡¥Ñ•´°ÍÑ…Ñ•Ím¥Ñ•´¹ÍÑ…Ñ•%‘t¤¤¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹ÁÕÐ œ½…Á¤½…±…ÉµÌœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ …±…ÉµÌœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì(€€€€€Ñ¡¥Ì¹µ½‘•°¹…±…Éµ•™¥¹¥Ñ¥½¹Ì€ôÉÉ…ä¹¥ÍÉÉ…ä¡É•Ä¹‰½‘ä¤€üÉ•Ä¹‰½‘ä¹Í±¥” À°€ÔÀÀ¤¹µ…À¡¥Ñ•´€ôø€¡ì(€€€€€€€¥è¥Ñ•´¹¥ñðÉåÁÑ¼¹É…¹‘½µUU% ¤°¹…µ”èMÑÉ¥¹œ¡¥Ñ•´¹¹…µ”ñð€5•±‘Õ¹œœ¤°ÍÑ…Ñ•%èMÑÉ¥¹œ¡¥Ñ•´¹ÍÑ…Ñ•%ñð€œœ¤°½Á•É…Ñ½ÈèMÑÉ¥¹œ¡¥Ñ•´¹½Á•É…Ñ½Èñð€ÑÉÕÑ¡äœ¤°Ù…±Õ”è¥Ñ•´¹Ù…±Õ”°Í•Ù•É¥ÑäèlÝ…É¹¥¹œœ°€…±…É´t¹¥¹±Õ‘•Ì¡¥Ñ•´¹Í•Ù•É¥Ñä¤€ü¥Ñ•´¹Í•Ù•É¥Ñä€è€Ý…É¹¥¹œœ°Ñ•¡¹¥…±1½…Ñ¥½¸èMÑÉ¥¹œ¡¥Ñ•´¹Ñ•¡¹¥…±1½…Ñ¥½¸ñð€œœ¤°¹½Ñ”èMÑÉ¥¹œ¡¥Ñ•´¹¹½Ñ”ñð€œœ¤°…­¹½Ý±•‘•‘	äèMÑÉ¥¹œ¡¥Ñ•´¹…­¹½Ý±•‘•‘	äñð€œœ¤°…­¹½Ý±•‘•‘Ðè9Õµ‰•È¡¥Ñ•´¹…­¹½Ý±•‘•‘Ð¤ñð¹Õ±°°¹½Ñ¥™¥…Ñ¥½¹M•¹ÑÐè9Õµ‰•È¡¥Ñ•´¹¹½Ñ¥™¥…Ñ¥½¹M•¹ÑÐ¤ñð¹Õ±°°¹½Ñ¥™¥…Ñ¥½¹¡…¹¹•°èMÑÉ¥¹œ¡¥Ñ•´¹¹½Ñ¥™¥…Ñ¥½¹¡…¹¹•°ñð€œœ¤(€€€€€ô¤¤€èmtì(€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€É•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹…±…Éµ•™¥¹¥Ñ¥½¹Ì¤ì(€€€ô¤ì((€€€…ÁÀ¹Á…Ñ  œ½…Á¤½…±…ÉµÌ¼é¥œ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ …±…ÉµÌœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì(€€€€€½¹ÍÐ…±…É´€ôÑ¡¥Ì¹µ½‘•°¹…±…Éµ•™¥¹¥Ñ¥½¹Ì¹™¥¹¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôôÉ•Ä¹Á…É…µÌ¹¥¤ì(€€€€€¥˜€ ……±…É´¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÐ¤¹©Í½¸¡ì•ÉÉ½Èè€5•±‘•É••°¹¥¡Ð•™Õ¹‘•¸œô¤ì(€€€€€¥˜€¡=‰©•Ð¹ÁÉ½Ñ½ÑåÁ”¹¡…Í=Ý¹AÉ½Á•ÉÑä¹…±°¡É•Ä¹‰½‘äñðíô°€¹½Ñ”œ¤¤…±…É´¹¹½Ñ”€ôMÑÉ¥¹œ¡É•Ä¹‰½‘ä¹¹½Ñ”ñð€œœ¤¹Í±¥” À°€ÐÀÀÀ¤ì(€€€€€¥˜€¡É•Ä¹‰½‘äü¹…­¹½Ý±•‘”¤ì(€€€€€€€…±…É´¹…­¹½Ý±•‘•‘	ä€ôÉ•Ä¹±ÑUÍ•Èü¹ÕÍ•É¹…µ”ñð€Õ¹‰•­…¹¹Ðœì(€€€€€€€…±…É´¹…­¹½Ý±•‘•‘Ð€ô…Ñ”¹¹½Ü ¤ì(€€€€€ô(€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€É•Ì¹©Í½¸¡…±…É´¤ì(€€€ô¤ì((€€€…ÁÀ¹ÁÕÐ œ½…Á¤½Á…•Ìœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ •‘¥Ñ½Èœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì(€€€€€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡É•Ä¹‰½‘ä¤ñð€…É•Ä¹‰½‘ä¹±•¹Ñ ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€5¥¹‘•ÍÑ•¹Ì•¥¸¹±…•¹‰¥±¥ÍÐ•É™½É‘•É±¥ œô¤ì(€€€€€Ñ¡¥Ì¹µ½‘•°¹Á…•Ì€ôÉ•Ä¹‰½‘ä¹Í±¥” À°€ÄÀÀ¤ì(€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€É•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹Á…•Ì¤ì(€€€ô¤ì((€€€…ÁÀ¹ÁÕÐ œ½…Á¤½¹…Ù¥…Ñ¥½¸µÑÉ•”œ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ •‘¥Ñ½Èœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡É•Ä¹‰½‘ä¤¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€•È¹±…•¹‰…Õ´µÕÍÌ•¥¹”1¥ÍÑ”Í•¥¸œô¤ì(€€€€€€€½¹ÍÐ¥½¹Ì€ô¹•ÜM•Ð¡l™½±‘•Èœ°€‰Õ¥±‘¥¹œœ°€™±½½Èœ°€ÍåÍÑ•µÌœ°€¡•…Ñ¥¹œœ°€Ù•¹Ñ¥±…Ñ¥½¸œ°€½½±¥¹œœ°€Ñ•µÁ•É…ÑÕÉ”œ°€•±•ÑÉ¥Œœ°€Ý…Ñ•Èœ°€¡•…Ñµ•Ñ•Èœ°€Í½±…Èœ°€É½½´œ°€µ•Ñ•Èt¤ì(€€€€€€€½¹ÍÐ¹½Éµ…±¥é•UÉ°€ôÙ…±Õ”€ôøì(€€€€€€€€€½¹ÍÐÕÉ°€ôMÑÉ¥¹œ¡Ù…±Õ”ñð€œœ¤¹ÑÉ¥´ ¤¹Í±¥” À°€ÈÀÐà¤ì(€€€€€€€€€¥˜€ …ÕÉ°ñðÕÉ°¹ÍÑ…ÉÑÍ]¥Ñ  œ¼œ¤ñðÕÉ°¹ÍÑ…ÉÑÍ]¥Ñ  œ¸¼œ¤ñð€½y¡ÑÑÁÌüép½p¼½¤¹Ñ•ÍÐ¡ÕÉ°¤¤É•ÑÕÉ¸ÕÉ°ì(€€€€€€€€€¥˜€ ½yÝÝÝp¹myqÍt¬½¤¹Ñ•ÍÐ¡ÕÉ°¤¤É•ÑÕÉ¸¡ÑÑÁÌè¼¼‘íÕÉ±õ€ì(€€€€€€€€€½¹ÍÐ¥Á5…Ñ €ôÕÉ°¹µ…Ñ  ½x  üéq‘ìÄ°Íõp¸¥ìÍõq‘ìÄ°Íô¤ üèéq‘ìÄ°Õô¤ü üél¼üt¸¨¤ü¼¤ì(€€€€€€€€€¥˜€¡¥Á5…Ñ €˜˜¥Á5…Ñ¡lÅt¹ÍÁ±¥Ð œ¸œ¤¹•Ù•Éä¡Á…ÉÐ€ôø9Õµ‰•È¡Á…ÉÐ¤€øô€À€˜˜9Õµ‰•È¡Á…ÉÐ¤€ðô€ÈÔÔ¤¤É•ÑÕÉ¸¡ÑÑÀè¼¼‘íÕÉ±õ€ì(€€€€€€€€€¥˜€ ½ym„µèÀ´ä¸µt­p¹m„µéuìÈ±ô üèéq‘ìÄ°Õô¤ü üél¼üt¸¨¤ü½¤¹Ñ•ÍÐ¡ÕÉ°¤¤É•ÑÕÉ¸¡ÑÑÁÌè¼¼‘íÕÉ±õ€ì(€€€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È Y%Lµ1¥¹¬µÕÍÌÉ•±…Ñ¥Ø°•¥¹”]•‰…‘É•ÍÍ”½‘•È•¥¹”%@µ‘É•ÍÍ”Í•¥¸œ¤ì(€€€€€€€ôì(€€€€€€€½¹ÍÐ¹½‘•Ì€ôÉ•Ä¹‰½‘ä¹Í±¥” À°€ÔÀÀ¤¹µ…À¡¥Ñ•´€ôøì(€€€€€€€€€½¹ÍÐ¥€ôMÑÉ¥¹œ¡¥Ñ•´¹¥ñðÉåÁÑ¼¹É…¹‘½µUU% ¤¤¹Í±¥” À°€ÄÈÀ¤ì(€€€€€€€€€½¹ÍÐÕÉ°€ô¹½Éµ…±¥é•UÉ°¡¥Ñ•´¹ÕÉ°¤ì(€€€€€€€€€É•ÑÕÉ¸ì¥°Á…É•¹Ñ%èMÑÉ¥¹œ¡¥Ñ•´¹Á…É•¹Ñ%ñð€œœ¤¹Í±¥” À°€ÄÈÀ¤°±…‰•°èMÑÉ¥¹œ¡¥Ñ•´¹±…‰•°ñð€9•Õ”¹Í¥¡Ðœ¤¹ÑÉ¥´ ¤¹Í±¥” À°€ÄØÀ¤ñð€9•Õ”¹Í¥¡Ðœ°¥½¸è¥½¹Ì¹¡…Ì¡¥Ñ•´¹¥½¸¤€ü¥Ñ•´¹¥½¸€è€ÍåÍÑ•µÌœ°ÕÉ°ôì(€€€€€€€ô¤ì(€€€€€€€½¹ÍÐ¥‘Ì€ô¹•ÜM•Ð¡¹½‘•Ì¹µ…À¡¥Ñ•´€ôø¥Ñ•´¹¥¤¤ì(€€€€€€€¹½‘•Ì¹™½É… ¡¥Ñ•´€ôøì¥˜€¡¥Ñ•´¹Á…É•¹Ñ%€ôôô¥Ñ•´¹¥ñð€¡¥Ñ•´¹Á…É•¹Ñ%€˜˜€…¥‘Ì¹¡…Ì¡¥Ñ•´¹Á…É•¹Ñ%¤¤¤¥Ñ•´¹Á…É•¹Ñ%€ô€œœìô¤ì(€€€€€€€Ñ¡¥Ì¹µ½‘•°¹¹…Ù¥…Ñ¥½¹QÉ•”€ô¹½‘•Ìì(€€€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€€€É•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹¹…Ù¥…Ñ¥½¹QÉ•”¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹ÁÕÐ œ½…Á¤½Í•ÑÑ¥¹Ìœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ Í•ÑÑ¥¹Ìœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì(€€€€€Ñ¡¥Ì¹µ½‘•°¹Í•ÑÑ¥¹Ì¹Í¥Ñ•9…µ”€ôMÑÉ¥¹œ¡É•Ä¹‰½‘äü¹Í¥Ñ•9…µ”ñð€•‹‘Õ‘”i•¹ÑÉ…±”œ¤¹ÑÉ¥´ ¤¹Í±¥” À°€ÄÈÀ¤ñð€•‹‘Õ‘”i•¹ÑÉ…±”œì(€€€€€Ñ¡¥Ì¹µ½‘•°¹Í•ÑÑ¥¹Ì¹™½¹Ñ…µ¥±ä€ôÉ•Ä¹‰½‘äü¹™½¹Ñ…µ¥±ä€ôôô€µ…Ñ•É¥…°œ€ü€µ…Ñ•É¥…°œ€è€…ÁÁ±”œì(€€€€€Ñ¡¥Ì¹µ½‘•°¹Í•ÑÑ¥¹Ì¹…ÕÑ½1½½™™5¥¹ÕÑ•Ì€ô5…Ñ ¹µ…à Ô°5…Ñ ¹µ¥¸ ÄÐÐÀ°9Õµ‰•È¡É•Ä¹‰½‘äü¹…ÕÑ½1½½™™5¥¹ÕÑ•Ì¤ñð€ÌÀ¤¤ì(€€€€€Ñ¡¥Ì¹µ½‘•°¹Í•ÑÑ¥¹Ì¹¥½	É½­•É‘µ¥¹UÉ°€ôMÑÉ¥¹œ¡É•Ä¹‰½‘äü¹¥½	É½­•É‘µ¥¹UÉ°ñð€œœ¤¹ÑÉ¥´ ¤¹Í±¥” À°€ÈÀÐà¤ì(€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€É•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹Í•ÑÑ¥¹Ì¤ì(€€€ô¤ì((€€€…ÁÀ¹•Ð œ½…Á¤½ÕÍ•ÉÌœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ ÕÍ•ÉÌœ¤°€¡É•Ä°É•Ì¤€ôøÉ•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹ÕÍ•ÉÌ¹µ…À¡ÕÍ•È€ôøÑ¡¥Ì¹±•…¹UÍ•È¡ÕÍ•È¤¤¤¤ì(€€€…ÁÀ¹ÁÕÐ œ½…Á¤½ÕÍ•ÉÌœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ ÕÍ•ÉÌœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì(€€€€€½¹ÍÐ¥¹ÁÕÐ€ôÉ•Ä¹‰½‘äñðíôì(€€€€€¥˜€ …¥¹ÁÕÐ¹¥€˜˜€…MÑÉ¥¹œ¡¥¹ÁÕÐ¹ÕÍ•É¹…µ”ñð€œœ¤¹ÑÉ¥´ ¤¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€	•¹ÕÑé•É¹…µ”™•¡±Ðœô¤ì(€€€€€¥˜€ …¥¹ÁÕÐ¹¥€˜˜MÑÉ¥¹œ¡¥¹ÁÕÐ¹Á…ÍÍÝ½Éñð€œœ¤¹±•¹Ñ €ð€ÄÀ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€9•Õ”A…ÍÍßÙÉÑ•È‰•»ÙÑ¥•¸µ¥¹‘•ÍÑ•¹Ì€ÄÀi•¥¡•¸œô¤ì(€€€€€±•ÐÕÍ•È€ô¥¹ÁÕÐ¹¥€üÑ¡¥Ì¹µ½‘•°¹ÕÍ•ÉÌ¹™¥¹¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôô¥¹ÁÕÐ¹¥¤€è¹Õ±°ì(€€€€€¥˜€ …ÕÍ•È¤ì(€€€€€€€¥˜€¡Ñ¡¥Ì¹µ½‘•°¹ÕÍ•ÉÌ¹Í½µ”¡¥Ñ•´€ôø¥Ñ•´¹ÕÍ•É¹…µ”¹Ñ½1½Ý•É…Í” ¤€ôôôMÑÉ¥¹œ¡¥¹ÁÕÐ¹ÕÍ•É¹…µ”¤¹Ñ½1½Ý•É…Í” ¤¤¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀä¤¹©Í½¸¡ì•ÉÉ½Èè€	•¹ÕÑé•É¹…µ”•á¥ÍÑ¥•ÉÐ‰•É•¥ÑÌœô¤ì(€€€€€€€ÕÍ•È€ôì¥èÉåÁÑ¼¹É…¹‘½µUU% ¤°ÕÍ•É¹…µ”èMÑÉ¥¹œ¡¥¹ÁÕÐ¹ÕÍ•É¹…µ”ñð€œœ¤¹ÑÉ¥´ ¤°Á…ÍÍÝ½É‘!…Í è¡…Í¡A…ÍÍÝ½É¡¥¹ÁÕÐ¹Á…ÍÍÝ½É¤°É½±”è¥¹ÁÕÐ¹É½±”€ôôô€…‘µ¥¸œ€ü€…‘µ¥¸œ€è€Ù¥•Ý•Èœ°µÕÍÑ¡…¹•A…ÍÍÝ½ÉèÑÉÕ”°™…¥±•‘1½¥¹ÑÑ•µÁÑÌè€À°±½­•è™…±Í”°±½­•‘Ðè¹Õ±°°±½­•‘U¹Ñ¥°è¹Õ±°ôì(€€€€€€€Ñ¡¥Ì¹µ½‘•°¹ÕÍ•ÉÌ¹ÁÕÍ ¡ÕÍ•È¤ì(€€€€€ô(€€€€€ÕÍ•È¹‘¥ÍÁ±…å9…µ”€ôMÑÉ¥¹œ¡¥¹ÁÕÐ¹‘¥ÍÁ±…å9…µ”ñð¥¹ÁÕÐ¹ÕÍ•É¹…µ”ñðÕÍ•È¹ÕÍ•É¹…µ”¤ì(€€€€€¥˜€¡ÕÍ•È¹É½±”€ôôô€…‘µ¥¸œ€˜˜¥¹ÁÕÐ¹É½±”€„ôô€…‘µ¥¸œ€˜˜Ñ¡¥Ì¹µ½‘•°¹ÕÍ•ÉÌ¹™¥±Ñ•È¡¥Ñ•´€ôø¥Ñ•´¹É½±”€ôôô€…‘µ¥¸œ¤¹±•¹Ñ €ðô€Ä¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€•È±•ÑéÑ”‘µ¥¹¥ÍÑÉ…Ñ½È­…¹¸¹¥¡Ð¡•É…‰•ÍÑÕ™ÐÝ•É‘•¸œô¤ì(€€€€€ÕÍ•È¹É½±”€ô¥¹ÁÕÐ¹É½±”€ôôô€…‘µ¥¸œ€ü€…‘µ¥¸œ€è€Ù¥•Ý•Èœì(€€€€€ÕÍ•È¹©½‰Q¥Ñ±”€ôMÑÉ¥¹œ¡¥¹ÁÕÐ¹©½‰Q¥Ñ±”ñð€¡ÕÍ•È¹É½±”€ôôô€…‘µ¥¸œ€ü€‘µ¥¹¥ÍÑÉ…Ñ½Èœ€è€	•½‰…¡Ñ•Èœ¤¤¹Í±¥” À°€ÄÈÀ¤ì(€€€€€ÕÍ•È¹‘•Á…ÉÑµ•¹Ð€ôMÑÉ¥¹œ¡¥¹ÁÕÐ¹‘•Á…ÉÑµ•¹Ðñð€œœ¤¹Í±¥” À°€ÄØÀ¤ì(€€€€€ÕÍ•È¹•µ…¥°€ôMÑÉ¥¹œ¡¥¹ÁÕÐ¹•µ…¥°ñð€œœ¤¹Í±¥” À°€ÈÔÐ¤ì(€€€€€ÕÍ•È¹Á¡½¹”€ôMÑÉ¥¹œ¡¥¹ÁÕÐ¹Á¡½¹”ñð€œœ¤¹Í±¥” À°€àÀ¤ì(€€€€€ÕÍ•È¹¹½Ñ•Ì€ôMÑÉ¥¹œ¡¥¹ÁÕÐ¹¹½Ñ•Ìñð€œœ¤¹Í±¥” À°€ÐÀÀÀ¤ì(€€€€€¥˜€¡ÕÍ•È¹É½±”€ôôô€…‘µ¥¸œ¤ÕÍ•È¹Á•Éµ¥ÍÍ¥½¹Ì€ô‘•™…Õ±ÑA•Éµ¥ÍÍ¥½¹Ì …‘µ¥¸œ¤ì(€€€€€•±Í”ì(€€€€€€€½¹ÍÐÉ•ÅÕ•ÍÑ•€ô¥¹ÁÕÐ¹Á•Éµ¥ÍÍ¥½¹Ìñðíôì(€€€€€€€ÕÍ•È¹Á•Éµ¥ÍÍ¥½¹Ì€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡5=U1L¹µ…À¡µ½‘Õ±”€ôøì(€€€€€€€€€¥˜€¡lÕÍ•ÉÌœ°€¥½‰É½­•Èœ°€Í•ÑÑ¥¹Ìt¹¥¹±Õ‘•Ì¡µ½‘Õ±”¤¤É•ÑÕÉ¸mµ½‘Õ±”°ìÉ•…è™…±Í”°ÝÉ¥Ñ”è™…±Í”õtì(€€€€€€€€€½¹ÍÐÝÉ¥Ñ”€ô	½½±•…¸¡É•ÅÕ•ÍÑ•‘mµ½‘Õ±•tü¹ÝÉ¥Ñ”¤ì(€€€€€€€€€É•ÑÕÉ¸mµ½‘Õ±”°ìÉ•…èÝÉ¥Ñ”ñð	½½±•…¸¡É•ÅÕ•ÍÑ•‘mµ½‘Õ±•tü¹É•…¤°ÝÉ¥Ñ”õtì(€€€€€€€ô¤¤ì(€€€€€ô(€€€€€¥˜€¡¥¹ÁÕÐ¹Á…ÍÍÝ½É¤ì(€€€€€€€ÕÍ•È¹Á…ÍÍÝ½É‘!…Í €ô¡…Í¡A…ÍÍÝ½É¡¥¹ÁÕÐ¹Á…ÍÍÝ½É¤ì(€€€€€€€ÕÍ•È¹µÕÍÑ¡…¹•A…ÍÍÝ½É€ô¥¹ÁÕÐ¹™½É•A…ÍÍÝ½É‘¡…¹”€„ôô™…±Í”ì(€€€€€€€ÕÍ•È¹™…¥±•‘1½¥¹ÑÑ•µÁÑÌ€ô€Àì(€€€€€€€ÕÍ•È¹±½­•€ô™…±Í”ì(€€€€€€€ÕÍ•È¹±½­•‘Ð€ô¹Õ±°ì(€€€€€€€ÕÍ•È¹±½­•‘U¹Ñ¥°€ô¹Õ±°ì(€€€€€ô(€€€€€¥˜€¡¥¹ÁÕÐ¹Õ¹±½¬¤ìÕÍ•È¹™…¥±•‘1½¥¹ÑÑ•µÁÑÌ€ô€ÀìÕÍ•È¹±½­•€ô™…±Í”ìÕÍ•È¹±½­•‘Ð€ô¹Õ±°ìÕÍ•È¹±½­•‘U¹Ñ¥°€ô¹Õ±°ìô(€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€É•Ì¹©Í½¸¡Ñ¡¥Ì¹±•…¹UÍ•È¡ÕÍ•È¤¤ì(€€€ô¤ì((€€€…ÁÀ¹‘•±•Ñ” œ½…Á¤½ÕÍ•ÉÌ¼é¥œ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ ÕÍ•ÉÌœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì(€€€€€¥˜€¡É•Ä¹Á…É…µÌ¹¥€ôôôÉ•Ä¹±ÑUÍ•È¹¥ñðÉ•Ä¹Á…É…µÌ¹¥€ôôô€…‘µ¥¸œ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€¥•Í•È	•¹ÕÑé•È­…¹¸¹¥¡Ð•³ÙÍ¡ÐÝ•É‘•¸œô¤ì(€€€€€Ñ¡¥Ì¹µ½‘•°¹ÕÍ•ÉÌ€ôÑ¡¥Ì¹µ½‘•°¹ÕÍ•ÉÌ¹™¥±Ñ•È¡¥Ñ•´€ôø¥Ñ•´¹¥€„ôôÉ•Ä¹Á…É…µÌ¹¥¤ì(€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”ô¤ì(€€€ô¤ì((€€€…ÁÀ¹•Ð œ½…Á¤½É•Á½ÉÑÌœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ •¹•Éäœ¤°€¡É•Ä°É•Ì¤€ôøÉ•Ì¹©Í½¸¡Ñ¡¥Ì¹µ½‘•°¹É•Á½ÉÑÌ¤¤ì(€€€…ÁÀ¹Á½ÍÐ œ½…Á¤½É•Á½ÉÑÌœ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ •¹•Éäœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÍÁ•Œ€ôÉ•Ä¹‰½‘äñðíôì(€€€€€€€½¹ÍÐÙ…±Õ•Ì€ô…Ý…¥ÐÑ¡¥Ì¹¡¥ÍÑ½Éä¡MÑÉ¥¹œ¡ÍÁ•Œ¹ÍÑ…Ñ•%¤°9Õµ‰•È¡ÍÁ•Œ¹ÍÑ…ÉÐ¤°9Õµ‰•È¡ÍÁ•Œ¹•¹¤°€¹½¹”œ°€ÔÀÀÀ¤ì(€€€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô…±Õ±…Ñ•¹•ÉåI•Á½ÉÐ¡ìÍ•É¥•ÌèÙ…±Õ•Ì°µ½‘”èÍÁ•Œ¹µ½‘”°ÁÉ¥•A•É-Ý èÍÁ•Œ¹ÁÉ¥•A•É-Ý °¼É…Ñ½ÈèÍÁ•Œ¹¼É…Ñ½È€üüÑ¡¥Ì¹½¹™¥œ¹¼É…Ñ½Èô¤ì(€€€€€€€½¹ÍÐÉ•Á½ÉÐ€ôì¥èÉåÁÑ¼¹É…¹‘½µUU% ¤°É•…Ñ•‘Ðè…Ñ”¹¹½Ü ¤°É•…Ñ•‘	äèÉ•Ä¹±ÑUÍ•È¹ÕÍ•É¹…µ”°¹…µ”èMÑÉ¥¹œ¡ÍÁ•Œ¹¹…µ”ñð€¹•É¥•‰•É¥¡Ðœ¤°ÍÑ…Ñ•%èMÑÉ¥¹œ¡ÍÁ•Œ¹ÍÑ…Ñ•%¤°ÍÑ…ÉÐè9Õµ‰•È¡ÍÁ•Œ¹ÍÑ…ÉÐ¤°•¹è9Õµ‰•È¡ÍÁ•Œ¹•¹¤°µ½‘”èÍÁ•Œ¹µ½‘”ñð€½Õ¹Ñ•Èœ°ÁÉ¥•A•É-Ý è9Õµ‰•È¡ÍÁ•Œ¹ÁÉ¥•A•É-Ý ñð€À¤°¼É…Ñ½Èè9Õµ‰•È¡ÍÁ•Œ¹¼É…Ñ½È€üüÑ¡¥Ì¹½¹™¥œ¹¼É…Ñ½È¤°€¸¸¹É•ÍÕ±Ðôì(€€€€€€€Ñ¡¥Ì¹µ½‘•°¹É•Á½ÉÑÌ¹Õ¹Í¡¥™Ð¡É•Á½ÉÐ¤ì(€€€€€€€Ñ¡¥Ì¹µ½‘•°¹É•Á½ÉÑÌ€ôÑ¡¥Ì¹µ½‘•°¹É•Á½ÉÑÌ¹Í±¥” À°€ÔÀÀ¤ì(€€€€€€€…Ý…¥ÐÑ¡¥Ì¹Í…Ù•5½‘•° ¤ì(€€€€€€€É•Ì¹©Í½¸¡É•Á½ÉÐ¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹Á½ÍÐ œ½…Á¤½É•Á½ÉÑÌ¼é¥½Í•¹œ°Ñ¡¥Ì¹É•ÅÕ¥É•A•Éµ¥ÍÍ¥½¸ •¹•Éäœ°€ÝÉ¥Ñ”œ¤°…Íå¹Œ€¡É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€ÑÉäì(€€€€€€€¥˜€ …Ñ¡¥Ì¹½¹™¥œ¹•µ…¥±%¹ÍÑ…¹”¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€-•¥¹”µ5…¥°µ%¹ÍÑ…¹è­½¹™¥ÕÉ¥•ÉÐœô¤ì(€€€€€€€½¹ÍÐÉ•Á½ÉÐ€ôÑ¡¥Ì¹µ½‘•°¹É•Á½ÉÑÌ¹™¥¹¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôôÉ•Ä¹Á…É…µÌ¹¥¤ì(€€€€€€€¥˜€ …É•Á½ÉÐ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÐ¤¹©Í½¸¡ì•ÉÉ½Èè€	•É¥¡Ð¹¥¡Ð•™Õ¹‘•¸œô¤ì(€€€€€€€½¹ÍÐÕÉÉ•¹ä€ôÑ¡¥Ì¹½¹™¥œ¹ÕÉÉ•¹äñð€UHœì(€€€€€€€…Ý…¥ÐÑ¡¥Ì¹Í•¹‘Q½AÉ½µ¥Í”¡Ñ¡¥Ì¹½¹™¥œ¹•µ…¥±%¹ÍÑ…¹”°€Í•¹œ°ìÑ¼èÉ•Ä¹‰½‘äü¹Ñ¼°ÍÕ‰©•Ðè%=P1PƒŠL€‘íÉ•Á½ÉÐ¹¹…µ•õ€°Ñ•áÐè€‘íÉ•Á½ÉÐ¹¹…µ•õq¹Y•É‰É…Õ è€‘íÉ•Á½ÉÐ¹½¹ÍÕµÁÑ¥½¹-Ý ¹Ñ½¥á• È¥ô­]¡q¹-½ÍÑ•¸è€‘íÉ•Á½ÉÐ¹½ÍÐ¹Ñ½¥á• È¥ô€‘íÕÉÉ•¹åõq¹?Š
è€‘íÉ•Á½ÉÐ¹¼É-œ¹Ñ½¥á• È¥ô­€ô¤ì(€€€€€€€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”ô¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì¹•áÐ¡•ÉÉ½È¤ìô(€€€ô¤ì((€€€…ÁÀ¹ÕÍ” œ½…ÍÍ•ÑÌœ°•áÁÉ•ÍÌ¹ÍÑ…Ñ¥Œ¡Á…Ñ ¹©½¥¸¡}}‘¥É¹…µ”°€ÝÝÜœ¤°ì¥¹‘•àè™…±Í”°µ…á”è€œÅ œô¤¤ì(€€€…ÁÀ¹•Ð œ¼œ°€¡É•Ä°É•Ì¤€ôøÉ•Ì¹Í•¹‘¥±”¡Á…Ñ ¹©½¥¸¡}}‘¥É¹…µ”°€ÝÝÜœ°€¥¹‘•à¹¡Ñµ°œ¤¤¤ì(€€€…ÁÀ¹ÕÍ” œ½…Á¤œ°€¡É•Ä°É•Ì¤€ôøÉ•Ì¹ÍÑ…ÑÕÌ ÐÀÐ¤¹©Í½¸¡ì•ÉÉ½Èè€A$µ¹‘ÁÕ¹­Ð¹¥¡Ð•™Õ¹‘•¸œô¤¤ì(€€€…ÁÀ¹ÕÍ” ¡•ÉÉ½È°É•Ä°É•Ì°¹•áÐ¤€ôøì(€€€€€Ñ¡¥Ì¹±½œ¹Ý…É¸¡€‘íÉ•Ä¹µ•Ñ¡½‘ô€‘íÉ•Ä¹Á…Ñ¡ôè€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€€€É•Ì¹ÍÑ…ÑÕÌ ÔÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè•ÉÉ½È¹µ•ÍÍ…”ñð€%¹Ñ•É¹•È•¡±•Èœô¤ì(€€€ô¤ì((€€€½¹ÍÐÁ½ÉÐ€ô9Õµ‰•È¡Ñ¡¥Ì¹½¹™¥œ¹Á½ÉÐñð€àÀäÔ¤ì(€€€½¹ÍÐ‰¥¹€ôÑ¡¥Ì¹½¹™¥œ¹‰¥¹ñð€œÀ¸À¸À¸Àœì(€€€Ñ¡¥Ì¹Í•ÉÙ•È€ô…ÁÀ¹±¥ÍÑ•¸¡Á½ÉÐ°‰¥¹°…Íå¹Œ€ ¤€ôøì(€€€€€Ñ¡¥Ì¹±½œ¹¥¹™¼¡%=P1P…Ù…¥±…‰±”…Ð¡ÑÑÀè¼¼‘í‰¥¹‘ôè‘íÁ½ÉÑõ€¤ì(€€€€€…Ý…¥ÐÑ¡¥Ì¹Í•ÑMÑ…Ñ•Íå¹Œ ¥¹™¼¹½¹¹•Ñ¥½¸œ°ÑÉÕ”°ÑÉÕ”¤ì(€€€ô¤ì(€€€Ñ¡¥Ì¹Í•ÉÙ•È¹½¸ •ÉÉ½Èœ°•ÉÉ½È€ôøÑ¡¥Ì¹±½œ¹•ÉÉ½È¡]•ˆÍ•ÉÙ•È™…¥±•è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤¤ì(€ô)ô()¥˜€¡É•ÅÕ¥É”¹µ…¥¸€„ôôµ½‘Õ±”¤µ½‘Õ±”¹•áÁ½ÉÑÌ€ô½ÁÑ¥½¹Ì€ôø¹•Ü%½Ñ±Ñ‘…ÁÑ•È¡½ÁÑ¥½¹Ì¤ì)•±Í”¹•Ü%½Ñ±Ñ‘…ÁÑ•È ¤ì