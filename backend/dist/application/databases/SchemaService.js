"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
class SchemaService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
    }
    async getSchema(databaseId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        if (database.type !== 'sqlite') {
            return { tables: [], note: 'schema introspection for remote/libsql can be added with a driver-specific adapter' };
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
