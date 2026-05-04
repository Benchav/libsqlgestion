"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const DatabaseMigration_1 = require("../../domain/entities/DatabaseMigration");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const LibsqlClient_1 = require("../../infrastructure/libsql/LibsqlClient");
const crypto_2 = require("../../infrastructure/crypto");
const AuditService_1 = require("../audit/AuditService");
class MigrationService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.migrationRepo = data_source_1.AppDataSource.getRepository(DatabaseMigration_1.DatabaseMigration);
        this.auditService = new AuditService_1.AuditService();
    }
    async list(databaseId) {
        return this.migrationRepo.find({ where: { database: { id: databaseId } }, order: { appliedAt: 'DESC' } });
    }
    async apply(databaseId, input) {
        const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
        const statements = this.normalizeStatements(input);
        if (!statements.length)
            throw new Error('No SQL statements provided');
        const checksum = this.calculateChecksum(databaseId, input.name, statements);
        const existing = await this.migrationRepo.findOneBy({ checksum });
        if (existing)
            return existing;
        const migration = this.migrationRepo.create({
            database,
            name: input.name,
            checksum,
            statements,
            source: input.source ?? 'api',
            status: 'pending',
        });
        await this.migrationRepo.save(migration);
        try {
            if (database.type === 'sqlite') {
                await this.applyToSqlite(database, statements);
            }
            else {
                await this.applyToLibsql(database, statements);
            }
            migration.status = 'applied';
            await this.migrationRepo.save(migration);
            await this.auditService.record({
                action: 'database.migration.apply',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { name: input.name, checksum, statementCount: statements.length },
            });
            return migration;
        }
        catch (error) {
            migration.status = 'failed';
            migration.errorMessage = error.message;
            await this.migrationRepo.save(migration);
            throw error;
        }
    }
    normalizeStatements(input) {
        if (input.statements?.length)
            return input.statements.filter(Boolean).map((statement) => statement.trim()).filter(Boolean);
        if (input.sql) {
            return input.sql
                .split(';')
                .map((statement) => statement.trim())
                .filter(Boolean)
                .map((statement) => `${statement};`);
        }
        return [];
    }
    calculateChecksum(databaseId, name, statements) {
        return crypto_1.default.createHash('sha256').update([databaseId, name, ...statements].join('\n')).digest('hex');
    }
    async applyToSqlite(database, statements) {
        const client = new SqliteClient_1.SqliteClient(database.url || '');
        try {
            for (const statement of statements) {
                await client.run(statement);
            }
        }
        finally {
            client.close();
        }
    }
    async applyToLibsql(database, statements) {
        if (!database.url || !database.encryptedToken)
            throw new Error('missing url or token');
        const client = (0, LibsqlClient_1.createLibsqlClient)(database.url, (0, crypto_2.decrypt)(database.encryptedToken));
        try {
            for (const statement of statements) {
                await client.execute(statement);
            }
        }
        finally {
            client.close();
        }
    }
}
exports.MigrationService = MigrationService;
