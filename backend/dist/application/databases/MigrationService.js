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
        // Validate migration name
        if (!input.name || input.name.trim().length === 0) {
            throw new Error('Migration name is required');
        }
        if (!/^[a-zA-Z0-9_\-. ]+$/.test(input.name.trim())) {
            throw new Error('Migration name can only contain letters, numbers, underscores, hyphens, dots, and spaces.');
        }
        const statements = this.normalizeStatements(input);
        if (!statements.length)
            throw new Error('No SQL statements provided');
        const checksum = this.calculateChecksum(databaseId, input.name, statements);
        // Check for exact duplicate (same name + same SQL)
        const existing = await this.migrationRepo.findOneBy({ checksum });
        if (existing)
            return existing;
        // Check for name collision with different SQL
        const existingByName = await this.migrationRepo.findOne({
            where: { database: { id: databaseId }, name: input.name.trim() },
        });
        if (existingByName && existingByName.checksum !== checksum) {
            throw new Error(`A migration named "${input.name}" already exists with different SQL. Use a unique name.`);
        }
        const migration = this.migrationRepo.create({
            database,
            name: input.name.trim(),
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
            await this.auditService.record({
                action: 'database.migration.failed',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { name: input.name, checksum, error: error.message },
            });
            throw error;
        }
    }
    /**
     * Improved SQL statement splitter that respects string literals.
     * Handles strings delimited by single quotes, and avoids splitting on `;` inside them.
     */
    normalizeStatements(input) {
        if (input.statements?.length) {
            return input.statements
                .filter(Boolean)
                .map((statement) => statement.trim())
                .filter(Boolean)
                .map((statement) => (statement.endsWith(';') ? statement : `${statement};`));
        }
        if (input.sql) {
            return this.splitSql(input.sql);
        }
        return [];
    }
    /**
     * Splits SQL text into individual statements, respecting single-quoted strings.
     * `;` inside strings (e.g., INSERT INTO t VALUES('a;b')) will NOT cause a split.
     */
    splitSql(sql) {
        const statements = [];
        let current = '';
        let inString = false;
        let escape = false;
        for (let i = 0; i < sql.length; i++) {
            const ch = sql[i];
            if (escape) {
                current += ch;
                escape = false;
                continue;
            }
            if (ch === '\\') {
                current += ch;
                escape = true;
                continue;
            }
            if (ch === "'") {
                // Handle escaped quotes ('') inside SQLite strings
                if (inString && i + 1 < sql.length && sql[i + 1] === "'") {
                    current += "''";
                    i++;
                    continue;
                }
                inString = !inString;
                current += ch;
                continue;
            }
            if (ch === ';' && !inString) {
                const trimmed = current.trim();
                if (trimmed.length > 0) {
                    statements.push(`${trimmed};`);
                }
                current = '';
                continue;
            }
            current += ch;
        }
        // Handle last statement without trailing ;
        const trimmed = current.trim();
        if (trimmed.length > 0) {
            statements.push(trimmed.endsWith(';') ? trimmed : `${trimmed};`);
        }
        return statements;
    }
    calculateChecksum(databaseId, name, statements) {
        return crypto_1.default.createHash('sha256').update([databaseId, name, ...statements].join('\n')).digest('hex');
    }
    /**
     * Applies migration statements to a SQLite database wrapped in a transaction.
     * If any statement fails, all changes are rolled back.
     */
    async applyToSqlite(database, statements) {
        let client;
        try {
            client = new SqliteClient_1.SqliteClient(database.url || '');
        }
        catch (error) {
            throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
        }
        try {
            await client.run('BEGIN TRANSACTION;');
            for (const statement of statements) {
                await client.run(statement);
            }
            await client.run('COMMIT;');
        }
        catch (error) {
            // Attempt rollback — if it fails, the original error is still thrown
            try {
                await client.run('ROLLBACK;');
            }
            catch { /* ignore rollback errors */ }
            throw error instanceof SqliteClient_1.DatabaseError ? error : SqliteClient_1.DatabaseError.from(error);
        }
        finally {
            client.close();
        }
    }
    /**
     * Applies migration statements to a libSQL database.
     * Uses the batch API when available for transactional execution.
     */
    async applyToLibsql(database, statements) {
        if (!database.url || !database.encryptedToken)
            throw new Error('missing url or token');
        const client = (0, LibsqlClient_1.createLibsqlClient)(database.url, (0, crypto_2.decrypt)(database.encryptedToken));
        try {
            // Attempt batch execution for atomicity
            try {
                await client.batch(statements.map((s) => ({ sql: s })), 'write');
            }
            catch {
                // Fallback: execute one by one (older libsql clients)
                for (const statement of statements) {
                    await client.execute(statement);
                }
            }
        }
        catch (error) {
            throw new SqliteClient_1.DatabaseError('LIBSQL_ERROR', error.message || 'Remote migration failed', true);
        }
        finally {
            client.close();
        }
    }
}
exports.MigrationService = MigrationService;
