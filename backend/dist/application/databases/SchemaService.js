"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const LibsqlClient_1 = require("../../infrastructure/libsql/LibsqlClient");
const crypto_1 = require("../../infrastructure/crypto");
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
                const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                const detailed = [];
                const tableRows = tables.rows;
                for (const row of tableRows) {
                    const columns = await client.execute(`PRAGMA table_info(${row.name})`);
                    const foreignKeys = await client.execute(`PRAGMA foreign_key_list(${row.name})`);
                    detailed.push({ table: row.name, columns: columns.rows, foreignKeys: foreignKeys.rows });
                }
                return { tables: detailed };
            }
            finally {
                client.close();
            }
        }
        const client = new SqliteClient_1.SqliteClient(database.url || '');
        try {
            const tables = (await client.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));
            const detailed = [];
            for (const table of tables) {
                const columns = (await client.all(`PRAGMA table_info(${table.name})`));
                const foreignKeys = (await client.all(`PRAGMA foreign_key_list(${table.name})`));
                detailed.push({ table: table.name, columns, foreignKeys });
            }
            return { tables: detailed };
        }
        finally {
            client.close();
        }
    }
}
exports.SchemaService = SchemaService;
