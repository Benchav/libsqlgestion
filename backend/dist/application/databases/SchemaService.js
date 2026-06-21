"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const ConnectionPool_1 = require("../../infrastructure/db/ConnectionPool");
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
async function loadSchemaViaLibsql(client, kind) {
    const objects = await client.execute(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
    const rows = objects.rows;
    const entries = [];
    for (const row of rows) {
        const tableName = row.name;
        const columnsResult = (await client.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`)).rows;
        const foreignKeysResult = (await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)).rows;
        const countRow = (await client.execute(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`)).rows;
        const rowCount = Number(countRow[0]?.cnt ?? 0);
        entries.push({
            table: tableName,
            kind,
            rowCount,
            columns: columnsResult,
            foreignKeys: foreignKeysResult,
        });
    }
    return entries;
}
async function loadSchemaViaSqlite(client, kind) {
    const rows = await client.all(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
    const entries = [];
    for (const row of rows) {
        const tableName = row.name;
        const columnsResult = await client.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
        const foreignKeysResult = await client.all(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
        const countRows = await client.all(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`);
        const rowCount = Number(countRows[0]?.cnt ?? 0);
        entries.push({
            table: tableName,
            kind,
            rowCount,
            columns: columnsResult,
            foreignKeys: foreignKeysResult,
        });
    }
    return entries;
}
class SchemaService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
    }
    async getSchema(databaseId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const pool = ConnectionPool_1.ConnectionPool.getInstance();
        const client = pool.getClient(database);
        if (client instanceof SqliteClient_1.SqliteClient) {
            try {
                const tables = await loadSchemaViaSqlite(client, 'table');
                const views = await loadSchemaViaSqlite(client, 'view');
                return { tables, views };
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw error;
            }
        }
        if (!database.url || !database.encryptedToken) {
            return { tables: [], note: 'missing url or token' };
        }
        const libClient = client;
        try {
            const tables = await loadSchemaViaLibsql(libClient, 'table');
            const views = await loadSchemaViaLibsql(libClient, 'view');
            return { tables, views };
        }
        catch (error) {
            pool.evictOnError(database.id, error);
            throw error;
        }
    }
}
exports.SchemaService = SchemaService;
