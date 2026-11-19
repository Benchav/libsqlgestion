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
const bench = flags.has('--bench');
const jsonOutput = flags.has('--json');
const tableFlag = args.find((arg) => arg.startsWith('--table='));
const iterationsFlag = args.find((arg) => arg.startsWith('--iterations='));
const benchTable = tableFlag ? tableFlag.slice('--table='.length).trim() : '';
const benchIterations = Math.max(
  5,
  Math.min(500, Number(iterationsFlag ? iterationsFlag.slice('--iterations='.length) : 20) || 20),
);

if (!url || !token || flags.has('--help')) {
  const printUsage = flags.has('--help') ? console.log : console.error;
  printUsage(
    'Usage: node scripts/test-external-libsql.mjs <libsql-or-https-url> <token> ' +
    '[--embedded] [--deep] [--bench] [--table=NAME] [--iterations=N] [--json]',
  );
  printUsage('');
  printUsage('  --embedded       Verify a fresh embedded replica can sync and query.');
  printUsage('  --deep           Verify remote writes propagate to the replica and cleanup.');
  printUsage('  --bench          Measure p50/p95 latency for SELECT 1 and an optional table.');
  printUsage('  --table=NAME     Table used for the page/count benchmark.');
  printUsage('  --iterations=N   Samples per benchmark (default 20, max 500).');
  printUsage('  --json           Print a machine-readable summary.');
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

function sampleStats(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (percentile) => sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  )];
  return {
    samples: samples.length,
    p50Ms: roundMs(at(50)),
    p95Ms: roundMs(at(95)),
    avgMs: roundMs(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    minMs: roundMs(sorted[0]),
    maxMs: roundMs(sorted[sorted.length - 1]),
  };
}

async function benchmarkClient(client, label, table, iterations) {
  const quotedTable = table ? `"${table.replace(/"/g, '""')}"` : '';
  const result = { label, iterations };

  await client.execute('SELECT 1');
  const pings = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = now();
    await client.execute('SELECT 1 AS ok');
    pings.push(now() - startedAt);
  }
  result.select1 = sampleStats(pings);

  if (!table) return result;

  const pages = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = now();
    await client.execute(`SELECT * FROM ${quotedTable} LIMIT 50`);
    pages.push(now() - startedAt);
  }
  result.page50 = sampleStats(pages);

  const counts = [];
  const countIterations = Math.min(5, iterations);
  for (let index = 0; index < countIterations; index += 1) {
    const startedAt = now();
    await client.execute(`SELECT COUNT(*) AS cnt FROM ${quotedTable}`);
    counts.push(now() - startedAt);
  }
  result.count = sampleStats(counts);

  return result;
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
      bench: bench ? await benchmarkClient(client, 'remote', benchTable, benchIterations) : null,
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
      bench: bench ? await benchmarkClient(client, 'embedded-replica', benchTable, benchIterations) : null,
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

function printBench(label, bench) {
  if (!bench) return;
  console.log(`Benchmark ${label} (${bench.iterations} iterations):`);
  for (const [name, stats] of [
    ['SELECT 1', bench.select1],
    ['page LIMIT 50', bench.page50],
    ['COUNT(*)', bench.count],
  ]) {
    if (!stats) continue;
    console.log(
      `  ${name}: p50 ${stats.p50Ms} ms, p95 ${stats.p95Ms} ms, ` +
      `avg ${stats.avgMs} ms (min ${stats.minMs}, max ${stats.maxMs})`,
    );
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
    printBench('remote primary', summary.remote?.bench);
    printBench('embedded replica', summary.embedded?.bench);
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
