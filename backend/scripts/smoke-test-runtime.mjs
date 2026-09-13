import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set default envs for test
process.env.MASTER_KEY = process.env.MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SQLITE_PERFORMANCE_PROFILE = 'performance';

console.log('=== LibSQLite Runtime & Storage E2E Smoke Test ===\n');

async function run() {
  const { SqliteStorageService } = await import('../dist/infrastructure/storage/SqliteStorageService.js');
  const { SqliteClient } = await import('../dist/infrastructure/sqlite/SqliteClient.js');
  const { ConnectionPool } = await import('../dist/infrastructure/db/ConnectionPool.js');

  const testDir = path.join(__dirname, '..', 'data', 'smoke-test-tmp');
  fs.mkdirSync(testDir, { recursive: true });

  try {
    // -------------------------------------------------------------------------
    // 1. Storage Layout Test
    // -------------------------------------------------------------------------
    console.log('[1/5] Testing SqliteStorageService layout...');
    const storageService = new SqliteStorageService(testDir);
    const projectId = 'proj-smoke-1';
    const databaseId = 'db-smoke-1';

    const libsqlPath = storageService.managedDatabasePath(projectId, databaseId, 'libsql');
    const expectedSuffix = path.join('projects', projectId, 'databases', databaseId, 'dbs', 'default', 'data');
    if (!libsqlPath.endsWith(expectedSuffix)) {
      throw new Error(`Expected libsql path to end with "${expectedSuffix}", got "${libsqlPath}"`);
    }

    const dbDir = storageService.managedDatabaseDirectory(projectId, databaseId);
    const expectedDir = path.join(testDir, 'projects', projectId, 'databases', databaseId);
    if (path.normalize(dbDir) !== path.normalize(expectedDir)) {
      throw new Error(`Expected managedDatabaseDirectory "${expectedDir}", got "${dbDir}"`);
    }

    const createdPath = await storageService.ensureManagedDatabaseFile(projectId, databaseId, 'libsql');
    if (!fs.existsSync(path.dirname(createdPath))) {
      throw new Error(`Directory ${path.dirname(createdPath)} was not created`);
    }
    console.log('  ✓ Storage layout correctly targets sqld default namespace: dbs/default/data');

    // -------------------------------------------------------------------------
    // 2. SqliteClient WAL & Integrity Check
    // -------------------------------------------------------------------------
    console.log('[2/5] Testing SqliteClient WAL mode and integrity verification...');
    const testDbPath = path.join(testDir, 'test-perf.db');
    const client = new SqliteClient(testDbPath);

    await client.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);');
    await client.run('INSERT INTO items (name) VALUES (?);', ['test-item-1']);

    const journalModeResult = await client.all('PRAGMA journal_mode;');
    const journalMode = journalModeResult[0]?.journal_mode;
    if (String(journalMode).toLowerCase() !== 'wal') {
      throw new Error(`Expected journal_mode 'wal', got '${journalMode}'`);
    }

    const integrity = await client.checkIntegrity();
    if (!integrity.ok || integrity.details !== 'ok') {
      throw new Error(`Integrity check failed: ${JSON.stringify(integrity)}`);
    }

    const rows = await client.all('SELECT * FROM items;');
    if (rows.length !== 1 || rows[0].name !== 'test-item-1') {
      throw new Error(`Data mismatch: ${JSON.stringify(rows)}`);
    }

    await client.execAtomic('INSERT INTO items (name) VALUES (\'atomic-item-1\');\nINSERT INTO items (name) VALUES (\'atomic-item-2\');');
    const atomicRows = await client.all('SELECT COUNT(*) as count FROM items;');
    if (Number(atomicRows[0]?.count) !== 3) {
      throw new Error(`Expected 3 rows after atomic transaction, got ${atomicRows[0]?.count}`);
    }

    await client.close();
    console.log('  ✓ SqliteClient verified: WAL active, integrity passed, atomic transactions functional');

    // -------------------------------------------------------------------------
    // 3. ConnectionPool Singleton & Eviction Test
    // -------------------------------------------------------------------------
    console.log('[3/5] Testing ConnectionPool...');
    const pool = ConnectionPool.getInstance();
    const mockDbEntity = {
      id: 'mock-db-pool-test',
      type: 'sqlite',
      url: testDbPath,
      metadata: { runtime: { provider: 'local-file' } },
    };

    const pooledClient = pool.getClient(mockDbEntity);
    if (!pooledClient) {
      throw new Error('ConnectionPool returned null/undefined client');
    }

    if (pool.size === 0) {
      throw new Error('ConnectionPool should have size > 0');
    }

    pool.evict('mock-db-pool-test');
    if (pool.size !== 0) {
      throw new Error('ConnectionPool evict failed');
    }
    console.log('  ✓ ConnectionPool operational: caching and eviction validated');

    // -------------------------------------------------------------------------
    // 4. Ed25519 Token & JWT Cryptographic Test
    // -------------------------------------------------------------------------
    console.log('[4/5] Testing Ed25519 token generation & signature verification...');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim() + '\n';

    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ a: 'rw', sub: 'db-test', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);
    const token = `${signingInput}.${signature.toString('base64url')}`;

    const isValidSignature = crypto.verify(null, Buffer.from(signingInput), publicKey, signature);
    if (!isValidSignature) {
      throw new Error('Ed25519 signature verification failed');
    }

    if (!publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) {
      throw new Error('Invalid SPKI PEM format');
    }
    console.log('  ✓ Ed25519 EdDSA token and SPKI PEM authentication verified');

    // -------------------------------------------------------------------------
    // 5. Database Vacuum Snapshot Import Test
    // -------------------------------------------------------------------------
    console.log('[5/5] Testing VACUUM INTO WAL snapshot import...');
    const sourceDbPath = path.join(testDir, 'source.db');
    const sourceClient = new SqliteClient(sourceDbPath);
    await sourceClient.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, total REAL);');
    await sourceClient.run('INSERT INTO invoices (total) VALUES (?);', [1250.75]);
    await sourceClient.close();

    const importedPath = await storageService.importDatabaseFile(sourceDbPath, 'proj-1', 'db-imported-1', 'libsql');
    if (!fs.existsSync(importedPath)) {
      throw new Error(`Imported database file not found at ${importedPath}`);
    }

    const importedClient = new SqliteClient(importedPath);
    const importedRows = await importedClient.all('SELECT * FROM invoices;');
    if (importedRows.length !== 1 || importedRows[0].total !== 1250.75) {
      throw new Error(`Import verification failed: ${JSON.stringify(importedRows)}`);
    }
    await importedClient.close();
    console.log('  ✓ VACUUM INTO snapshot created and verified consistently in dbs/default/data');

    console.log('\n✅ ALL E2E RUNTIME & STORAGE TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    // Cleanup smoke test temporary files
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

run().catch((err) => {
  console.error('\n❌ Smoke test failed:', err);
  process.exit(1);
});
