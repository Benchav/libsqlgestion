import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';

export class SchemaService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async getSchema(databaseId: string) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    if (database.type !== 'sqlite') {
      return { tables: [], note: 'schema introspection for remote/libsql can be added with a driver-specific adapter' };
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
