"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const LibsqlClient_1 = require("../../infrastructure/libsql/LibsqlClient");
const crypto_1 = require("../../infrastructure/crypto");
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
async function loadSchemaEntries(client, kind) {
    const objects = await client.execute(`SELECT name FROM sqlite_master WHERE type='${kind}' AND name NOT LIKE 'sqlite_%'`);
    const entries = [];
    const rows = objects.rows;
    for (const row of rows) {
        const tableName = row.name;
        const columnsResult = await client.execute(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
        const foreignKeysResult = await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
        const countResult = await client.execute(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(tableName)}`);
        const rowCount = Number(countResult.rows[0]?.cnt ?? 0);
        entries.push({
            table: tableName,
            kind,
            rowCount,
            columns: columnsResult.rows,
            foreignKeys: foreignKeysResult.rows,
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
        if (database.type !== 'sqlite') {
            if (!database.url || !database.encryptedToken) {
                return { tables: [], note: 'missing url or token' };
            }
            const client = (0, LibsqlClient_1.createLibsqlClient)(database.url, (0, crypto_1.decrypt)(database.encryptedToken));
            try {
                const tables = await loadSchemaEntries(client, 'table');
                const views = await loadSchemaEntries(client, 'view');
                return { tables, views };
            }
            finally {
                client.close();
            }
        }
        const client = new SqliteClient_1.SqliteClient(database.url || '');
        try {
            const tables = await loadSchemaEntries({
                execute: async (sql) => ({ rows: (await client.all(sql)) }),
            }, 'table');
            const views = await loadSchemaEntries({
                execute: async (sql) => ({ rows: (await client.all(sql)) }),
            }, 'view');
            return { tables, views };
        }
        finally {
            client.close();
        }
    }
}
exports.SchemaService = SchemaService;
