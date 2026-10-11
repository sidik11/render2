'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

test('server.js passes Node syntax validation', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', serverPath], { stdio: 'pipe' }));
});

test('rate limits use Firebase transactions in production', () => {
  assert.match(source, /async function rateLimit\([\s\S]*?transact\(pathName,current=>/);
  assert.doesNotMatch(source, /await await rateLimit\(/);
});

test('password reset attempts and single-use consumption are transactional', () => {
  assert.match(source, /transact\('passwordResets\/'\+user\.uid/);
  assert.match(source, /consumedBy:requestId/);
  assert.match(source, /const valid=\/\^\\d\{6\}\$\//);
  assert.doesNotMatch(source, /forgot-confirm-email[^\n]*,otp=/);
});

test('record updates do not overwrite subscription and purchase collections from stale snapshots', () => {
  assert.doesNotMatch(source, /await set\('subscriptions',\s*subs\)/);
  assert.doesNotMatch(source, /await set\('purchases',\s*ps\)/);
  assert.match(source, /transact\('subscriptions',current=>/);
  assert.match(source, /transact\('purchases',current=>/);
});

if (path.basename(path.dirname(serverPath)) === 'render2') {
  test('Server 2 validates sessions against Server 1 and checks shared premium entitlement', () => {
    assert.match(source, /\/api\/internal\/auth\/verify/);
    assert.match(source, /\/api\/internal\/subscription\/active/);
    assert.match(source, /INTERNAL_AUTH_SECRET/);
    assert.match(source, /if\(await server1ActiveSubscription\(user\.uid\)\) return false/);
  });
} else {
  test('internal verification endpoints reject missing shared secrets', () => {
    assert.match(source, /if\(!process\.env\.INTERNAL_AUTH_SECRET \|\| String\(req\.headers\['x-internal-auth'\]/);
    assert.match(source, /async function activeSubscription\(uidValue\)/);
  });
}
