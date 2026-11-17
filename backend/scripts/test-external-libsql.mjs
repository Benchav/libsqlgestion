import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

function usage() {
  console.error('Usage: node scripts/test-external-libsql.mjs <libsql-or-https-url> <token> [--embedded]');
  process.exit(1);
}

const url = process.argv[2];
const token = process.argv[3];
const embedded = process.argv.includes('--embedded');

if (!url || !token) usage();

async function testRemote() {
  const client = createClient({ url, authToken: token });
  try {
    const result = await client.execute('SELECT 1 AS ok');
    console.log('Remote connection OK:', JSON.stringify(result.rows));
  } finally {
    client.close();
  }
}

async function testEmbedded() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-embedded-'));
  const filePath = path.join(tempDir, 'replica.db');
  const localUrl = `file:${filePath}`;
  const client = createClient({
    url: localUrl,
    syncUrl: url,
    authToken: token,
    syncInterval: 0,
  });

  try {
    if (typeof client.sync === 'function') {
      await client.sync();
    }
    const result = await client.execute('SELECT 1 AS ok');
    console.log('Embedded replica connection OK:', JSON.stringify(result.rows));
    console.log('Local replica file:', filePath);
  } finally {
    client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  if (embedded) {
    await testEmbedded();
  } else {
    await testRemote();
  }
} catch (error) {
  console.error('Connection failed:', error?.message || error);
  process.exit(1);
}
