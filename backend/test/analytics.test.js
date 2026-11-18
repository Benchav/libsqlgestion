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
    analyticsCollector.recordTraffic({
      databaseId: database.id,
      method: 'POST',
      path: `/api/v1/databases/${database.id}/v2/pipeline`,
      requestBytes: 1200,
      responseBytes: 4000,
      statusCode: 200,
      durationMs: 40,
    });
    const storageRepo = AppDataSource.getRepository(StorageSample);
    await storageRepo.save(storageRepo.create({
      databaseId: database.id,
      projectId: project.id,
      sizeBytes: 1024,
      sampledAt: new Date(),
    }));

    await analyticsCollector.flush();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics?range=today',
      headers: { cookie: cookieHeader },
    });
    assert.equal(response.statusCode, 200, response.payload);
    const body = JSON.parse(response.payload);
    assert.equal(body.summary.rowsRead, 100);
    assert.equal(body.summary.rowsWritten, 2);
    assert.equal(body.summary.queries, 2);
    assert.ok(body.summary.trafficInBytes >= 1200);
    assert.ok(body.summary.trafficOutBytes >= 4000);
    assert.ok(body.summary.storageBytes >= 1024);
    assert.ok(body.series.labels.length >= 1);
    assert.equal(body.topDatabases[0].name, 'analytics-db');
    assert.ok(body.topQueries.length >= 1);
    assert.ok(body.topQueries[0].sqlPreview.includes('?'));
    assert.ok(!body.topQueries[0].sqlPreview.includes('person@example.com'));
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
    assert.equal(total, 1202);
  });
});
