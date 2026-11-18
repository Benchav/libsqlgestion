const test = require('node:test');
const assert = require('node:assert/strict');

// Set the public routing defaults BEFORE loading modules that cache them.
process.env.DATABASE_PUBLIC_DOMAIN = 'data.example.com';
process.env.DATABASE_PUBLIC_PROTOCOL = 'https';
process.env.DATABASE_PUBLIC_BASE_URL = 'https://data.example.com';

const { buildDatabaseConnectionUrls } = require('../dist/application/databases/connection-url');
const { presentDatabase } = require('../dist/presentation/http/database-presenter');
const { LibsqlNamespaceService } = require('../dist/infrastructure/libsql/LibsqlNamespaceService');

test.describe('Public connection URL routing', () => {
  test('builds host-based namespace URLs without a path', () => {
    const service = new LibsqlNamespaceService();
    const urls = service.buildNamespaceUrls('erp-db');

    assert.equal(urls.publicUrl, 'https://erp-db.data.example.com');
    assert.ok(urls.internalUrl.endsWith('/dev/erp-db/'));
    assert.ok(urls.backendUrl.endsWith('/dev/erp-db/'));
  });

  test('advertises the libsql sync URL for a sqld namespace', () => {
    const database = {
      id: 'db-namespace',
      name: 'ERP Namespace',
      type: 'libsql',
      subdomain: 'erp-db',
      metadata: {
        runtime: {
          provider: 'sqld-namespace',
          namespace: 'erp-db',
          connectionUrl: 'http://sqld:8080/dev/erp-db/',
          internalUrl: 'http://sqld:8080/dev/erp-db/',
          backendUrl: 'http://sqld:8080/dev/erp-db/',
          publicUrl: 'https://erp-db.data.example.com',
          publicHost: 'data.example.com',
        },
      },
    };

    const urls = buildDatabaseConnectionUrls(database);
    assert.equal(urls.publicUrl, 'https://erp-db.data.example.com');
    assert.equal(urls.publicHttpsUrl, 'https://erp-db.data.example.com');
    assert.equal(urls.publicLibsqlUrl, 'libsql://erp-db.data.example.com');
    assert.equal(urls.syncUrl, 'libsql://erp-db.data.example.com');

    const presented = presentDatabase(database);
    assert.equal(presented.embeddedReplicaSupported, true);
    assert.equal(presented.syncUrl, 'libsql://erp-db.data.example.com');
  });

  test('does not advertise a sync URL for LOCAL-FILE databases', () => {
    const database = {
      id: 'db-local',
      name: 'Local ERP',
      type: 'sqlite',
      metadata: {
        runtime: {
          provider: 'local-file',
          connectionUrl: '/app/data/sqlite/projects/p/databases/db-local.db',
          internalUrl: '/app/data/sqlite/projects/p/databases/db-local.db',
          backendUrl: '/app/data/sqlite/projects/p/databases/db-local.db',
          publicUrl: '/app/data/sqlite/projects/p/databases/db-local.db',
        },
      },
    };

    const urls = buildDatabaseConnectionUrls(database);
    assert.equal(urls.publicUrl, 'https://data.example.com/api/v1/databases/db-local/');
    assert.equal(urls.syncUrl, '');

    const presented = presentDatabase(database);
    assert.equal(presented.embeddedReplicaSupported, false);
    assert.equal(presented.syncUrl, '');
  });
});
