"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const ConnectionPool_1 = require("../../infrastructure/db/ConnectionPool");
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
async function loadSchemaEntries(client, kind) {
    let rows;
    if ('execute' in client) {
        const objects = await client.execute(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
        rows = objects.rows;
    }
    else {
        rows = await client.readAll(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
    }
    const entries = [];
    for (const row of rows) {
        const tableName = row.name;
        let columnsResult;
        let foreignKeysResult;
        let countResult;
        if ('execute' in client) {
            const libClient = client;
            columnsResult = (await libClient.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`)).rows;
            foreignKeysResult = (await libClient.execute(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)).rows;
            countResult = Number((await libClient.execute(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`)).rows[0]?.cnt ?? 0);
        }
        else {
            const readClient = client;
            columnsResult = await readClient.readAll(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
            foreignKeysResult = await readClient.readAll(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
            countResult = Number((await readClient.readAll(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`))[0]?.cnt ?? 0);
        }
        entries.push({
            table: tableName,
            kind,
            rowCount: countResult,
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
        if (database.type !== 'sqlite') {
            if (!database.url || !database.encryptedToken) {
                return { tables: [], note: 'missing url or token' };
            }
            const client = pool.getClient(database);
            try {
                const tables = await loadSchemaEntries(client, 'table');
                const views = await loadSchemaEntries(client, 'view');
                return { tables, views };
            }
            catch (error) {
                pool.evictOnError(database.id, error);
                throw error;
            }
        }
        const client = pool.getSqliteClient(database);
        try {
            const sqliteReader = {
                readAll: async (sql) => (await client.all(sql)),
            };
            const tables = await loadSchemaEntries(sqliteReader, 'table');
            const views = await loadSchemaEntries(sqliteReader, 'view');
            return { tables, views };
        }
        catch (error) {
            pool.evictOnError(database.id, error);
            throw error;
        }
    }
}
exports.SchemaService = SchemaService;
