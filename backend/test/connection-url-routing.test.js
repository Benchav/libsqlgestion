const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_PUBLIC_DOMAIN = 'ibarerra.site';
process.env.DATABASE_PUBLIC_PROTOCOL = 'https';

const { buildDatabaseConnectionUrls } = require('../dist/application/databases/connection-url');
const { presentDatabase } = require('../dist/presentation/http/database-presenter');

test('local sqlite database exposes local-only backend/internal urls', () => {
  const database = {
    id: 'db-local-1',
    name: 'insumosv1',
    type: 'sqlite',
    status: 'active',
    subdomain: 'insumosv1',
    url: '/app/data/sqlite/projects/p1/databases/db-local-1.db',
    metadata: {
      runtime: {
        provider: 'local-file',
        databasePath: '/app/data/sqlite/projects/p1/databases/db-local-1.db',
        connectionUrl: '/app/data/sqlite/projects/p1/databases/db-local-1.db',
        internalUrl: '/app/data/sqlite/projects/p1/databases/db-local-1.db',
        publicUrl: '/app/data/sqlite/projects/p1/databases/db-local-1.db',
      },
    },
  };

  const urls = buildDatabaseConnectionUrls(database);
  assert.equal(urls.publicUrl, '');
  assert.equal(urls.publicHttpsUrl, '');
  assert.equal(urls.publicLibsqlUrl, '');
  assert.equal(urls.internalUrl, database.url);
  assert.equal(urls.backendUrl, database.url);

  const presented = presentDatabase(database);
  assert.equal(presented.effectiveType, 'sqlite');
  assert.equal(presented.runtimeProvider, 'local-file');
  assert.equal(presented.preferredLocalConnectionUrl, database.url);
  assert.equal(presented.preferredRemoteConnectionUrl, '');
  assert.equal(presented.connectionUrl, database.url);
  assert.equal(presented.backendConnectionUrl, database.url);
  assert.equal(presented.internalConnectionUrl, database.url);
});

test('docker libsql database exposes backend and public urls correctly', () => {
  const database = {
    id: 'db-runtime-1',
    name: 'insumosv1',
    type: 'libsql',
    status: 'active',
    subdomain: 'insumosv1',
    url: '/app/data/sqlite/projects/p1/databases/db-runtime-1/data',
    metadata: {
      runtime: {
        provider: 'docker-libsql',
        databasePath: '/app/data/sqlite/projects/p1/databases/db-runtime-1/data',
        internalUrl: 'http://libsqlite-db-runtime-1:8080',
        backendUrl: 'http://host.docker.internal:34123',
        connectionUrl: 'http://libsqlite-db-runtime-1:8080',
        publicUrl: 'https://insumosv1.ibarerra.site',
      },
    },
  };

  const urls = buildDatabaseConnectionUrls(database);
  assert.equal(urls.internalUrl, 'http://libsqlite-db-runtime-1:8080');
  assert.equal(urls.backendUrl, 'http://host.docker.internal:34123');
  assert.equal(urls.publicHttpsUrl, 'https://insumosv1.ibarerra.site');
  assert.equal(urls.publicLibsqlUrl, 'libsql://insumosv1.ibarerra.site');

  const presented = presentDatabase(database);
  assert.equal(presented.effectiveType, 'libsql');
  assert.equal(presented.runtimeProvider, 'docker-libsql');
  assert.equal(presented.preferredLocalConnectionUrl, 'http://host.docker.internal:34123');
  assert.equal(presented.preferredRemoteConnectionUrl, 'libsql://insumosv1.ibarerra.site');
  assert.equal(presented.connectionUrl, 'libsql://insumosv1.ibarerra.site');
  assert.equal(presented.backendConnectionUrl, 'http://host.docker.internal:34123');
  assert.equal(presented.internalConnectionUrl, 'http://libsqlite-db-runtime-1:8080');
  assert.equal(presented.publicHttpsUrl, 'https://insumosv1.ibarerra.site');
  assert.equal(presented.publicLibsqlUrl, 'libsql://insumosv1.ibarerra.site');
});
