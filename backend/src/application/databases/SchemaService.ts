import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { decrypt } from '../../infrastructure/crypto';

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

async function loadSchemaEntries(client: { execute: (sql: string) => Promise<{ rows: unknown[] }>; all?: (sql: string) => Promise<unknown[]> }, kind: 'table' | 'view') {
  const objects = await client.execute(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
  const entries: SchemaEntry[] = [];
  const rows = objects.rows as Array<{ name: string }>;

  for (const row of rows) {
    const tableName = row.name;
    const columnsResult = await client.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    const foreignKeysResult = await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
    const countResult = await client.execute(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`);
    const rowCount = Number((countResult.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0);

    entries.push({
      table: tableName,
      kind,
      rowCount,
      columns: columnsResult.rows,
      foreignKeys: foreignKeysResult.rows,
    });
  }

  return entries;
}

export class SchemaService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async getSchema(databaseId: string) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    if (database.type !== 'sqlite') {
      if (!database.url || !database.encryptedToken) {
        return { tables: [], note: 'missing url or token' };
      }

      const client = createLibsqlClient(database.url, decrypt(database.encryptedToken));
      try {
        const tables = await loadSchemaEntries(client, 'table');
        const views = await loadSchemaEntries(client, 'view');
        return { tables, views };
      } finally {
        client.close();
      }
    }

    const client = new SqliteClient(database.url || '');
    try {
      const tables = await loadSchemaEntries(
        {
          execute: async (sql: string) => ({ rows: (await client.all(sql)) as unknown[] }),
        },
        'table',
      );
      const views = await loadSchemaEntries(
        {
          execute: async (sql: string) => ({ rows: (await client.all(sql)) as unknown[] }),
        },
        'view',
      );

      return { tables, views };
    } finally {
      client.close();
    }
  }
}
