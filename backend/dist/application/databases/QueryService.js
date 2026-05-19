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
                    const statementResults = [];
                    let rows;
                    let rowsAffected = 0;
                    let lastInsertRowid;
                    await client.execute('BEGIN IMMEDIATE');
                    try {
                        for (const [index, statement] of statements.entries()) {
                            if (READ_ONLY_REGEX.test(statement)) {
                                const result = await client.execute(statement);
                                const step = {
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
                            const step = {
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
                    }
                    catch (error) {
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
                const statementResults = [];
                let rows;
                let rowsAffected = 0;
                let lastInsertRowid;
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
                }
                catch (error) {
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
        }
        finally {
            client.close();
        }
    }
}
exports.QueryService = QueryService;
