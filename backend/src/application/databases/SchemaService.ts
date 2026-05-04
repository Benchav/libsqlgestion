import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { decrypt } from '../../infrastructure/crypto';

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
        const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        const detailed = [] as Array<Record<string, unknown>>;

        const tableRows = tables.rows as unknown as Array<{ name: string }>;
        for (const row of tableRows) {
          const columns = await client.execute(`PRAGMA table_info(${row.name})`);
          const foreignKeys = await client.execute(`PRAGMA foreign_key_list(${row.name})`);
          detailed.push({ table: row.name, columns: columns.rows, foreignKeys: foreignKeys.rows });
        }

        return { tables: detailed };
      } finally {
        client.close();
      }
    }

    const client = new SqliteClient(database.url || '');
    try {
      const tables = (await client.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) as Array<{ name: string }>;
      const detailed = [] as Array<Record<string, unknown>>;

      for (const table of tables) {
        const columns = (await client.all(`PRAGMA table_info(${table.name})`)) as Array<Record<string, unknown>>;
        const foreignKeys = (await client.all(`PRAGMA foreign_key_list(${table.name})`)) as Array<Record<string, unknown>>;
        detailed.push({ table: table.name, columns, foreignKeys });
      }

      return { tables: detailed };
    } finally {
      client.close();
    }
  }
}
