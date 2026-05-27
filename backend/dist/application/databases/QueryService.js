"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const LibsqlClient_1 = require("../../infrastructure/libsql/LibsqlClient");
const crypto_1 = require("../../infrastructure/crypto");
const sqlScript_1 = require("./sqlScript");
const READ_ONLY_REGEX = /^\s*(select|pragma|with|explain)\b/i;
class QueryService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
    }
    async execute(databaseId, sql, params = []) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const statements = (0, sqlScript_1.splitSqlStatements)(sql);
        const isScript = statements.length > 1;
        if (isScript && params.length > 0) {
            throw new SqliteClient_1.DatabaseError('SQLITE_SCRIPT_PARAMS', 'Parameter binding is not supported for multi-statement scripts.', false);
        }
        if (database.type !== 'sqlite') {
            if (!database.url || !database.encryptedToken) {
                return { ok: false, error: 'missing url or token' };
            }
            const client = (0, LibsqlClient_1.createLibsqlClient)(database.url, (0, crypto_1.decrypt)(database.encryptedToken));
            try {
                if (isScript) {
                    const batchArgs = statements.map((stmt) => ({ sql: stmt, args: [] }));
                    const results = await client.batch(batchArgs, 'write');
                    const statementResults = results.map((result, index) => {
                        const statement = statements[index];
                        const isRead = READ_ONLY_REGEX.test(statement);
                        return {
                            index: index + 1,
                            sql: statement,
                            kind: isRead ? 'read' : 'write',
                            rows: result.rows,
                            rowsAffected: Number(result.rowsAffected ?? 0),
                            lastInsertRowid: result.lastInsertRowid,
                        };
                    });
                    // Aggregate values for compatibility with overall query result
                    const lastResult = results[results.length - 1];
                    const rowsAffected = results.reduce((acc, r) => acc + Number(r.rowsAffected ?? 0), 0);
                    const lastInsertRowid = lastResult?.lastInsertRowid;
                    return {
                        ok: true,
                        statementsExecuted: statements.length,
                        rows: lastResult?.rows,
                        rowsAffected,
                        lastInsertRowid,
                        statementResults,
                    };
                }
                const result = await client.execute(sql, params);
                return { ok: true, rows: result.rows, rowsAffected: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
            }
            catch (error) {
                throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Remote query failed', true);
            }
            finally {
                client.close();
            }
        }
        let client;
        try {
            client = new SqliteClient_1.SqliteClient(database.url || '');
        }
        catch (error) {
            // File validation errors from the constructor
            throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
        }
        try {
            if (isScript) {
                await client.execAtomic(sql);
                const statementResults = statements.map((statement, index) => ({
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
        }
        finally {
            client.close();
        }
    }
}
exports.QueryService = QueryService;
