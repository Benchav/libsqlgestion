import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { decrypt } from '../../infrastructure/crypto';

const READ_ONLY_REGEX = /^\s*(select|pragma|with)\b/i;

export class QueryService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async execute(databaseId: string, sql: string, params: unknown[] = []) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    if (database.type !== 'sqlite') {
      if (!database.url || !database.encryptedToken) {
        return { ok: false, error: 'missing url or token' };
      }

      const client = createLibsqlClient(database.url, decrypt(database.encryptedToken));
      try {
        const result = await client.execute(sql, params as any);
        return { ok: true, rows: result.rows, rowsAffected: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
      } finally {
        client.close();
      }
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
