import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';
import type { LibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { splitSqlStatements } from './sqlScript';

const READ_ONLY_REGEX = /^\s*(select|pragma|with|explain)\b/i;
const WRAPPABLE_REGEX = /^\s*(select|with)\b/i;

type StatementExecutionResult = {
  index: number;
  sql: string;
  kind: 'read' | 'write';
  rows?: unknown[];
  rowsAffected?: number;
  lastInsertRowid?: unknown;
};

type QueryExecutionOptions = {
  limit?: number;
  offset?: number;
  countTotal?: boolean;
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
  rowsReturned?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
  totalRows?: number;
  truncated?: boolean;
  durationMs?: number;
};

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getQueryTimeoutMs() {
  return positiveInt(process.env.SQL_QUERY_TIMEOUT_MS, 15_000);
}

function getHardMaxRows() {
  return Math.min(50_000, positiveInt(process.env.QUERY_HARD_MAX_ROWS, 1_000));
}

function stripTrailingSemicolon(sql: string) {
  return sql.trim().replace(/;\s*$/, '');
}

function buildPreviewSql(sql: string) {
  const trimmed = stripTrailingSemicolon(sql);
  if (!WRAPPABLE_REGEX.test(trimmed)) return null;
  return `SELECT * FROM (\n${trimmed}\n) AS __libsqlite_preview LIMIT ? OFFSET ?`;
}

function buildCountSql(sql: string) {
  const trimmed = stripTrailingSemicolon(sql);
  if (!WRAPPABLE_REGEX.test(trimmed)) return null;
  return `SELECT COUNT(*) AS cnt FROM (\n${trimmed}\n) AS __libsqlite_count`;
}

async function withQueryTimeout<T>(
  promise: Promise<T>,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  const timeoutMs = getQueryTimeoutMs();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort cancellation.
      }
      reject(new DatabaseError('SQLITE_TIMEOUT', `${label} timed out after ${timeoutMs}ms`, false));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normaliseLimit(value: number | undefined) {
  const hardMax = getHardMaxRows();
  const requested = value === undefined ? hardMax : value;
  return Math.max(1, Math.min(hardMax, Math.floor(requested)));
}

function previewResult(
  rows: unknown[],
  limit: number,
  offset: number,
  totalRows: number | undefined,
  startedAt: number,
): QueryExecutionResult {
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    ok: true,
    rows: visibleRows,
    rowsReturned: visibleRows.length,
    limit,
    offset,
    hasMore,
    totalRows,
    truncated: hasMore || (totalRows !== undefined && totalRows > offset + visibleRows.length),
    durationMs: Date.now() - startedAt,
  };
}

export class QueryService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async execute(
    databaseId: string,
    sql: string,
    params: unknown[] = [],
    options: QueryExecutionOptions = {},
  ): Promise<QueryExecutionResult> {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!database) {
      const err = new Error('Database not found');
      err.name = 'EntityNotFoundError';
      throw err;
    }
    const statements = splitSqlStatements(sql);
    const isScript = statements.length > 1;
    const isRead = READ_ONLY_REGEX.test(sql);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const requestedLimit = options.limit === undefined ? undefined : normaliseLimit(options.limit);
    const limit = requestedLimit ?? getHardMaxRows();
    const previewEnabled = true;

    if (isScript && params.length > 0) {
      throw new DatabaseError('SQLITE_SCRIPT_PARAMS', 'Parameter binding is not supported for multi-statement scripts.', false);
    }

    const pool = ConnectionPool.getInstance();
    const client = pool.getClient(database);

    if (client instanceof SqliteClient) {
      const startedAt = Date.now();
      try {
        if (isScript) {
          await client.execAtomic(sql);
          const statementResults: StatementExecutionResult[] = statements.map((statement, index) => ({
            index: index + 1,
            sql: statement,
            kind: READ_ONLY_REGEX.test(statement) ? 'read' : 'write',
          }));
          return { ok: true, statementsExecuted: statements.length, statementResults, durationMs: Date.now() - startedAt };
        }

        if (isRead) {
          const previewSql = previewEnabled ? buildPreviewSql(sql) : null;
          if (previewSql) {
            const rows = await withQueryTimeout(
              client.all(previewSql, [...params, limit + 1, offset] as any),
              'query',
              () => client.interrupt(),
            );

            let totalRows: number | undefined;
            const countSql = options.countTotal ? buildCountSql(sql) : null;
            if (countSql) {
              try {
                const countRows = await withQueryTimeout(
                  client.all(countSql, params as any),
                  'query count',
                  () => client.interrupt(),
                );
                const rawCount = (countRows[0] as any)?.cnt;
                const parsedCount = Number(rawCount);
                if (Number.isFinite(parsedCount)) totalRows = parsedCount;
              } catch {
                // Data is still useful even if the optional count fails.
              }
            }

            return previewResult(rows, limit, offset, totalRows, startedAt);
          }

          const allRows = await withQueryTimeout(
            client.all(sql, params),
            'query',
            () => client.interrupt(),
          );
          const maximum = getHardMaxRows();
          const visibleRows = allRows.slice(offset, offset + maximum);
          return {
            ok: true,
            rows: visibleRows,
            rowsReturned: visibleRows.length,
            limit: maximum,
            offset,
            hasMore: allRows.length > offset + maximum,
            totalRows: allRows.length,
            truncated: allRows.length > offset + maximum,
            durationMs: Date.now() - startedAt,
          };
        }

        const result = await client.run(sql, params);
        return { ok: true, result, durationMs: Date.now() - startedAt };
      } catch (error: any) {
        pool.evictOnError(database.id, error);
        throw error instanceof DatabaseError ? error : DatabaseError.from(error);
      }
    }

    const libClient = client as LibsqlClient;

    if (!database.url || !database.encryptedToken) {
      return { ok: false, error: 'missing url or token' };
    }

    const startedAt = Date.now();
    try {
      if (isScript) {
        const batchArgs = statements.map((stmt) => ({ sql: stmt, args: [] }));
        const results = await libClient.batch(batchArgs, 'write');

        const statementResults: StatementExecutionResult[] = results.map((result, index) => {
          const statement = statements[index];
          const isReadStatement = READ_ONLY_REGEX.test(statement);
          return {
            index: index + 1,
            sql: statement,
            kind: isReadStatement ? 'read' : 'write',
            rows: result.rows?.slice(0, getHardMaxRows()),
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
          rows: lastResult?.rows?.slice(0, getHardMaxRows()),
          rowsAffected,
          lastInsertRowid,
          statementResults,
          rowsReturned: lastResult?.rows?.length,
          durationMs: Date.now() - startedAt,
        };
      }

      if (isRead && previewEnabled) {
        const previewSql = buildPreviewSql(sql);
        if (previewSql) {
          const result = await withQueryTimeout(
            libClient.execute(previewSql, [...params, limit + 1, offset] as any),
            'query',
          );

          let totalRows: number | undefined;
          const countSql = options.countTotal ? buildCountSql(sql) : null;
          if (countSql) {
            try {
              const countResult = await withQueryTimeout(libClient.execute(countSql, params as any), 'query count');
              const parsedCount = Number((countResult.rows[0] as any)?.cnt);
              if (Number.isFinite(parsedCount)) totalRows = parsedCount;
            } catch {
              // Optional count failure must not discard query data.
            }
          }

          return previewResult(result.rows, limit, offset, totalRows, startedAt);
        }
      }

      const result = await libClient.execute(sql, params as any);
      return {
        ok: true,
        rows: result.rows?.slice(0, getHardMaxRows()),
        rowsReturned: result.rows?.length,
        limit: getHardMaxRows(),
        offset: 0,
        hasMore: (result.rows?.length || 0) > getHardMaxRows(),
        truncated: (result.rows?.length || 0) > getHardMaxRows(),
        rowsAffected: (result as any).rowsAffected,
        lastInsertRowid: (result as any).lastInsertRowid,
        durationMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      pool.evictOnError(database.id, error);
      throw new DatabaseError('LIBSQL_ERROR', error.message || 'Remote query failed', true);
    }
  }
}
