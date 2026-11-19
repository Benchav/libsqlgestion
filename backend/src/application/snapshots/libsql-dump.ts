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
  // sqld writes COMMIT; as the final statement. Anchoring to the end rejects
  // truncated dumps whose earlier rows happen to contain the word COMMIT.
  if (!/COMMIT\s*;\s*$/i.test(tail)) {
    throw new Error('The libSQL dump is truncated: missing final COMMIT.');
  }

  return { sizeBytes: stat.size };
}

function isCreateTrigger(keywords: string[]) {
  if (keywords[0] !== 'CREATE') return false;
  if (keywords.length === 2) return keywords[1] === 'TRIGGER';
  if (keywords.length >= 3) {
    if (keywords[1] === 'TEMP' || keywords[1] === 'TEMPORARY') {
      return keywords[2] === 'TRIGGER';
    }
    return false;
  }
  return false;
}

/**
 * Quote-aware streaming statement reader. sqld emits one statement per line
 * for rows, but schema SQL may span lines and trigger bodies contain
 * semicolons, so a line-based split is unsafe.
 *
 * One character is deliberately carried between chunks so tokens split across
 * a 1 MiB boundary (block-comment delimiters, doubled quotes) are still
 * recognized.
 */
export async function* streamSqlStatements(filePath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  let buffer = '';
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'line-comment' | 'block-comment' = 'normal';
  let word = '';
  let keywords: string[] = [];
  let inTrigger = false;
  let triggerBodyStarted = false;
  let triggerEndSeen = false;
  let caseDepth = 0;
  let blockDepth = 0;
  let carry = '';
  const completed: string[] = [];
  const isWordChar = /[A-Za-z0-9_$]/;

  const resetStatement = () => {
    buffer = '';
    word = '';
    keywords = [];
    inTrigger = false;
    triggerBodyStarted = false;
    triggerEndSeen = false;
    caseDepth = 0;
    blockDepth = 0;
  };

  const flushStatement = () => {
    const statement = buffer.trim();
    if (statement) completed.push(statement);
    resetStatement();
  };

  const noteKeyword = (token: string) => {
    const upper = token.toUpperCase();
    if (keywords.length < 3) {
      keywords.push(upper);
    }

    if (!inTrigger && isCreateTrigger(keywords)) {
      inTrigger = true;
    }

    if (!inTrigger) return;

    if (upper === 'BEGIN') {
      if (!triggerBodyStarted) {
        triggerBodyStarted = true;
        blockDepth = 1;
      } else {
        blockDepth += 1;
      }
    } else if (upper === 'CASE') {
      caseDepth += 1;
    } else if (upper === 'END') {
      if (caseDepth > 0) {
        caseDepth -= 1;
      } else if (blockDepth > 0) {
        blockDepth -= 1;
        if (blockDepth === 0) {
          triggerEndSeen = true;
        }
      }
    }
  };

  /**
   * Processes one character. Returns true when `next` was consumed as part of
   * a two-character token or an escaped quote.
   */
  const handle = (char: string, next: string | undefined): boolean => {
    if (state === 'line-comment') {
      buffer += char;
      if (char === '\n') state = 'normal';
      return false;
    }

    if (state === 'block-comment') {
      buffer += char;
      if (char === '*' && next === '/') {
        buffer += next;
        state = 'normal';
        return true;
      }
      return false;
    }

    if (state === 'single') {
      buffer += char;
      if (char === "'" && next === "'") {
        buffer += next;
        return true;
      }
      if (char === "'") state = 'normal';
      return false;
    }

    if (state === 'double') {
      buffer += char;
      if (char === '"' && next === '"') {
        buffer += next;
        return true;
      }
      if (char === '"') state = 'normal';
      return false;
    }

    if (state === 'backtick') {
      buffer += char;
      if (char === '`' && next === '`') {
        buffer += next;
        return true;
      }
      if (char === '`') state = 'normal';
      return false;
    }

    if (state === 'bracket') {
      buffer += char;
      if (char === ']') state = 'normal';
      return false;
    }

    if (isWordChar.test(char)) {
      word += char;
      buffer += char;
      return false;
    }

    if (word) {
      const token = word;
      word = '';
      noteKeyword(token);
    }

    if (char === '-' && next === '-') {
      buffer += char + next;
      state = 'line-comment';
      return true;
    }

    if (char === '/' && next === '*') {
      buffer += char + next;
      state = 'block-comment';
      return true;
    }

    if (char === "'") {
      buffer += char;
      state = 'single';
      return false;
    }

    if (char === '"') {
      buffer += char;
      state = 'double';
      return false;
    }

    if (char === '`') {
      buffer += char;
      state = 'backtick';
      return false;
    }

    // SQLite bracket quoting cannot contain an escaped closing bracket.
    if (char === '[') {
      buffer += char;
      state = 'bracket';
      return false;
    }

    if (char === ';') {
      // A CREATE TRIGGER body contains semicolons; only the semicolon after
      // the final END terminates the statement.
      if (inTrigger && !triggerEndSeen) {
        buffer += char;
        return false;
      }

      flushStatement();
      return false;
    }

    buffer += char;
    return false;
  };

  const processBody = (body: string, trailing: string | undefined) => {
    let trailingConsumed = false;
    for (let index = 0; index < body.length; index += 1) {
      const nextInBody = index + 1 < body.length ? body[index + 1] : undefined;
      const next = nextInBody === undefined ? trailing : nextInBody;
      const consumed = handle(body[index], next);

      if (consumed) {
        if (nextInBody !== undefined) {
          index += 1;
        } else {
          trailingConsumed = true;
        }
      }
    }
    return trailingConsumed;
  };

  for await (const chunk of stream) {
    const text = carry + chunk;
    carry = text.slice(-1);
    const body = text.slice(0, -1);
    if (processBody(body, carry)) {
      carry = '';
    }

    for (const statement of completed) {
      yield statement;
    }
    completed.length = 0;
  }

  if (carry) {
    handle(carry, undefined);
  }
  if (word) {
    noteKeyword(word);
    word = '';
  }

  for (const statement of completed) {
    yield statement;
  }
  completed.length = 0;

  const rest = buffer.trim();
  if (rest) yield rest;
}

/**
 * Rebuilds a SQLite database from a sqld dump. The importer then provisions a
 * fresh libSQL primary from the reconstructed file, so restores never write
 * into a live runtime.
 *
 * The optional pragmas make the materialized file a closer copy of the source
 * database. A logical dump cannot carry file-level settings, so we capture the
 * relevant values from the live primary and reapply them while the target is
 * still empty.
 */
export async function replaySqlDumpToSqlite(
  dumpPath: string,
  targetPath: string,
  options: {
    chunkBytes?: number;
    pageSize?: number;
    encoding?: string;
    autoVacuum?: number;
    userVersion?: number;
    applicationId?: number;
  } = {},
): Promise<void> {
  const chunkBytes = positiveInt(String(options.chunkBytes || 2 * 1024 * 1024), 2 * 1024 * 1024);
  const pageSize = normalizePageSize(options.pageSize);
  const encoding = normalizeEncoding(options.encoding);
  const autoVacuum = normalizeAutoVacuum(options.autoVacuum);
  const userVersion = normalizeInt32(options.userVersion);
  const applicationId = normalizeInt32(options.applicationId);
  await removeDatabaseFiles(targetPath);

  const client = new SqliteClient(targetPath);
  let inTransaction = false;
  try {
    await client.exec('PRAGMA foreign_keys = OFF;');
    if (pageSize !== undefined) {
      await client.exec(`PRAGMA page_size = ${pageSize};`);
    }
    if (encoding !== undefined) {
      await client.exec(`PRAGMA encoding = '${encoding}';`);
    }
    if (autoVacuum !== undefined) {
      await client.exec(`PRAGMA auto_vacuum = ${autoVacuum};`);
      // SqliteClient enables WAL on open, which initializes the header with
      // auto_vacuum=0 before this pragma runs. SQLite only applies the change
      // after a VACUUM on a non-empty (already initialized) database.
      await client.exec('VACUUM;');
    }
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
    if (userVersion !== undefined) {
      await client.exec(`PRAGMA user_version = ${userVersion};`);
    }
    if (applicationId !== undefined) {
      await client.exec(`PRAGMA application_id = ${applicationId};`);
    }
    // Make the restored database self-contained in the main file before the
    // importer moves it; WAL sidecars are not part of the import operation.
    await client.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    await client.exec('PRAGMA foreign_keys = ON;');
  } catch (error) {
    if (inTransaction) {
      await client.exec('ROLLBACK;').catch(() => undefined);
    }
    await removeDatabaseFiles(targetPath);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }

  // Validate from a fresh connection. The import deliberately writes virtual
  // table definitions through writable_schema, so checking integrity on the
  // same connection can accept an in-memory schema that does not survive
  // reopening. A restore is only valid if the file parses from disk.
  const verifier = new SqliteClient(targetPath);
  try {
    const integrity = await verifier.checkIntegrity();
    if (!integrity.ok) {
      throw new Error(`restored database integrity check failed: ${integrity.details}`);
    }
  } catch (error) {
    await removeDatabaseFiles(targetPath);
    throw error;
  } finally {
    await verifier.close().catch(() => undefined);
  }
}

function normalizePageSize(value: number | undefined) {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(Number(value));
  if (parsed < 512 || parsed > 65536 || (parsed & (parsed - 1)) !== 0) return undefined;
  return parsed;
}

function normalizeEncoding(value: string | undefined) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'UTF-8' || normalized === 'UTF-16LE' || normalized === 'UTF-16BE') {
    return normalized;
  }
  return undefined;
}

function normalizeAutoVacuum(value: number | undefined) {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(Number(value));
  return parsed === 0 || parsed === 1 || parsed === 2 ? parsed : undefined;
}

function normalizeInt32(value: number | undefined) {
  if (!Number.isFinite(value)) return undefined;
  const parsed = Math.floor(Number(value));
  if (parsed < 0 || parsed > 0x7fffffff) return undefined;
  return parsed;
}

async function removeDatabaseFiles(filePath: string) {
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    await fs.promises.rm(candidate, { force: true }).catch(() => undefined);
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
