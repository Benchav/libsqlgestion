import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';
import type { LibsqlClient } from '../../infrastructure/libsql/LibsqlClient';

type SchemaEntry = {
  table: string;
  kind: 'table' | 'view';
  rowCount: number;
  columns: unknown[];
  foreignKeys: unknown[];
};

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function loadSchemaEntries(client: LibsqlClient | { readAll: (sql: string) => Promise<unknown[]> }, kind: 'table' | 'view') {
  let rows: Array<{ name: string }>;
  if ('execute' in client) {
    const objects = await (client as LibsqlClient).execute(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
    rows = objects.rows as unknown as Array<{ name: string }>;
  } else {
    rows = await (client as { readAll: (sql: string) => Promise<unknown[]> }).readAll(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`) as unknown as Array<{ name: string }>;
  }

  const entries: SchemaEntry[] = [];

  for (const row of rows) {
    const tableName = row.name;
    let columnsResult: unknown[];
    let foreignKeysResult: unknown[];
    let countResult: number;

    if ('execute' in client) {
      const libClient = client as LibsqlClient;
      columnsResult = (await libClient.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`)).rows;
      foreignKeysResult = (await libClient.execute(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)).rows;
      countResult = Number(((await libClient.execute(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`)).rows as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0);
    } else {
      const readClient = client as { readAll: (sql: string) => Promise<unknown[]> };
      columnsResult = await readClient.readAll(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
      foreignKeysResult = await readClient.readAll(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
      countResult = Number(((await readClient.readAll(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`)) as Array<{ cnt: number }>)[0]?.cnt ?? 0);
    }

    entries.push({
      table: tableName,
      kind,
      rowCount: countResult,
      columns: columnsResult,
      foreignKeys: foreignKeysResult,
    });
  }

  return entries;
}

export class SchemaService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async getSchema(databaseId: string) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    const pool = ConnectionPool.getInstance();

    if (database.type !== 'sqlite') {
      if (!database.url || !database.encryptedToken) {
        return { tables: [], note: 'missing url or token' };
      }

      const client = pool.getClient(database) as LibsqlClient;
      try {
        const tables = await loadSchemaEntries(client, 'table');
        const views = await loadSchemaEntries(client, 'view');
        return { tables, views };
      } catch (error: any) {
        pool.evictOnError(database.id, error);
        throw error;
      }
    }

    const client = pool.getSqliteClient(database);
    try {
      const sqliteReader = {
        readAll: async (sql: string) => (await client.all(sql)) as unknown[],
      };
      const tables = await loadSchemaEntries(sqliteReader, 'table');
      const views = await loadSchemaEntries(sqliteReader, 'view');
      return { tables, views };
    } catch (error: any) {
      pool.evictOnError(database.id, error);
      throw error;
    }
  }
}
