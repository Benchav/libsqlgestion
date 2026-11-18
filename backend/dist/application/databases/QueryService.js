"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const ConnectionPool_1 = require("../../infrastructure/db/ConnectionPool");
const sqlScript_1 = require("./sqlScript");
const READ_ONLY_REGEX = /^\s*(select|pragma|with|explain)\b/i;
const WRAPPABLE_REGEX = /^\s*(select|with)\b/i;
function positiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
function getQueryTimeoutMs() {
    return positiveInt(process.env.SQL_QUERY_TIMEOUT_MS, 15000);
}
function getHardMaxRows() {
    return Math.min(50000, positiveInt(process.env.QUERY_HARD_MAX_ROWS, 1000));
}
function stripTrailingSemicolon(sql) {
    return sql.trim().replace(/;\s*$/, '');
}
function buildPreviewSql(sql) {
    const trimmed = stripTrailingSemicolon(sql);
    if (!WRAPPABLE_REGEX.test(trimmed))
        return null;
    return `SELECT * FROM (\n${trimmed}\n) AS __libsqlite_preview LIMIT ? OFFSET ?`;
}
function buildCountSql(sql) {
    const trimmed = stripTrailingSemicolon(sql);
    if (!WRAPPABLE_REGEX.test(trimmed))
        return null;
    return `SELECT COUNT(*) AS cnt FROM (\n${trimmed}\n) AS __libsqlite_count`;
}
async function withQueryTimeout(promise, label, onTimeout) {
    const timeoutMs = getQueryTimeoutMs();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try {
                onTimeout?.();
            }
            catch {
                // Best-effort cancellation.
            }
            reject(new SqliteClient_1.DatabaseError('SQLITE_TIMEOUT', `${label} timed out after ${timeoutMs}ms`, false));
        }, timeoutMs);
        timer.unref?.();
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function normaliseLimit(value) {
    const hardMax = getHardMaxRows();
    const requested = value === undefined ? hardMax : value;
    return Math.max(1, Math.min(hardMax, Math.floor(requested)));
}
function previewResult(rows, limit, offset, totalRows, startedAt) {
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
class QueryService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
    }
    async execute(databaseId, sql, params = [], options = {}) {
        const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
        if (!database) {
            const err = new Error('Database not found');
            err.name = 'EntityNotFoundError';
            throw err;
        }
        const statements = (0, sqlScript_1.splitSqlStatements)(sql);
        const isScript = statements.length > 1;
        const isRead = READ_ONLY_REGEX.test(sql);
        const offset = Math.max(0, Math.floor(options.offset ?? 0));
        const requestedLimit = options.limit === undefined ? undefined : normaliseLimit(options.limit);
        const limit = requestedLimit ?? getHardMaxRows();
        const previewEnabled = true;
        if (isScript && params.length > 0) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCRIPT_PARAMS', 'Parameter binding is not supported for multi-statement scripts.', false);
        }
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        if (client instanceof SqliteClient_1.SqliteClient) {
            const startedAt = Date.now();
            try {
                if (isScript) {
                    await client.execAtomic(sql);
                    const statementResults = statements.map((statement, index) => ({
                        index: index + 1,
                        sql: statement,
                        kind: READ_ONLY_REGEX.test(statement) ? 'read' : 'write',
                    }));
                    return { ok: true, statementsExecuted: statements.length, statementResults, durationMs: Date.now() - startedAt };
                }
                if (isRead) {
                    const previewSql = previewEnabled ? buildPreviewSql(sql) : null;
                    if (previewSql) {
                        const rows = await withQueryTimeout(client.all(previewSql, [...params, limit + 1, offset]), 'query', () => client.interrupt());
                        let totalRows;
                        const countSql = options.countTotal ? buildCountSql(sql) : null;
                        if (countSql) {
                            try {
                                const countRows = await withQueryTimeout(client.all(countSql, params), 'query count', () => client.interrupt());
                                const rawCount = countRows[0]?.cnt;
                                const parsedCount = Number(rawCount);
                                if (Number.isFinite(parsedCount))
                                    totalRows = parsedCount;
                            }
                            catch {
                                // Data is still useful even if the optional count fails.
                            }
                        }
                        return previewResult(rows, limit, offset, totalRows, startedAt);
                    }
                    const allRows = await withQueryTimeout(client.all(sql, params), 'query', () => client.interrupt());
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
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
            }
        }
        const libClient = client;
        if (!database.url || !database.encryptedToken) {
            return { ok: false, error: 'missing url or token' };
        }
        const startedAt = Date.now();
        try {
            if (isScript) {
                const batchArgs = statements.map((stmt) => ({ sql: stmt, args: [] }));
                const results = await libClient.batch(batchArgs, 'write');
                const statementResults = results.map((result, index) => {
                    const statement = statements[index];
                    const isReadStatement = READ_ONLY_REGEX.test(statement);
                    return {
                        index: index + 1,
                        sql: statement,
                        kind: isReadStatement ? 'read' : 'write',
                        rows: result.rows?.slice(0, getHardMaxRows()),
                        rowsAffected: Number(result.rowsAffected ?? 0),
                        lastInsertRowid: result.lastInsertRowid,
                    };
                });
                const lastResult = results[results.length - 1];
                const rowsAffected = results.reduce((acc, r) => acc + Number(r.rowsAffected ?? 0), 0);
                const lastInsertRowid = lastResult?.lastInsertRowid;
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
                    const result = await withQueryTimeout(libClient.execute(previewSql, [...params, limit + 1, offset]), 'query');
                    let totalRows;
                    const countSql = options.countTotal ? buildCountSql(sql) : null;
                    if (countSql) {
                        try {
                            const countResult = await withQueryTimeout(libClient.execute(countSql, params), 'query count');
                            const parsedCount = Number(countResult.rows[0]?.cnt);
                            if (Number.isFinite(parsedCount))
                                totalRows = parsedCount;
                        }
                        catch {
                            // Optional count failure must not discard query data.
                        }
                    }
                    return previewResult(result.rows, limit, offset, totalRows, startedAt);
                }
            }
            const result = await libClient.execute(sql, params);
            return {
                ok: true,
                rows: result.rows?.slice(0, getHardMaxRows()),
                rowsReturned: result.rows?.length,
                limit: getHardMaxRows(),
                offset: 0,
                hasMore: (result.rows?.length || 0) > getHardMaxRows(),
                truncated: (result.rows?.length || 0) > getHardMaxRows(),
                rowsAffected: result.rowsAffected,
                lastInsertRowid: result.lastInsertRowid,
                durationMs: Date.now() - startedAt,
            };
        }
        catch (error) {
            pool.evictOnError(database.id, error);
            throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Remote query failed', true);
        }
    }
}
exports.QueryService = QueryService;
