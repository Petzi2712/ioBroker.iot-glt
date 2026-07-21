'use strict';

const crypto = require('node:crypto');

const MODULES = ['dashboard', 'alarms', 'visualization', 'trends', 'energy', 'editor', 'iobroker', 'users', 'settings'];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expectedHex] = stored.split(':');
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function defaultPermissions(role) {
  const admin = role === 'admin';
  return Object.fromEntries(MODULES.map(module => [module, { read: admin || !['users', 'editor', 'iobroker', 'settings'].includes(module), write: admin }]));
}

function can(user, module, action = 'read') {
  return user?.role === 'admin' || Boolean(user?.permissions?.[module]?.[action]);
}

module.exports = { MODULES, hashPassword, verifyPassword, defaultPermissions, can };
