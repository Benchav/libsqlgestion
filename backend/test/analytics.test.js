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
process.env.GATEWAY_INTERNAL_TOKEN = 'test-gateway-token';

const { AppDataSource } = require('../dist/infrastructure/db/data-source');
const { bootstrapSecurityCatalog } = require('../dist/application/auth/auth.bootstrap');
const { buildServer } = require('../dist/server');
const { Project } = require('../dist/domain/entities/Project');
const { Database } = require('../dist/domain/entities/Database');
const { AuditLog } = require('../dist/domain/entities/AuditLog');
const { User } = require('../dist/domain/entities/User');
const { StorageSample } = require('../dist/domain/entities/StorageSample');
const { analyticsCollector } = require('../dist/application/analytics/AnalyticsCollector');
const { normalizeSql, fingerprintSql, detectOperation } = require('../dist/application/analytics/sql-normalizer');

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

  test('classifies CTE writes by their main statement', () => {
    assert.equal(detectOperation('SELECT 1'), 'select');
    assert.equal(detectOperation('WITH x AS (SELECT 1) SELECT * FROM x'), 'select');
    assert.equal(detectOperation('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'), 'insert');
    assert.equal(detectOperation('/* migration */ UPDATE t SET x = 1'), 'update');
    assert.equal(detectOperation('REPLACE INTO t VALUES (1)'), 'replace');
    assert.equal(detectOperation('PRAGMA table_info(t)'), 'pragma');
  });

  test('collects query, traffic and storage metrics and exposes the overview', async () => {
    // Fix the window before inserting metrics. Computing "now - 2h" after the
    // flush can push the rows into the previous one-hour bucket when the test
    // crosses an hour boundary.
    const from = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 1000);

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
    assert.equal(body.summary.readQueries, 1);
    assert.equal(body.summary.writeQueries, 2);
    assert.equal(body.summary.activeDatabases, 1);
    assert.equal(body.summary.totalDatabases, 1);
    assert.ok(body.summary.queriesPerHour > 0);
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
    assert.equal(body.series.readQueries[2], 1);
    assert.equal(body.series.writeQueries[2], 2);
    assert.ok(body.series.trafficIn[2] >= 1300);
    assert.ok(body.series.trafficOut[2] >= 4050);
    assert.equal(body.series.storage[0], 0);
    assert.ok(body.series.storage[2] >= 1024);
    assert.equal(body.sources[0].source, 'pipeline');
    assert.equal(body.sources[0].queries, 3);
    assert.ok(body.operations.some((row) => row.operation === 'select' && row.queries === 1));
    assert.ok(body.operations.some((row) => row.operation === 'update' && row.queries === 1));
    assert.ok(body.operations.some((row) => row.operation === 'delete' && row.errors === 1));
    assert.deepEqual(
      body.statusCodes.map((row) => row.statusCode).sort(),
      [200, 500],
    );
    assert.equal(body.topDatabases[0].name, 'analytics-db');
    assert.equal(body.topDatabases[0].readQueries, 1);
    assert.equal(body.topDatabases[0].writeQueries, 2);
    assert.equal(body.topDatabases[0].errors, 1);
    assert.ok(body.topDatabases[0].p95DurationMs > 0);
    assert.ok(body.topDatabases[0].lastSeenAt);
    assert.equal(body.topProjects[0].name, 'Analytics Project');
    assert.equal(body.topProjects[0].readQueries, 1);
    assert.equal(body.topProjects[0].writeQueries, 2);
    assert.ok(body.topQueries.length >= 1);
    assert.ok(body.topQueries[0].sqlPreview.includes('?'));
    assert.ok(!body.topQueries[0].sqlPreview.includes('person@example.com'));
    assert.ok(body.topQueries.every((query) => typeof query.operation === 'string'));
    assert.ok(body.topQueriesByRowsRead[0].rowsRead >= 100);
    assert.ok(Array.isArray(body.topQueriesByRowsWritten));
    assert.ok(Array.isArray(body.topQueriesByFrequency));
    assert.equal(body.topErrors[0].errorCode, 'SQLITE_ERROR');
    assert.ok(body.topErrors[0].lastSeenAt);
  });

  test('excludes deleted and unknown databases from usage metrics', async () => {
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
    assert.equal(friendly.needsRename, true);
    assert.equal(friendly.rowsRead, 700);

    assert.equal(byId.has(deletedDatabaseId), false);
    assert.equal(byId.has(unknownDatabaseId), false);

    // 100 rows from the first test + 700 from the real database. The deleted
    // and unknown rows must not contribute to the summary.
    assert.equal(body.summary.rowsRead, 800);
    assert.equal(body.summary.queries, 4);
  });

  test('lists all existing databases including zero-usage databases', async () => {
    const databaseRepo = AppDataSource.getRepository(Database);
    const emptyDatabase = await databaseRepo.save(databaseRepo.create({
      name: 'empty-usage-db',
      type: 'sqlite',
      status: 'active',
      metadata: { runtime: { provider: 'docker-libsql' } },
      project,
    }));

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

    const empty = body.databaseUsage.find((item) => item.id === emptyDatabase.id);
    assert.ok(empty, 'zero-usage database must be present');
    assert.equal(empty.hasActivity, false);
    assert.equal(empty.queries, 0);
    assert.equal(empty.readQueries, 0);
    assert.equal(empty.writeQueries, 0);
    assert.equal(empty.lastSource, null);
    assert.equal(empty.lastSeenAt, null);
    assert.equal(empty.p95DurationMs, 0);
    assert.equal(empty.storageBytes, 0);
    assert.equal(empty.runtimeProvider, 'docker-libsql');

    const active = body.databaseUsage.find((item) => item.id === database.id);
    assert.ok(active);
    assert.equal(active.hasActivity, true);
    assert.equal(active.lastSource, 'pipeline');
    assert.equal(body.databaseUsage.length >= 2, true);
  });

  test('filters every aggregate by databaseId', async () => {
    const from = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 1000);
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      databaseId: database.id,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics?${params.toString()}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = JSON.parse(response.payload);

    assert.equal(body.databaseId, database.id);
    assert.equal(body.database.id, database.id);
    assert.equal(body.summary.queries, 3);
    assert.equal(body.summary.activeDatabases, 1);
    assert.equal(body.summary.totalDatabases, 1);
    assert.equal(body.series.queries.reduce((total, value) => total + value, 0), 3);
    assert.equal(body.topProjects.length, 1);
    assert.equal(body.topProjects[0].id, project.id);
    assert.equal(body.databaseUsage.some((item) => item.id === database.id), true);
  });

  test('rejects an unknown database filter', async () => {
    const params = new URLSearchParams({
      databaseId: '11111111-1111-4111-8111-111111111111',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics?${params.toString()}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.payload, /database not found/i);
  });

  test('zero-fills day buckets and carries storage forward', async () => {
    const databaseRepo = AppDataSource.getRepository(Database);
    const otherDatabase = await databaseRepo.save(databaseRepo.create({
      name: 'bucket-db',
      type: 'sqlite',
      status: 'active',
      project,
    }));
    const otherDatabaseId = otherDatabase.id;
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

  test('ingests gateway usage for existing databases only', async () => {
    const databaseRepo = AppDataSource.getRepository(Database);
    const gatewayDatabase = await databaseRepo.save(databaseRepo.create({
      name: 'gateway-db',
      type: 'sqlite',
      status: 'active',
      project,
    }));
    const unknownId = '33333333-3333-4333-8333-333333333333';
    const payload = {
      queries: [
        {
          databaseId: gatewayDatabase.id,
          sql: 'SELECT * FROM sales',
          durationMs: 11,
          rowsRead: 7,
          success: true,
        },
        {
          databaseId: gatewayDatabase.id,
          sql: 'INSERT INTO sales (total) VALUES (?)',
          durationMs: 5,
          rowsWritten: 1,
          success: true,
        },
        {
          databaseId: unknownId,
          sql: 'SELECT 1',
          durationMs: 1,
          success: true,
        },
      ],
      traffic: [{
        databaseId: gatewayDatabase.id,
        method: 'POST',
        path: '/v2/pipeline',
        requestBytes: 100,
        responseBytes: 200,
        statusCode: 200,
        durationMs: 11,
      }],
    };

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/gateway/analytics',
      payload,
    });
    assert.equal(unauthorized.statusCode, 401, unauthorized.payload);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/gateway/analytics',
      headers: { 'x-gateway-token': 'test-gateway-token' },
      payload,
    });
    assert.equal(response.statusCode, 202, response.payload);
    assert.equal(JSON.parse(response.payload).accepted, 3);

    await analyticsCollector.flush();

    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 1000);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    const analytics = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics?${params.toString()}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(analytics.statusCode, 200, analytics.payload);
    const body = JSON.parse(analytics.payload);
    const row = body.topDatabases.find((item) => item.id === gatewayDatabase.id);
    assert.ok(row, 'gateway database must appear in top databases');
    assert.equal(row.rowsRead, 7);
    assert.equal(row.rowsWritten, 1);
    assert.equal(row.readQueries, 1);
    assert.equal(row.writeQueries, 1);
    assert.equal(row.lastSource, 'gateway');
    assert.equal(body.sources.some((source) => source.source === 'gateway'), true);
    assert.equal(body.topDatabases.some((item) => item.id === unknownId), false);
  });

  test('returns a compact dashboard analytics payload', async () => {
    const params = new URLSearchParams({ range: '7d' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics/dashboard?${params.toString()}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = JSON.parse(response.payload);
    assert.ok(body.summary);
    assert.ok(body.series);
    assert.ok(Array.isArray(body.operations));
    assert.ok(Array.isArray(body.databaseUsage));
    assert.ok(Array.isArray(body.topDatabases));
    assert.equal(body.topQueries, undefined);
    assert.equal(body.topErrors, undefined);
    assert.ok(body.summary.readQueries >= 1);
    assert.ok(body.summary.writeQueries >= 1);
    assert.equal(body.databaseUsage.some((item) => item.id === database.id), true);
    assert.equal(body.databaseUsage.length >= 2, true);
  });
});
