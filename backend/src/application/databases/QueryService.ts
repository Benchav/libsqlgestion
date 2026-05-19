import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { decrypt } from '../../infrastructure/crypto';
import { isMultiStatementSql, splitSqlStatements } from './sqlScript';

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

    if (database.type !== 'sqlite') {
      if (!database.url || !database.encryptedToken) {
        return { ok: false, error: 'missing url or token' };
      }

      const client = createLibsqlClient(database.url, decrypt(database.encryptedToken));
      try {
        if (isScript) {
          const statementResults: StatementExecutionResult[] = [];
          let rows: unknown[] | undefined;
          let rowsAffected = 0;
          let lastInsertRowid: unknown;

          await client.execute('BEGIN IMMEDIATE');
          try {
            for (const [index, statement] of statements.entries()) {
              if (READ_ONLY_REGEX.test(statement)) {
                const result = await client.execute(statement);
                const step: StatementExecutionResult = {
                  index: index + 1,
                  sql: statement,
                  kind: 'read',
                  rows: result.rows,
                };
                statementResults.push(step);
                rows = result.rows;
                continue;
              }

              const result = await client.execute(statement);
              const affected = Number(result.rowsAffected ?? 0);
              const step: StatementExecutionResult = {
                index: index + 1,
                sql: statement,
                kind: 'write',
                rowsAffected: affected,
                lastInsertRowid: result.lastInsertRowid,
              };
              statementResults.push(step);
              rowsAffected += affected;
              lastInsertRowid = result.lastInsertRowid;
            }

            await client.execute('COMMIT');
          } catch (error) {
            await client.execute('ROLLBACK').catch(() => undefined);
            throw error;
          }

          return {
            ok: true,
            statementsExecuted: statements.length,
            rows,
            rowsAffected,
            lastInsertRowid,
            statementResults,
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
        const statementResults: StatementExecutionResult[] = [];
        let rows: unknown[] | undefined;
        let rowsAffected = 0;
        let lastInsertRowid: unknown;

        await client.exec('BEGIN IMMEDIATE');
        try {
          for (const [index, statement] of statements.entries()) {
            if (READ_ONLY_REGEX.test(statement)) {
              const resultRows = await client.all(statement, []);
              statementResults.push({ index: index + 1, sql: statement, kind: 'read', rows: resultRows });
              rows = resultRows;
              continue;
            }

            const result = await client.run(statement, []);
            statementResults.push({
              index: index + 1,
              sql: statement,
              kind: 'write',
              rowsAffected: result.changes,
              lastInsertRowid: result.lastID,
            });
            rowsAffected += result.changes;
            lastInsertRowid = result.lastID;
          }

          await client.exec('COMMIT');
        } catch (error) {
          await client.exec('ROLLBACK').catch(() => undefined);
          throw error;
        }

        return { ok: true, statementsExecuted: statements.length, rows, rowsAffected, lastInsertRowid, statementResults };
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

