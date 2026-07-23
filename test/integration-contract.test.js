'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'www', 'app.js'), 'utf8');
const ioPackage = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));

test('configuration is stored in the local ioBroker instance data directory', () => {
  assert.match(main, /getAbsoluteInstanceDataDir\(this\)/);
  assert.match(main, /iot-glt-model\.json/);
  assert.match(main, /modelPath}\.bak/);
});

test('dashboard is persisted by the adapter and can select ioBroker states', () => {
  assert.match(main, /app\.put\('\/api\/dashboard'/);
  assert.match(main, /app\.get\('\/api\/dashboard-states'/);
  assert.match(app, /api\('\/api\/dashboard'/);
  assert.doesNotMatch(app, /localStorage\.setItem\('iot-glt-dashboard'/);
});

test('history, influxdb and VIS integration are configurable', () => {
  assert.equal(ioPackage.native.historyInstance, 'history.0');
  assert.ok(Object.hasOwn(ioPackage.native, 'influxInstance'));
  assert.ok(Object.hasOwn(ioPackage.native, 'visBaseUrl'));
  assert.match(main, /sendToPromise\(instance, 'getHistory'/);
  assert.match(app, /resolvedVisUrl/);
});

test('every authenticated user can complete the mandatory first password change', () => {
  assert.match(main, /requireAuthenticated\(allowMustChange = false\)/);
  assert.match(main, /app\.post\('\/api\/change-password', this\.requireAuthenticated\(true\)/);
});

test('navigation and plant views are filtered by user permissions', () => {
  assert.match(main, /navigationForUser\(user\)/);
  assert.match(main, /allowedNavigationIds/);
  assert.match(app, /plantPermissions/);
});

test('all data point workflows use the ioBroker object picker', () => {
  assert.match(app, /showObjectPicker/);
  assert.match(app, /api\/trend-states/);
  assert.match(app, /showEnergyStatePicker/);
});

test('themes, energy history and trend interaction are wired', () => {
  assert.match(app, /applyTheme/);
  assert.match(app, /loadEnergyHistory/);
  assert.match(app, /bindTrendNavigation/);
  assert.match(app, /multiTrendSvg/);
});
