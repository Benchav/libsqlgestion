const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-namespace-test-'));
process.env.LIBSQL_AUTH_DIR = tempDir;
process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { LibsqlNamespaceService } = require('../dist/infrastructure/libsql/LibsqlNamespaceService');

test.describe('LibsqlNamespaceService Multitenancy Tests', () => {
  let namespaceService;
  let mockServer;
  let mockPort;
  const receivedRequests = [];

  test.before(async () => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedRequests.push({ method: req.method, url: req.url, body });
        if (req.url && req.url.startsWith('/v1/namespaces/') && req.url.endsWith('/create')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.method === 'DELETE' && req.url && req.url.startsWith('/v1/namespaces/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      process.env.LIBSQL_ADMIN_URL = `http://127.0.0.1:${mockPort}`;
      namespaceService = new LibsqlNamespaceService();
      resolve();
    }));
  });

  test.after(async () => {
    if (mockServer) {
      await new Promise((resolve) => mockServer.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('generates and persists Ed25519 keypair', () => {
    const keys = namespaceService.ensureAuthKeys();
    assert.ok(keys.publicKeyPem.includes('BEGIN PUBLIC KEY'));
    assert.ok(fs.existsSync(path.join(tempDir, 'auth.pem')));
    assert.ok(fs.existsSync(path.join(tempDir, 'auth.key')));
  });

  test('generates JWT token scoped to namespace with valid signature', () => {
    const namespace = 'facturacion-empresa-a';
    const token = namespaceService.generateToken(namespace);
    assert.ok(typeof token === 'string');

    const parts = token.split('.');
    assert.equal(parts.length, 3, 'JWT should have 3 segments');

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    assert.equal(header.alg, 'EdDSA');
    assert.equal(header.typ, 'JWT');

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    assert.equal(payload.a, 'rw');
    assert.equal(payload.ns, namespace);

    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], 'base64url');
    const { publicKeyPem } = namespaceService.ensureAuthKeys();
    const verified = crypto.verify(null, Buffer.from(signingInput), publicKeyPem, signature);
    assert.equal(verified, true, 'Token signature must be valid');
  });

  test('tokens for different namespaces are distinct and strictly scoped', () => {
    const tokenA = namespaceService.generateToken('db-clientes');
    const tokenB = namespaceService.generateToken('db-inventarios');

    assert.notEqual(tokenA, tokenB);

    const payloadA = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url').toString('utf8'));
    const payloadB = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64url').toString('utf8'));

    assert.equal(payloadA.ns, 'db-clientes');
    assert.equal(payloadB.ns, 'db-inventarios');
  });

  test('creates namespace via Admin API', async () => {
    const res = await namespaceService.createNamespace('test-db-1');
    assert.equal(res.ok, true);

    const match = receivedRequests.find((r) => r.method === 'POST' && r.url === '/v1/namespaces/test-db-1/create');
    assert.ok(match, 'POST request must reach Admin API');
  });

  test('deletes namespace via Admin API', async () => {
    const res = await namespaceService.deleteNamespace('test-db-1');
    assert.equal(res.ok, true);

    const match = receivedRequests.find((r) => r.method === 'DELETE' && r.url === '/v1/namespaces/test-db-1');
    assert.ok(match, 'DELETE request must reach Admin API');
  });

  test('builds correct namespace connection URLs', () => {
    const urls = namespaceService.buildNamespaceUrls('mi-tienda');
    assert.ok(urls.internalUrl.includes('/dev/mi-tienda'));
    assert.ok(urls.backendUrl.includes('/dev/mi-tienda'));
    assert.ok(urls.publicUrl.includes('mi-tienda'));
  });
});
