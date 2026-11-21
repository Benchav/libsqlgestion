const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createClient } = require('@libsql/client');

const { createGatewayServer } = require('../dist/gateway/server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function request(port, path, { method = 'POST', host = 'db1.data.test', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.describe('Policy gateway', () => {
  let upstream;
  let upstreamPort;
  let gateway;
  let gatewayPort;
  let upstreamCalls;
  let policy;
  let policyError;
  let policyCalls;

  test.before(async () => {
    upstreamCalls = [];
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        upstreamCalls.push({ method: req.method, url: req.url, body, host: req.headers.host });
        if (req.url === '/v2/pipeline') {
          const requests = Array.isArray(body.requests) ? body.requests : [];
          const results = requests.map((item) => {
            if (item.type === 'store_sql') {
              return { type: 'ok', response: { type: 'store_sql' } };
            }
            if (item.type === 'close_sql') {
              return { type: 'ok', response: { type: 'close_sql' } };
            }
            if (item.type === 'sequence') {
              return { type: 'ok', response: { type: 'sequence' } };
            }
            if (item.type === 'batch') {
              const steps = item.batch?.steps || [];
              return {
                type: 'ok',
                response: {
                  type: 'batch',
                  result: {
                    step_results: steps.map(() => ({
                      cols: [{ name: 'x' }],
                      rows: [[{ type: 'integer', value: '1' }]],
                      affected_row_count: 1,
                      last_insert_rowid: '1',
                    })),
                    step_errors: steps.map(() => null),
                  },
                },
              };
            }
            return {
              type: 'ok',
              response: {
                type: 'execute',
                result: {
                  cols: [{ name: 'x' }],
                  rows: [[{ type: 'integer', value: '1' }]],
                  affected_row_count: 1,
                  last_insert_rowid: '1',
                },
              },
            };
          });
          const response = {
            baton: requests.some((item) => item.type === 'close') ? null : (body.baton || 'stream-1'),
            base_url: 'http://internal-only:8080',
            results,
          };
          const encoded = Buffer.from(JSON.stringify(response));
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(encoded.length) });
          res.end(encoded);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    upstreamPort = await listen(upstream);

    policyCalls = [];
    policyError = null;
    policy = {
      databaseId: 'db-1',
      subdomain: 'db1',
      provider: 'docker-libsql',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      blockReads: false,
      blockWrites: false,
    };

    gateway = createGatewayServer({
      policyUrl: 'http://127.0.0.1:1/unused',
      internalToken: 'test-token',
      bodyLimitBytes: 1024 * 1024,
      policyTtlMs: 0,
      policyMaxStaleMs: 1000,
      upstreamTimeoutMs: 5000,
      pathPrefix: '/gateway',
    }, {
      resolvePolicy: async (host) => {
        policyCalls.push(host);
        if (policyError) throw policyError;
        return host === 'db1.data.test' || host === '127.0.0.1' ? { ...policy } : null;
      },
    });
    gatewayPort = await listen(gateway);
  });

  test.after(async () => {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  test.beforeEach(() => {
    upstreamCalls.length = 0;
    policyCalls.length = 0;
    policyError = null;
    policy.blockReads = false;
    policy.blockWrites = false;
  });

  test('rewrites base_url and forwards allowed reads', async () => {
    const response = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: { requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }] },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.base_url, null);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, '/v2/pipeline');
    assert.equal(upstreamCalls[0].host, `127.0.0.1:${upstreamPort}`);
  });

  test('blocks writes before forwarding', async () => {
    policy.blockWrites = true;
    const response = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: { requests: [{ type: 'execute', stmt: { sql: "INSERT INTO t VALUES (1)" } }] },
    });
    assert.equal(response.status, 403, response.text);
    assert.equal(response.json.code, 'DATABASE_WRITES_BLOCKED');
    assert.equal(upstreamCalls.length, 0);
  });

  test('blocks reads while allowing writes', async () => {
    policy.blockReads = true;
    const read = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: { requests: [{ type: 'execute', stmt: { sql: 'SELECT * FROM t' } }] },
    });
    assert.equal(read.status, 403, read.text);
    assert.equal(read.json.code, 'DATABASE_READS_BLOCKED');
    assert.equal(upstreamCalls.length, 0);

    const write = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: { requests: [{ type: 'execute', stmt: { sql: "INSERT INTO t VALUES (2)" } }] },
    });
    assert.equal(write.status, 200, write.text);
    assert.equal(upstreamCalls.length, 1);
  });

  test('rejects mixed batches atomically', async () => {
    policy.blockWrites = true;
    const response = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: {
        requests: [{
          type: 'batch',
          batch: {
            steps: [
              { stmt: { sql: 'SELECT 1' } },
              { stmt: { sql: "INSERT INTO t VALUES (3)" } },
            ],
          },
        }],
      },
    });
    assert.equal(response.status, 403, response.text);
    assert.equal(upstreamCalls.length, 0);
  });

  test('rejects a sequence containing a write', async () => {
    policy.blockWrites = true;
    const response = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: {
        requests: [{ type: 'sequence', sql: "SELECT 1; INSERT INTO t VALUES (4);" }],
      },
    });
    assert.equal(response.status, 403, response.text);
    assert.equal(upstreamCalls.length, 0);
  });

  test('keeps stored SQL across a baton and blocks a later write', async () => {
    const first = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: {
        requests: [{ type: 'store_sql', sql_id: 9, sql: 'INSERT INTO t VALUES (5)' }],
      },
    });
    assert.equal(first.status, 200, first.text);

    policy.blockWrites = true;
    const second = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: {
        baton: 'stream-1',
        requests: [{ type: 'execute', stmt: { sql_id: 9 } }],
      },
    });
    assert.equal(second.status, 403, second.text);
    assert.equal(upstreamCalls.length, 1, 'only the first store_sql request may reach upstream');
  });

  test('rejects a baton whose stream state was lost when SQL is referenced', async () => {
    policy.blockWrites = true;
    const response = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: {
        baton: 'unknown-baton',
        requests: [{ type: 'execute', stmt: { sql_id: 77 } }],
      },
    });
    assert.equal(response.status, 409, response.text);
    assert.equal(response.json.code, 'GATEWAY_STREAM_STATE_LOST');
    assert.equal(upstreamCalls.length, 0);
  });

  test('fails closed when policy is unavailable and no cache exists', async () => {
    policyError = new Error('policy backend down');
    const response = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: { requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }] },
      host: 'uncached.data.test',
    });
    assert.equal(response.status, 503, response.text);
    assert.equal(response.json.code, 'GATEWAY_POLICY_UNAVAILABLE');
    assert.equal(upstreamCalls.length, 0);
  });

  test('returns 404 for an unknown host', async () => {
    const response = await request(gatewayPort, '/gateway/v2/pipeline', {
      body: { requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }] },
      host: 'missing.data.test',
    });
    assert.equal(response.status, 404, response.text);
  });

  test('works with the real @libsql/client HTTP and libsql path', async () => {
    const httpClient = createClient({
      url: `http://127.0.0.1:${gatewayPort}/gateway/`,
      authToken: 'test-token',
    });
    const libsqlClient = createClient({
      url: `libsql://127.0.0.1:${gatewayPort}/gateway/?tls=0`,
      authToken: 'test-token',
    });
    try {
      const result = await httpClient.execute('SELECT 1');
      assert.equal(Number(result.rows[0].x), 1);

      const transaction = await httpClient.transaction('write');
      await transaction.execute("INSERT INTO t VALUES ('tx')");
      await transaction.commit();

      policy.blockWrites = true;
      const blockedTransaction = await httpClient.transaction('write');
      const callsAfterBegin = upstreamCalls.length;
      await assert.rejects(
        () => blockedTransaction.execute("INSERT INTO t VALUES ('tx-blocked')"),
        (error) => {
          assert.match(String(error?.message || error), /403|blocked/i);
          return true;
        },
      );
      assert.equal(upstreamCalls.length, callsAfterBegin, 'the blocked transaction write must not reach upstream');
      assert.equal(
        upstreamCalls.some((call) => JSON.stringify(call.body).includes('tx-blocked')),
        false,
      );
      await blockedTransaction.rollback();

      await assert.rejects(
        () => httpClient.execute("INSERT INTO t VALUES (6)"),
        (error) => {
          assert.match(String(error?.message || error), /403|blocked/i);
          return true;
        },
      );
      assert.equal(
        upstreamCalls.some((call) => JSON.stringify(call.body).includes("INSERT INTO t VALUES (6)")),
        false,
      );

      await assert.rejects(
        () => libsqlClient.execute("INSERT INTO t VALUES (7)"),
        (error) => {
          assert.match(String(error?.message || error), /403|blocked/i);
          return true;
        },
      );
      assert.equal(
        upstreamCalls.some((call) => JSON.stringify(call.body).includes("INSERT INTO t VALUES (7)")),
        false,
      );
    } finally {
      httpClient.close();
      libsqlClient.close();
    }
  });

  test('rejects WebSocket upgrades instead of bypassing policy', async () => {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: gatewayPort,
        path: '/gateway',
        headers: {
          host: 'db1.data.test',
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.status, 501);
    assert.match(response.text, /WebSocket upgrades are not supported/);
  });
});
