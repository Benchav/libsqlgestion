"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const READ_ONLY_REGEX = /^\s*(select|pragma|with)\b/i;
class QueryService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
    }
    async execute(databaseId, sql, params = []) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        if (database.type !== 'sqlite') {
            return { ok: false, error: 'query execution for remote/libsql is not wired yet' };
        }
        const client = new SqliteClient_1.SqliteClient(database.url || '');
        try {
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
