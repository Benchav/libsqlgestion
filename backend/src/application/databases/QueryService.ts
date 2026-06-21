import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';
import type { LibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { splitSqlStatements } from './sqlScript';

const READ_ONLY_REGEX = /^\s*(select|pragma|with|explain)\b/i;

type StatementExecutionResult = {
  index: number;
  sql: string;
  kind: 'read' | 'write';
  rows?: unknown[];
  rowsAffected?: number;
  lastInsertRowid?: unknown;
};

type QueryExecutionResult = {
  ok: boolean;
  rows?: unknown[];
  result?: { changes: number; lastID?: number };
  rowsAffected?: number;
  lastInsertRowid?: unknown;
  statementsExecuted?: number;
  statementResults?: StatementExecutionResult[];
  error?: string;
};

export class QueryService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async execute(databaseId: string, sql: string, params: unknown[] = []): Promise<QueryExecutionResult> {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    const statements = splitSqlStatements(sql);
    const isScript = statements.length > 1;

    if (isScript && params.length > 0) {
      throw new DatabaseError('SQLITE_SCRIPT_PARAMS', 'Parameter binding is not supported for multi-statement scripts.', false);
    }

    const pool = ConnectionPool.getInstance();

    if (database.type !== 'sqlite') {
      if (!database.url || !database.encryptedToken) {
        return { ok: false, error: 'missing url or token' };
      }

      const client = pool.getClient(database) as LibsqlClient;
      try {
        if (isScript) {
          const batchArgs = statements.map((stmt) => ({ sql: stmt, args: [] }));
          const results = await client.batch(batchArgs, 'write');
          
          const statementResults: StatementExecutionResult[] = results.map((result, index) => {
            const statement = statements[index];
            const isRead = READ_ONLY_REGEX.test(statement);
            return {
              index: index + 1,
              sql: statement,
              kind: isRead ? 'read' : 'write',
              rows: result.rows,
              rowsAffected: Number((result as any).rowsAffected ?? 0),
              lastInsertRowid: (result as any).lastInsertRowid,
            };
          });

          const lastResult = results[results.length - 1];
          const rowsAffected = results.reduce((acc, r) => acc + Number((r as any).rowsAffected ?? 0), 0);
          const lastInsertRowid = (lastResult as any)?.lastInsertRowid;

          return {
            ok: true,
            statementsExecuted: statements.length,
            rows: lastResult?.rows,
            rowsAffected,
            lastInsertRowid,
            statementResults,
          };
        }

        const result = await client.execute(sql, params as any);
        return { ok: true, rows: result.rows, rowsAffected: (result as any).rowsAffected, lastInsertRowid: (result as any).lastInsertRowid };
      } catch (error: any) {
        pool.evictOnError(database.id, error);
        throw new DatabaseError('LIBSQL_ERROR', error.message || 'Remote query failed', true);
      }
    }

    let client: SqliteClient;
    try {
      client = pool.getSqliteClient(database);
    } catch (error: any) {
      throw error instanceof DatabaseError ? error : DatabaseError.from(error);
    }

    try {
      if (isScript) {
        await client.execAtomic(sql);
        const statementResults: StatementExecutionResult[] = statements.map((statement, index) => ({
          index: index + 1,
          sql: statement,
          kind: READ_ONLY_REGEX.test(statement) ? 'read' : 'write',
        }));

        return { ok: true, statementsExecuted: statements.length, statementResults };
      }

      if (READ_ONLY_REGEX.test(sql)) {
        const rows = await client.all(sql, params);
        return { ok: true, rows };
      }

      const result = await client.run(sql, params);
      return { ok: true, result };
    } catch (error: any) {
      pool.evictOnError(database.id, error);
      throw error instanceof DatabaseError ? error : DatabaseError.from(error);
    }
  }
}
