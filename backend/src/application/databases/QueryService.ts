import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';

const READ_ONLY_REGEX = /^\s*(select|pragma|with)\b/i;

export class QueryService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async execute(databaseId: string, sql: string, params: unknown[] = []) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    if (database.type !== 'sqlite') {
      return { ok: false, error: 'query execution for remote/libsql is not wired yet' };
    }

    const client = new SqliteClient(database.url || '');
    try {
      if (READ_ONLY_REGEX.test(sql)) {
        const rows = await client.all(sql, params);
        return { ok: true, rows };
      }

      const result = await client.run(sql, params);
      return { ok: true, result };
    } finally {
      client.close();
    }
  }
}
