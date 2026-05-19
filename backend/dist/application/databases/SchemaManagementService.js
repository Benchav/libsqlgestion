"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaManagementService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const AuditService_1 = require("../audit/AuditService");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const LibsqlClient_1 = require("../../infrastructure/libsql/LibsqlClient");
const crypto_1 = require("../../infrastructure/crypto");
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
function validateTableName(name) {
    if (!name || typeof name !== 'string') {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Table name is required.', false);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Invalid table name.', false);
    }
    return name;
}
class SchemaManagementService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.auditService = new AuditService_1.AuditService();
    }
    async deleteTable(databaseId, tableName, actorId) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const safeTableName = validateTableName(tableName);
        if (database.type !== 'sqlite') {
            if (!database.url || !database.encryptedToken) {
                throw new SqliteClient_1.DatabaseError('SQLITE_SCHEMA_INVALID', 'Database connection is not configured.', false);
            }
            const client = (0, LibsqlClient_1.createLibsqlClient)(database.url, (0, crypto_1.decrypt)(database.encryptedToken));
            try {
                await client.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(safeTableName)}`);
            }
            catch (error) {
                throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Failed to drop table', true);
            }
            finally {
                client.close();
            }
        }
        else {
            const client = new SqliteClient_1.SqliteClient(database.url || '');
            try {
                await client.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(safeTableName)};`);
            }
            catch (error) {
                throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
            }
            finally {
                client.close();
            }
        }
        await this.auditService.record({
            action: 'schema.table.delete',
            resourceType: 'table',
            resourceId: safeTableName,
            actorId,
            metadata: { databaseId, tableName: safeTableName },
        });
        return { ok: true, table: safeTableName };
    }
}
exports.SchemaManagementService = SchemaManagementService;
