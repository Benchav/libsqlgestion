import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';
import type { LibsqlClient } from '../../infrastructure/libsql/LibsqlClient';

type SchemaEntry = {
  table: string;
  kind: 'table' | 'view';
  // Counts are intentionally lazy: counting every table on first paint was
  // the dominant cost for large ERPs. The Studio loads the active count.
  rowCount: number | null;
  columns: unknown[];
  foreignKeys: unknown[];
};

type SchemaPayload = {
  tables: SchemaEntry[];
  views: SchemaEntry[];
};

type SchemaCacheEntry = {
  version: number;
  loadedAt: number;
  value: SchemaPayload;
};

type SchemaOptions = {
  refresh?: boolean;
  // Keep the API compatible for callers that need exact counts, but the
  // Studio explicitly opts out so opening a large ERP does not run COUNT(*)
  // for every table in the schema.
  includeRowCounts?: boolean;
};

const schemaCache = new Map<string, SchemaCacheEntry>();

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function cacheTtlMs() {
  return positiveInt(process.env.SCHEMA_CACHE_TTL_MS, 60_000);
}

function cacheMaxEntries() {
  return positiveInt(process.env.SCHEMA_CACHE_MAX_ENTRIES, 200);
}

function pruneCache() {
  const max = cacheMaxEntries();
  while (schemaCache.size > max) {
    let oldestKey = '';
    let oldestAt = Infinity;
    for (const [key, entry] of schemaCache.entries()) {
      if (entry.loadedAt < oldestAt) {
        oldestAt = entry.loadedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    schemaCache.delete(oldestKey);
  }
}

function schemaCacheKey(databaseId: string, databaseUrl: string | null | undefined, includeRowCounts: boolean) {
  // The URL changes when a legacy local file is converted to a managed
  // runtime/namespace, so include it to avoid reusing a schema for a different
  // physical database that happens to share the same id.
  return `${databaseId}:${databaseUrl || ''}:${includeRowCounts ? 'counts' : 'fast'}`;
}

export function clearSchemaCache(databaseId?: string) {
  if (databaseId) {
    for (const key of schemaCache.keys()) {
      if (key === databaseId || key.startsWith(`${databaseId}:`)) {
        schemaCache.delete(key);
      }
    }
    return;
  }
  schemaCache.clear();
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function readSchemaVersion(client: SqliteClient | LibsqlClient): Promise<number | null> {
  try {
    if (client instanceof SqliteClient) {
      const row = await client.get('PRAGMA schema_version;') as Record<string, unknown> | undefined;
      const value = Number(row?.schema_version);
      return Number.isFinite(value) ? value : null;
    }

    const result = await client.execute('PRAGMA schema_version;');
    const value = Number((result.rows[0] as Record<string, unknown> | undefined)?.schema_version);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function listObjectsSql() {
  return "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
}

async function loadSchemaViaSqlite(client: SqliteClient, includeRowCounts: boolean): Promise<SchemaPayload> {
  const objects = await client.all(listObjectsSql()) as Array<{ name: string; type: 'table' | 'view' }>;
  const tables: SchemaEntry[] = [];
  const views: SchemaEntry[] = [];

  for (const object of objects) {
    const identifier = quoteIdentifier(object.name);
    const columns = await client.all(`PRAGMA table_info(${identifier})`);
    const foreignKeys = await client.all(`PRAGMA foreign_key_list(${identifier})`);
    let rowCount: number | null = null;
    if (includeRowCounts) {
      const countRows = await client.all(`SELECT COUNT(*) AS cnt FROM ${identifier}`) as Array<{ cnt: number }>;
      rowCount = Number(countRows[0]?.cnt ?? 0);
    }
    const entry: SchemaEntry = {
      table: object.name,
      kind: object.type,
      rowCount,
      columns,
      foreignKeys,
    };
    (object.type === 'view' ? views : tables).push(entry);
  }

  return { tables, views };
}

async function loadSchemaViaLibsql(
  client: LibsqlClient,
  includeRowCounts: boolean,
): Promise<SchemaPayload> {
  const objectResult = await client.execute(listObjectsSql());
  const objects = objectResult.rows as unknown as Array<{ name: string; type: 'table' | 'view' }>;
  const tables: SchemaEntry[] = [];
  const views: SchemaEntry[] = [];
  const chunkSize = 50;
  const queriesPerObject = includeRowCounts ? 3 : 2;

  for (let start = 0; start < objects.length; start += chunkSize) {
    const chunk = objects.slice(start, start + chunkSize);
    const queries: Array<{ sql: string }> = [];
    for (const object of chunk) {
      const identifier = quoteIdentifier(object.name);
      queries.push({ sql: `PRAGMA table_info(${identifier})` });
      queries.push({ sql: `PRAGMA foreign_key_list(${identifier})` });
      if (includeRowCounts) {
        queries.push({ sql: `SELECT COUNT(*) AS cnt FROM ${identifier}` });
      }
    }

    let results: Array<{ rows: unknown[] }> | null = null;
    try {
      // One authenticated HTTP round trip per chunk instead of two per table.
      results = await client.batch(queries, 'read') as Array<{ rows: unknown[] }>;
    } catch {
      results = null;
    }

    for (let index = 0; index < chunk.length; index += 1) {
      const object = chunk[index];
      let columns: unknown[];
      let foreignKeys: unknown[];
      let rowCount: number | null = null;

      if (results) {
        const base = index * queriesPerObject;
        columns = results[base]?.rows || [];
        foreignKeys = results[base + 1]?.rows || [];
        if (includeRowCounts) {
          rowCount = Number((results[base + 2]?.rows?.[0] as any)?.cnt ?? 0);
        }
      } else {
        const identifier = quoteIdentifier(object.name);
        columns = (await client.execute(`PRAGMA table_info(${identifier})`)).rows;
        foreignKeys = (await client.execute(`PRAGMA foreign_key_list(${identifier})`)).rows;
        if (includeRowCounts) {
          const countRows = (await client.execute(`SELECT COUNT(*) AS cnt FROM ${identifier}`)).rows;
          rowCount = Number((countRows[0] as any)?.cnt ?? 0);
        }
      }

      const entry: SchemaEntry = {
        table: object.name,
        kind: object.type,
        rowCount,
        columns,
        foreignKeys,
      };
      (object.type === 'view' ? views : tables).push(entry);
    }
  }

  return { tables, views };
}

export class SchemaService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async getSchema(databaseId: string, options: SchemaOptions = {}) {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!database) {
      const err = new Error('Database not found');
      err.name = 'EntityNotFoundError';
      throw err;
    }

    const includeRowCounts = options.includeRowCounts !== false;
    const pool = ConnectionPool.getInstance();
    const client = pool.getClient(database);
    const version = await readSchemaVersion(client);
    const now = Date.now();
    const cacheKey = schemaCacheKey(database.id, database.url, includeRowCounts);
    const cached = schemaCache.get(cacheKey);

    if (
      !options.refresh
      && cached
      && version !== null
      && cached.version === version
      && now - cached.loadedAt < cacheTtlMs()
    ) {
      return cached.value;
    }

    try {
      const payload = client instanceof SqliteClient
        ? await loadSchemaViaSqlite(client, includeRowCounts)
        : await loadSchemaViaLibsql(client as LibsqlClient, includeRowCounts);

      if (version !== null) {
        schemaCache.set(cacheKey, {
          version,
          loadedAt: now,
          value: payload,
        });
        pruneCache();
      }

      return payload;
    } catch (error: any) {
      if (client instanceof SqliteClient) {
        pool.evictOnError(database.id, error);
      } else if (error instanceof DatabaseError) {
        pool.evictOnError(database.id, error);
      }
      throw error;
    }
  }
}
