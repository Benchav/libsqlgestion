const test = require('node:test');
const assert = require('node:assert/strict');

// Public routing defaults are cached when the settings module is loaded.
process.env.DATABASE_PUBLIC_HOST = 'data.example.com';
process.env.DATABASE_PUBLIC_PROTOCOL = 'https';
process.env.DATABASE_PUBLIC_DOMAIN = 'data.example.com';

const { LibsqlRuntimeService } = require('../dist/infrastructure/docker/LibsqlRuntimeService');

test.describe('LibSQL runtime URL building', () => {
  test('uses plain HTTP for the published host port', () => {
    const service = new LibsqlRuntimeService();
    assert.equal(
      service['buildPublicUrl']('32769'),
      'http://data.example.com:32769',
      'the published sqld port speaks HTTP; TLS is terminated by Traefik',
    );
    assert.equal(
      service['buildBackendUrl']('32769'),
      'http://data.example.com:32769',
    );
  });

  test('uses HTTPS and the wildcard domain for the canonical public URL', () => {
    const service = new LibsqlRuntimeService();
    assert.equal(
      service['buildCanonicalPublicUrl']('erp-db', '32769'),
      'https://erp-db.data.example.com',
    );
  });
});
