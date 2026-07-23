'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const io = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));

test('package and io-package versions match', () => assert.equal(pkg.version, io.common.version));
test('adapter uses the required GitHub repository', () => assert.match(pkg.repository.url, /Petzi2712\/ioBroker\.iot-glt/));
test('all runtime entry files exist', () => {
  for (const file of ['main.js', 'admin/jsonConfig.json', 'admin/iot-glt.svg', 'www/index.html', 'www/app.js', 'www/styles.css', 'www/glt-logo.svg']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }
});
