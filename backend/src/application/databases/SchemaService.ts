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

async function loadSchemaViaLibsql(client: LibsqlClient, kind: 'table' | 'view') {
  const objects = await client.execute(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
  const rows = objects.rows as unknown as Array<{ name: string }>;
  const entries: SchemaEntry[] = [];

  for (const row of rows) {
    const tableName = row.name;
    const columnsResult = (await client.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`)).rows;
    const foreignKeysResult = (await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)).rows;
    const countRow = (await client.execute(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`)).rows as unknown as Array<{ cnt: number }>;
    const rowCount = Number(countRow[0]?.cnt ?? 0);

    entries.push({
      table: tableName,
      kind,
      rowCount,
      columns: columnsResult,
      foreignKeys: foreignKeysResult,
    });
  }

  return entries;
}

async function loadSchemaViaSqlite(client: SqliteClient, kind: 'table' | 'view') {
  const rows = await client.all(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`) as Array<{ name: string }>;
  const entries: SchemaEntry[] = [];

  for (const row of rows) {
    const tableName = row.name;
    const columnsResult = await client.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    const foreignKeysResult = await client.all(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
    const countRows = await client.all(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`) as Array<{ cnt: number }>;
    const rowCount = Number(countRows[0]?.cnt ?? 0);

    entries.push({
      table: tableName,
      kind,
      rowCount,
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
    const client = pool.getClient(database);

    if (client instanceof SqliteClient) {
      try {
        const tables = await loadSchemaViaSqlite(client, 'table');
        const views = await loadSchemaViaSqlite(client, 'view');
        return { tables, views };
      } catch (error: any) {
        pool.evictOnError(database.id, error);
        throw error;
      }
    }

    if (!database.url || !database.encryptedToken) {
      return { tables: [], note: 'missing url or token' };
    }

    const libClient = client as LibsqlClient;
    try {
      const tables = await loadSchemaViaLibsql(libClient, 'table');
      const views = await loadSchemaViaLibsql(libClient, 'view');
      return { tables, views };
    } catch (error: any) {
      pool.evictOnError(database.id, error);
      throw error;
    }
  }
}
