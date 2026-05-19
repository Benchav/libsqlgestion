import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { decrypt } from '../../infrastructure/crypto';
import { isMultiStatementSql, splitSqlStatements } from './sqlScript';

const READ_ONLY_REGEX = /^\s*(select|pragma|with|explain)\b/i;

export class QueryService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async execute(databaseId: string, sql: string, params: unknown[] = []) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    const statements = splitSqlStatements(sql);
    const isScript = statements.length > 1;

    if (isScript && params.length > 0) {
      throw new DatabaseError('SQLITE_SCRIPT_PARAMS', 'Parameter binding is not supported for multi-statement scripts.', false);
    }

    if (database.type !== 'sqlite') {
      if (!database.url || !database.encryptedToken) {
        return { ok: false, error: 'missing url or token' };
      }

      const client = createLibsqlClient(database.url, decrypt(database.encryptedToken));
      try {
        if (isScript) {
          let rows: unknown[] | undefined;
          let rowsAffected = 0;
          let lastInsertRowid: unknown;

          for (const statement of statements) {
            const result = await client.execute(statement);
            rows = result.rows;
            rowsAffected += Number(result.rowsAffected ?? 0);
            lastInsertRowid = result.lastInsertRowid;
          }

          return {
            ok: true,
            statementsExecuted: statements.length,
            rows,
            rowsAffected,
            lastInsertRowid,
          };
        }

        const result = await client.execute(sql, params as any);
        return { ok: true, rows: result.rows, rowsAffected: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
      } catch (error: any) {
        throw new DatabaseError('LIBSQL_ERROR', error.message || 'Remote query failed', true);
      } finally {
        client.close();
      }
    }

    let client: SqliteClient;
    try {
      client = new SqliteClient(database.url || '');
    } catch (error: any) {
      // File validation errors from the constructor
      throw error instanceof DatabaseError ? error : DatabaseError.from(error);
    }

    try {
      if (isScript) {
        await client.exec(sql);
        return { ok: true, statementsExecuted: statements.length };
      }

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

