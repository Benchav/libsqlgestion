const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-analytics-test-'));
process.env.DATABASE_FILE = path.join(tempDir, 'control.db');
process.env.SQLITE_STORAGE_ROOT = path.join(tempDir, 'storage');
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ANALYTICS_ENABLED = 'true';
process.env.ANALYTICS_TRAFFIC_ENABLED = 'true';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { buildServer } = require('../dist/server');
const { Project } = require('../dist/domain/entities/Project');
const { Database } = require('../dist/domain/entities/Database');
const { AuditLog } = require('../dist/domain/entities/AuditLog');
const { User } = require('../dist/domain/entities/User');
const { StorageSample } = require('../dist/domain/entities/StorageSample');
const { analyticsCollector } = require('../dist/application/analytics/AnalyticsCollector');
const { normalizeSql, fingerprintSql } = require('../dist/application/analytics/sql-normalizer');

function parseCookies(response) {
  const result = {};
  const setCookies = response.headers['set-cookie'];
  for (const item of Array.isArray(setCookies) ? setCookies : [setCookies]) {
    const [pair] = item.split(';');
    const [key, value] = pair.split('=');
    if (key && value) result[key.trim()] = value.trim();
  }
  return result;
}

test.describe('Analytics', () => {
  let app;
  let cookieHeader;
  let csrfToken;
  let project;
  let database;

  test.before(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await bootstrapSecurityCatalog();
    app = buildServer();

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'analytics@test.test', password: 'Analytics123!' },
    });
    assert.equal(regRes.statusCode, 200, regRes.payload);
    const cookies = parseCookies(regRes);
    csrfToken = cookies['libsqlite.csrfToken.v2'];
    cookieHeader = `libsqlite.accessToken=${cookies['libsqlite.accessToken']}; libsqlite.csrfToken.v2=${csrfToken}`;

    const user = await AppDataSource.getRepository(User).findOneByOrFail({ email: 'analytics@test.test' });
    const projectRepo = AppDataSource.getRepository(Project);
    project = await projectRepo.save(projectRepo.create({ name: 'Analytics Project', owner: user }));
    const databaseRepo = AppDataSource.getRepository(Database);
    database = await databaseRepo.save(databaseRepo.create({
      name: 'analytics-db',
      type: 'sqlite',
      status: 'active',
      project,
    }));
  });

  test.after(async () => {
    if (app) await app.close();
    await AppDataSource.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('normalizes SQL and removes literals', () => {
    const normalized = normalizeSql("SELECT * FROM sales WHERE email = 'person@example.com' AND id = 42 -- comment");
    assert.equal(normalized, 'SELECT * FROM sales WHERE email = ? AND id = ?');
    assert.equal(normalizeSql(normalized), normalized);
    assert.match(fingerprintSql(normalized), /^[a-f0-9]{64}$/);
  });

  test('collects query, traffic and storage metrics and exposes the overview', async () => {
    analyticsCollector.recordQuery({
      databaseId: database.id,
      projectId: project.id,
      source: 'pipeline',
      sql: "SELECT * FROM sales WHERE email = 'person@example.com'",
      durationMs: 12,
      rowsRead: 100,
      success: true,
    });
    analyticsCollector.recordQuery({
      databaseId: database.id,
      projectId: project.id,
      source: 'pipeline',
      sql: "UPDATE sales SET total = 10 WHERE id = 1",
      durationMs: 35,
      rowsWritten: 2,
      success: true,
    });
    analyticsCollector.recordQuery({
      databaseId: database.id,
      projectId: project.id,
      source: 'pipeline',
      sql: "DELETE FROM sales WHERE id = 999",
      durationMs: 20,
      success: false,
      errorCode: 'SQLITE_ERROR',
    });
    analyticsCollector.recordTraffic({
      databaseId: database.id,
      method: 'POST',
      path: `/api/v1/databases/${database.id}/v2/pipeline`,
      requestBytes: 1200,
      responseBytes: 4000,
      statusCode: 200,
      durationMs: 40,
    });
    analyticsCollector.recordTraffic({
      databaseId: database.id,
      method: 'POST',
      path: `/api/v1/databases/${database.id}/v2/pipeline`,
      requestBytes: 100,
      responseBytes: 50,
      statusCode: 500,
      durationMs: 25,
    });
    const storageRepo = AppDataSource.getRepository(StorageSample);
    await storageRepo.save(storageRepo.create({
      databaseId: database.id,
      projectId: project.id,
      sizeBytes: 1024,
      sampledAt: new Date(),
    }));

    await analyticsCollector.flush();

    const from = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 1000);
    const params = new URLSearchParams({
      range: 'today',
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics?${params.toString()}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = JSON.parse(response.payload);
    assert.equal(body.summary.rowsRead, 100);
    assert.equal(body.summary.rowsWritten, 2);
    assert.equal(body.summary.queries, 3);
    assert.equal(body.summary.errors, 1);
    assert.ok(Math.abs(body.summary.errorRate - 1 / 3) < 0.0001);
    assert.ok(body.summary.trafficInBytes >= 1300);
    assert.ok(body.summary.trafficOutBytes >= 4050);
    assert.ok(body.summary.storageBytes >= 1024);
    assert.equal(body.summary.requests, 2);
    assert.equal(body.series.labels.length, 3);
    assert.deepEqual(body.series.queries, [0, 0, 3]);
    assert.deepEqual(body.series.errors, [0, 0, 1]);
    assert.equal(body.series.latencyAvg[0], null);
    assert.equal(body.series.latencyP95[0], null);
    assert.equal(body.series.latencyP95[2], 35);
    assert.ok(body.series.trafficIn[2] >= 1300);
    assert.ok(body.series.trafficOut[2] >= 4050);
    assert.equal(body.series.storage[0], 0);
    assert.ok(body.series.storage[2] >= 1024);
    assert.equal(body.sources[0].source, 'pipeline');
    assert.equal(body.sources[0].queries, 3);
    assert.deepEqual(
      body.statusCodes.map((row) => row.statusCode).sort(),
      [200, 500],
    );
    assert.equal(body.topDatabases[0].name, 'analytics-db');
    assert.equal(body.topProjects[0].name, 'Analytics Project');
    assert.ok(body.topQueries.length >= 1);
    assert.ok(body.topQueries[0].sqlPreview.includes('?'));
    assert.ok(!body.topQueries[0].sqlPreview.includes('person@example.com'));
    assert.ok(body.topQueriesByRowsRead[0].rowsRead >= 100);
    assert.ok(Array.isArray(body.topQueriesByRowsWritten));
    assert.ok(Array.isArray(body.topQueriesByFrequency));
    assert.equal(body.topErrors[0].errorCode, 'SQLITE_ERROR');
    assert.ok(body.topErrors[0].lastSeenAt);
  });

  test('shows friendly names and labels deleted databases without raw UUIDs', async () => {
    const databaseRepo = AppDataSource.getRepository(Database);
    const uuid = '11111111-1111-4111-8111-111111111111';
    const uuidDatabase = await databaseRepo.save(databaseRepo.create({
      name: uuid,
      type: 'sqlite',
      status: 'active',
      subdomain: 'friendly-subdomain',
      project,
    }));

    const deletedDatabase = await databaseRepo.save(databaseRepo.create({
      name: 'ERP Histórico',
      type: 'libsql',
      status: 'active',
      project,
    }));
    const deletedDatabaseId = deletedDatabase.id;
    const auditRepo = AppDataSource.getRepository(AuditLog);
    await auditRepo.save(auditRepo.create({
      action: 'database.delete',
      resourceType: 'database',
      resourceId: deletedDatabaseId,
      metadata: { name: 'ERP Histórico', type: 'libsql' },
    }));
    await databaseRepo.remove(deletedDatabase);

    const unknownDatabaseId = '22222222-2222-4222-8222-222222222222';
    const createdAt = new Date(Date.now() - 30_000).toISOString().slice(0, 19).replace('T', ' ');
    const metrics = [
      [uuidDatabase.id, 700],
      [deletedDatabaseId, 600],
      [unknownDatabaseId, 500],
    ];
    for (const [databaseId, rowsRead] of metrics) {
      await AppDataSource.query(
        `INSERT INTO query_metrics
           (databaseId, projectId, source, operation, sqlFingerprint, sqlPreview, durationMs, rowsRead, rowsWritten, success, createdAt)
         VALUES (?, ?, 'api', 'select', ?, 'SELECT 1', 5, ?, 0, 1, ?)`,
        [databaseId, project.id, `friendly-name-${databaseId}`, rowsRead, createdAt],
      );
    }

    const from = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 1000);
    const params = new URLSearchParams({
      range: 'today',
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics?${params.toString()}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = JSON.parse(response.payload);
    const byId = new Map(body.topDatabases.map((row) => [row.id, row]));

    const friendly = byId.get(uuidDatabase.id);
    assert.ok(friendly);
    assert.equal(friendly.displayName, 'friendly-subdomain');
    assert.equal(friendly.name, 'friendly-subdomain');
    assert.equal(friendly.exists, true);
    assert.equal(friendly.deleted, false);
    assert.equal(friendly.needsRename, true);

    const deleted = byId.get(deletedDatabaseId);
    assert.ok(deleted);
    assert.equal(deleted.displayName, 'ERP Histórico');
    assert.equal(deleted.name, 'ERP Histórico');
    assert.equal(deleted.exists, false);
    assert.equal(deleted.deleted, true);

    const unknown = byId.get(unknownDatabaseId);
    assert.ok(unknown);
    assert.equal(unknown.displayName, 'Deleted database');
    assert.equal(unknown.exists, false);
    assert.equal(unknown.deleted, true);
  });

  test('zero-fills day buckets and carries storage forward', async () => {
    const otherDatabaseId = '00000000-0000-4000-8000-000000000001';
    const to = new Date(Date.now() - 60 * 60 * 1000);
    const from = new Date(to.getTime() - 4 * 24 * 60 * 60 * 1000 - 60 * 1000);
    const sqlDate = (value) => value.toISOString().slice(0, 19).replace('T', ' ');
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    const samples = [
      { offset: HOUR, size: 100 },
      { offset: DAY + HOUR, size: 200 },
      { offset: 2 * DAY + HOUR, size: 300 },
      { offset: 3 * DAY + HOUR, size: 400 },
    ];
    for (const sample of samples) {
      await AppDataSource.query(
        `INSERT INTO storage_samples (databaseId, projectId, sizeBytes, sampledAt)
         VALUES (?, ?, ?, ?)`,
        [otherDatabaseId, project.id, sample.size, sqlDate(new Date(from.getTime() + sample.offset))],
      );
    }

    const queries = [
      { offset: HOUR, durationMs: 10 },
      { offset: 2 * DAY + HOUR, durationMs: 50 },
      { offset: 2 * DAY + 2 * HOUR, durationMs: 30 },
    ];
    for (const query of queries) {
      await AppDataSource.query(
        `INSERT INTO query_metrics
           (databaseId, projectId, source, operation, sqlFingerprint, sqlPreview, durationMs, rowsRead, rowsWritten, success, createdAt)
         VALUES (?, ?, 'api', 'select', 'bucket-test', 'SELECT 1', ?, 0, 0, 1, ?)`,
        [otherDatabaseId, project.id, query.durationMs, sqlDate(new Date(from.getTime() + query.offset))],
      );
    }

    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics?${params.toString()}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = JSON.parse(response.payload);
    assert.equal(body.bucket, 'day');
    assert.equal(body.series.labels.length, 5);
    assert.deepEqual(body.series.queries, [1, 0, 2, 0, 0]);
    assert.deepEqual(body.series.latencyP95, [10, null, 50, null, null]);
    assert.equal(body.series.latencyAvg[2], 40);
    assert.deepEqual(body.series.storage, [100, 200, 300, 400, 400]);
  });

  test('flushes large batches in chunks', async () => {
    const { QueryMetric } = require('../dist/domain/entities/QueryMetric');
    const repo = AppDataSource.getRepository(QueryMetric);

    for (let index = 0; index < 1200; index += 1) {
      analyticsCollector.recordQuery({
        databaseId: database.id,
        projectId: project.id,
        source: 'api',
        sql: `SELECT * FROM sales WHERE id = ${index}`,
        durationMs: 1,
        rowsRead: 1,
        success: true,
      });
    }

    await analyticsCollector.flush();
    const total = await repo.countBy({ databaseId: database.id });
    assert.equal(total, 1203);
  });
});
