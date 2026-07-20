'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, defaultPermissions, can } = require('../lib/security');

test('password hashes are salted and verifiable', () => {
  const first = hashPassword('a-secure-password');
  const second = hashPassword('a-secure-password');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('a-secure-password', first), true);
  assert.equal(verifyPassword('wrong', first), false);
});

test('default viewer is read-only and cannot administer users', () => {
  const user = { role: 'viewer', permissions: defaultPermissions('viewer') };
  assert.equal(can(user, 'visualization', 'read'), true);
  assert.equal(can(user, 'visualization', 'write'), false);
  assert.equal(can(user, 'users', 'read'), false);
});
