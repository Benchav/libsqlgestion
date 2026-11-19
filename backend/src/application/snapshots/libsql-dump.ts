import fs from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';

export type LibsqlDumpTarget = {
  url: string;
  headers: Record<string, string>;
  namespace?: string;
};

type DatabaseLike = {
  url?: string | null;
  metadata?: Record<string, unknown> | null;
};

const DEFAULT_DUMP_MAX_BYTES = 10 * 1024 * 1024 * 1024;

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Builds the authenticated /dump endpoint for a managed libSQL primary.
 *
 * Dedicated runtimes expose /dump on their own HTTP listener. Shared sqld
 * namespaces use the same endpoint and select the namespace with `x-namespace`.
 */
export function buildLibsqlDumpTarget(database: DatabaseLike): LibsqlDumpTarget {
  const runtime = database.metadata?.runtime as Record<string, unknown> | undefined;
  const provider = typeof runtime?.provider === 'string' ? runtime.provider : '';
  const internalUrl = typeof runtime?.internalUrl === 'string' ? runtime.internalUrl.trim() : '';
  const backendUrl = typeof runtime?.backendUrl === 'string' ? runtime.backendUrl.trim() : '';
  const baseUrl = internalUrl || backendUrl;

  if (provider !== 'docker-libsql' && provider !== 'sqld-namespace') {
    throw new Error(
      'Snapshots are only available for managed libSQL primaries. ' +
      'Remote Turso Cloud databases must be backed up before migration.',
    );
  }

  if (!baseUrl) {
    throw new Error('The libSQL runtime does not expose an internal URL for backups.');
  }

  const url = new URL(baseUrl);
  url.pathname = '/dump';
  url.search = '?preserve_row_ids=true';

  if (provider === 'sqld-namespace') {
    const namespace = typeof runtime?.namespace === 'string' ? runtime.namespace.trim() : '';
    if (!namespace) {
      throw new Error('The shared sqld namespace is missing its namespace name.');
    }
    return {
      url: url.toString(),
      headers: { 'x-namespace': namespace },
      namespace,
    };
  }

  return { url: url.toString(), headers: {} };
}

/**
 * Streams the sqld logical dump to disk. The dump is the engine-supported
 * consistency mechanism: it is produced by a read transaction on the primary
 * and does not depend on copying live database pages.
 */
export async function fetchLibsqlDump(
  database: DatabaseLike,
  token: string,
  destinationPath: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ bytes: number; url: string }> {
  if (!token) {
    throw new Error('The database token is required to create a libSQL snapshot.');
  }

  const target = buildLibsqlDumpTarget(database);
  const timeoutMs = positiveInt(
    options.timeoutMs === undefined ? process.env.SNAPSHOT_LIBSQL_DUMP_TIMEOUT_MS : String(options.timeoutMs),
    15 * 60 * 1000,
  );
  const maxBytes = positiveInt(
    options.maxBytes === undefined ? process.env.SNAPSHOT_LIBSQL_MAX_BYTES : String(options.maxBytes),
    DEFAULT_DUMP_MAX_BYTES,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let bytes = 0;
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      headers: {
        Accept: 'application/sql',
        Authorization: `Bearer ${token}`,
        ...target.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const summary = detail.replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new Error(
        `libSQL dump request failed with HTTP ${response.status}${summary ? `: ${summary}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('libSQL dump returned an empty response body.');
    }

    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          callback(new Error(`libSQL dump exceeded the configured limit of ${maxBytes} bytes.`));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as any),
      counter,
      fs.createWriteStream(destinationPath, { flags: 'w' }),
    );

    return { bytes, url: target.url };
  } catch (error: any) {
    await fs.promises.rm(destinationPath, { force: true }).catch(() => undefined);
    if (error?.name === 'AbortError') {
      throw new Error(`libSQL dump timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readSlice(filePath: string, position: number, length: number) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Performs cheap structural validation before a dump is committed as a ready
 * snapshot. Full integrity is verified after replaying it into SQLite.
 */
export async function validateLibsqlDump(filePath: string): Promise<{ sizeBytes: number }> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size === 0) {
    throw new Error('libSQL dump is empty.');
  }

  const head = await readSlice(filePath, 0, 8192);
  const tail = await readSlice(filePath, Math.max(0, stat.size - 8192), 8192);
  const normalizedHead = head.replace(/^\uFEFF/, '').trimStart();

  if (/^<!doctype|^<html/i.test(normalizedHead)) {
    throw new Error('The libSQL endpoint returned HTML instead of a SQL dump.');
  }
  if (!/BEGIN\s+TRANSACTION/i.test(head)) {
    throw new Error('The libSQL dump does not contain a BEGIN TRANSACTION marker.');
  }
  if (!/COMMIT\s*;/i.test(tail)) {
    throw new Error('The libSQL dump is truncated: missing final COMMIT.');
  }

  return { sizeBytes: stat.size };
}

/**
 * Quote-aware streaming statement reader. sqld emits one statement per line
 * for rows, but schema SQL may span lines, so a line-based split is unsafe.
 */
export async function* streamSqlStatements(filePath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  let buffer = '';
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' = 'normal';
  let word = '';
  let inTrigger = false;
  let triggerBodyStarted = false;
  let triggerEndSeen = false;
  let caseDepth = 0;
  let blockDepth = 0;
  const isWordChar = /[A-Za-z0-9_$]/;

  const resetStatement = () => {
    buffer = '';
    word = '';
    inTrigger = false;
    triggerBodyStarted = false;
    triggerEndSeen = false;
    caseDepth = 0;
    blockDepth = 0;
  };

  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];
      const next = chunk[index + 1];

      if (state === 'line-comment') {
        buffer += char;
        if (char === '\n') state = 'normal';
        continue;
      }

      if (state === 'block-comment') {
        buffer += char;
        if (char === '*' && next === '/') {
          buffer += next;
          index += 1;
          state = 'normal';
        }
        continue;
      }

      if (state === 'single') {
        buffer += char;
        if (char === "'" && next === "'") {
          buffer += next;
          index += 1;
          continue;
        }
        if (char === "'") state = 'normal';
        continue;
      }

      if (state === 'double') {
        buffer += char;
        if (char === '"' && next === '"') {
          buffer += next;
          index += 1;
          continue;
        }
        if (char === '"') state = 'normal';
        continue;
      }

      if (state === 'backtick') {
        buffer += char;
        if (char === '`') state = 'normal';
        continue;
      }

      if (isWordChar.test(char)) {
        word += char;
        buffer += char;
        continue;
      }

      if (word) {
        const token = word.toUpperCase();
        word = '';

        if (
          token === 'TRIGGER'
          && /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(buffer)
        ) {
          inTrigger = true;
        }

        if (inTrigger) {
          if (token === 'BEGIN') {
            if (!triggerBodyStarted) {
              triggerBodyStarted = true;
              blockDepth = 1;
            } else {
              blockDepth += 1;
            }
          } else if (token === 'CASE') {
            caseDepth += 1;
          } else if (token === 'END') {
            if (caseDepth > 0) {
              caseDepth -= 1;
            } else if (blockDepth > 0) {
              blockDepth -= 1;
              if (blockDepth === 0) {
                triggerEndSeen = true;
              }
            }
          }
        }
      }

      if (char === '-' && next === '-') {
        buffer += char + next;
        index += 1;
        state = 'line-comment';
        continue;
      }

      if (char === '/' && next === '*') {
        buffer += char + next;
        index += 1;
        state = 'block-comment';
        continue;
      }

      if (char === "'") {
        buffer += char;
        state = 'single';
        continue;
      }

      if (char === '"') {
        buffer += char;
        state = 'double';
        continue;
      }

      if (char === '`') {
        buffer += char;
        state = 'backtick';
        continue;
      }

      if (char === ';') {
        // A CREATE TRIGGER body contains semicolons; only the semicolon after
        // the final END terminates the statement.
        if (inTrigger && !triggerEndSeen) {
          buffer += char;
          continue;
        }

        const statement = buffer.trim();
        if (statement) yield statement;
        resetStatement();
        continue;
      }

      buffer += char;
    }
  }

  if (word) {
    // The last token does not affect statement boundaries once the file ends.
    word = '';
  }

  const rest = buffer.trim();
  if (rest) yield rest;
}

/**
 * Rebuilds a SQLite database from a sqld dump. The importer then provisions a
 * fresh libSQL primary from the reconstructed file, so restores never write
 * into a live runtime.
 */
export async function replaySqlDumpToSqlite(
  dumpPath: string,
  targetPath: string,
  options: { chunkBytes?: number } = {},
): Promise<void> {
  const chunkBytes = positiveInt(String(options.chunkBytes || 2 * 1024 * 1024), 2 * 1024 * 1024);
  await fs.promises.rm(targetPath, { force: true }).catch(() => undefined);
  await fs.promises.rm(`${targetPath}-wal`, { force: true }).catch(() => undefined);
  await fs.promises.rm(`${targetPath}-shm`, { force: true }).catch(() => undefined);

  const client = new SqliteClient(targetPath);
  let inTransaction = false;
  try {
    await client.exec('PRAGMA foreign_keys = OFF;');
    await client.exec('BEGIN IMMEDIATE;');
    inTransaction = true;

    let batch = '';
    const flush = async () => {
      if (!batch.trim()) return;
      await client.exec(batch);
      batch = '';
    };

    for await (const statement of streamSqlStatements(dumpPath)) {
      const normalized = statement.trim();
      if (!normalized) continue;
      if (/^(BEGIN|COMMIT|END)(\s+TRANSACTION)?\b/i.test(normalized)) continue;
      if (/^PRAGMA\s+foreign_keys\s*=/i.test(normalized)) continue;

      batch += `${normalized};\n`;
      if (batch.length >= chunkBytes) {
        await flush();
      }
    }

    await flush();
    await client.exec('COMMIT;');
    inTransaction = false;
    // Make the restored database self-contained in the main file before the
    // importer moves it; WAL sidecars are not part of the import operation.
    await client.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    await client.exec('PRAGMA foreign_keys = ON;');

    const integrity = await client.checkIntegrity();
    if (!integrity.ok) {
      throw new Error(`restored database integrity check failed: ${integrity.details}`);
    }
  } catch (error) {
    if (inTransaction) {
      await client.exec('ROLLBACK;').catch(() => undefined);
    }
    await fs.promises.rm(targetPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${targetPath}-wal`, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${targetPath}-shm`, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function isSqlDumpFile(fileName: string) {
  return /\.sql$/i.test(fileName);
}

export async function fileSha256(filePath: string) {
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
