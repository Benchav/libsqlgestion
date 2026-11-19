import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const positional = args.filter((arg) => !arg.startsWith('--'));
const url = positional[0];
const token = positional[1];
const embedded = flags.has('--embedded') || flags.has('--deep');
const deep = flags.has('--deep');
const jsonOutput = flags.has('--json');

if (!url || !token || flags.has('--help')) {
  const printUsage = flags.has('--help') ? console.log : console.error;
  printUsage(
    'Usage: node scripts/test-external-libsql.mjs <libsql-or-https-url> <token> ' +
    '[--embedded] [--deep] [--json]',
  );
  printUsage('');
  printUsage('  --embedded  Verify a fresh embedded replica can sync and query.');
  printUsage('  --deep      Verify remote writes propagate to the replica and cleanup.');
  printUsage('  --json      Print a machine-readable summary.');
  process.exit(flags.has('--help') ? 0 : 1);
}

const summary = {
  url,
  remote: null,
  embedded: null,
  deep: null,
  ok: false,
  startedAt: new Date().toISOString(),
};

function now() {
  return performance.now();
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

async function time(label, fn) {
  const startedAt = now();
  const value = await fn();
  return { value, durationMs: roundMs(now() - startedAt) };
}

async function testRemote() {
  const client = createClient({ url, authToken: token });
  try {
    const ping = await time('SELECT 1', () => client.execute('SELECT 1 AS ok'));
    const version = await client.execute('SELECT sqlite_version() AS version');
    const tables = await client.execute(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    return {
      ok: true,
      pingMs: ping.durationMs,
      sqliteVersion: String(version.rows[0]?.version || 'unknown'),
      userTableCount: Number(tables.rows[0]?.count || 0),
    };
  } finally {
    client.close();
  }
}

async function testEmbedded() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-embedded-'));
  const filePath = path.join(tempDir, 'replica.db');
  const client = createClient({
    url: `file:${filePath}`,
    syncUrl: url,
    authToken: token,
    syncInterval: 0,
  });

  try {
    if (typeof client.sync !== 'function') {
      throw new Error('This @libsql/client version does not expose sync().');
    }

    const firstSync = await time('initial sync', () => client.sync());
    const ping = await time('replica SELECT 1', () => client.execute('SELECT 1 AS ok'));
    const tables = await client.execute(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );

    return {
      ok: true,
      syncMs: firstSync.durationMs,
      pingMs: ping.durationMs,
      userTableCount: Number(tables.rows[0]?.count || 0),
      replicaFile: filePath,
    };
  } finally {
    client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDeep() {
  // Unique per run: a fixed name could delete a real table or collide with a
  // concurrent diagnostic run. Cleanup only ever touches this exact table.
  const table = `__libsqlite_sync_check_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const quotedTable = `"${table.replace(/"/g, '""')}"`;
  const marker = `check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libsqlite-embedded-deep-'));
  const filePath = path.join(tempDir, 'replica.db');
  const remote = createClient({ url, authToken: token });
  const replica = createClient({
    url: `file:${filePath}`,
    syncUrl: url,
    authToken: token,
    syncInterval: 0,
  });

  try {
    await remote.execute(`CREATE TABLE ${quotedTable} (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);
    await remote.execute({
      sql: `INSERT INTO ${quotedTable} (id, created_at) VALUES (?, ?)`,
      args: [marker, new Date().toISOString()],
    });

    const createSync = await time('sync after remote insert', () => replica.sync());
    const visible = await replica.execute({
      sql: `SELECT id FROM ${quotedTable} WHERE id = ?`,
      args: [marker],
    });
    if (visible.rows.length !== 1) {
      throw new Error('The remote write did not propagate to the embedded replica.');
    }

    await remote.execute({ sql: `DELETE FROM ${quotedTable} WHERE id = ?`, args: [marker] });
    const deleteSync = await time('sync after remote delete', () => replica.sync());
    const gone = await replica.execute({
      sql: `SELECT id FROM ${quotedTable} WHERE id = ?`,
      args: [marker],
    });
    if (gone.rows.length !== 0) {
      throw new Error('The remote delete did not propagate to the embedded replica.');
    }

    return {
      ok: true,
      table,
      insertPropagationMs: createSync.durationMs,
      deletePropagationMs: deleteSync.durationMs,
    };
  } finally {
    await remote.execute(`DROP TABLE IF EXISTS ${quotedTable}`).catch(() => undefined);
    remote.close();
    replica.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  summary.remote = await testRemote();

  if (embedded) {
    summary.embedded = await testEmbedded();
  }
  if (deep) {
    summary.deep = await testDeep();
  }

  summary.ok = Boolean(summary.remote?.ok && (!embedded || summary.embedded?.ok) && (!deep || summary.deep?.ok));
  summary.finishedAt = new Date().toISOString();

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Remote connection OK (${summary.remote.pingMs} ms, SQLite ${summary.remote.sqliteVersion}, ${summary.remote.userTableCount} user tables)`);
    if (summary.embedded) {
      console.log(`Embedded replica OK (initial sync ${summary.embedded.syncMs} ms, ${summary.embedded.userTableCount} user tables)`);
    }
    if (summary.deep) {
      console.log(`Replica propagation OK (insert ${summary.deep.insertPropagationMs} ms, delete ${summary.deep.deletePropagationMs} ms)`);
    }
  }
}

main().catch((error) => {
  summary.ok = false;
  summary.error = error?.message || String(error);
  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error('Connection test failed:', summary.error);
  }
  process.exitCode = 1;
});
