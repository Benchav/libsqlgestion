const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { encrypt, decrypt } = require('../dist/infrastructure/crypto');
const { randomToken, hashToken } = require('../dist/infrastructure/security/tokens');
const { slugify, ensureSubdomain } = require('../dist/infrastructure/security/slug');
const { issueCsrfToken } = require('../dist/presentation/http/csrf');

test('crypto round trip', () => {
  const secret = 'libsqlite-token';
  const encrypted = encrypt(secret);
  assert.equal(decrypt(encrypted), secret);
});

test('token hashing is stable', () => {
  const token = randomToken();
  assert.equal(token.length, 64);
  assert.equal(hashToken(token).length, 64);
  assert.equal(hashToken(token), hashToken(token));
});

test('slug and subdomain generation', () => {
  assert.equal(slugify('Hola Mundo!'), 'hola-mundo');
  assert.match(ensureSubdomain('My Project', 'abcdef123456'), /^my-project-abcdef12$/);
});

test('csrf token is random hex', () => {
  const token = issueCsrfToken();
  assert.equal(token.length, 64);
  assert.match(token, /^[a-f0-9]+$/);
});
