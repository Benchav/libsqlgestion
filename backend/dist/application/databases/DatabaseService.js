"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const Project_1 = require("../../domain/entities/Project");
const crypto_1 = require("../../infrastructure/crypto");
const tokens_1 = require("../../infrastructure/security/tokens");
const AuditService_1 = require("../audit/AuditService");
const LibsqlClient_1 = require("../../infrastructure/libsql/LibsqlClient");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const slug_1 = require("../../infrastructure/security/slug");
const SqliteStorageService_1 = require("../../infrastructure/storage/SqliteStorageService");
const LibsqlRuntimeService_1 = require("../../infrastructure/docker/LibsqlRuntimeService");
class DatabaseService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.projectRepo = data_source_1.AppDataSource.getRepository(Project_1.Project);
        this.auditService = new AuditService_1.AuditService();
        this.storageService = new SqliteStorageService_1.SqliteStorageService();
        this.runtimeService = new LibsqlRuntimeService_1.LibsqlRuntimeService();
    }
    async createDatabase(projectId, input) {
        const project = await this.projectRepo.findOneByOrFail({ id: projectId });
        const subdomain = input.subdomain ?? (0, slug_1.ensureSubdomain)(input.name, (0, tokens_1.randomToken)());
        let managedPath;
        let managedRuntime = null;
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: input.type,
            url: input.url,
            subdomain,
            status: 'inactive',
            metadata: input.metadata,
            project,
        }));
        try {
            if (this.isManagedRuntimeRequest(input)) {
                managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id);
                managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
                database.url = managedPath;
                database.status = 'active';
                database.encryptedToken = (0, crypto_1.encrypt)(managedRuntime.token);
                database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
                await this.databaseRepo.save(database);
                await this.auditService.record({
                    action: 'database.create',
                    resourceType: 'database',
                    resourceId: database.id,
                    metadata: { projectId, type: input.type, subdomain: input.subdomain, runtime: managedRuntime.metadata.provider },
                });
                return { database, token: managedRuntime.token };
            }
            const token = input.token ?? (0, tokens_1.randomToken)();
            database.encryptedToken = (0, crypto_1.encrypt)(token);
            if (input.url) {
                database.status = 'active';
            }
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: 'database.create',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { projectId, type: input.type, subdomain: input.subdomain },
            });
            return { database, token };
        }
        catch (error) {
            await this.cleanupCreatedDatabase(database.id, managedPath ? [managedPath] : [], managedRuntime?.metadata);
            throw error;
        }
    }
    async importExistingSqlite(projectId, input) {
        const project = await this.projectRepo.findOneByOrFail({ id: projectId });
        if (!fs_1.default.existsSync(input.sourcePath)) {
            throw new Error('sourcePath does not exist');
        }
        const databaseName = deriveDatabaseName(input.name, input.sourceName, input.sourcePath);
        const subdomain = input.subdomain ?? (0, slug_1.ensureSubdomain)(databaseName, (0, tokens_1.randomToken)());
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: databaseName,
            type: 'sqlite',
            status: 'inactive',
            subdomain,
            metadata: { ...(input.metadata ?? {}), imported: true, sourcePath: input.sourcePath },
            project,
        }));
        const managedPath = await this.storageService.importDatabaseFile(input.sourcePath, project.id, database.id);
        let managedRuntime = null;
        try {
            managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
            database.url = managedPath;
            database.status = 'active';
            database.encryptedToken = (0, crypto_1.encrypt)(managedRuntime.token);
            database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: 'database.import',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain, runtime: managedRuntime.metadata.provider },
            });
            return { database, token: managedRuntime.token };
        }
        catch (error) {
            await this.cleanupCreatedDatabase(database.id, [managedPath], managedRuntime?.metadata);
            throw error;
        }
    }
    async listDatabases(projectId) {
        if (!projectId)
            return this.databaseRepo.find({ relations: ['project', 'project.owner'] });
        return this.databaseRepo.find({ where: { project: { id: projectId } }, relations: ['project', 'project.owner'] });
    }
    async getDatabase(id) {
        return this.databaseRepo.findOne({ where: { id }, relations: ['project', 'project.owner'] });
    }
    async rotateToken(id) {
        const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
        if (!database)
            throw new Error('database not found');
        if (this.isManagedRuntime(database)) {
            const runtime = await this.runtimeService.rotateDatabase(database);
            if (!runtime) {
                throw new Error('database runtime is missing');
            }
            database.encryptedToken = (0, crypto_1.encrypt)(runtime.token);
            database.metadata = mergeRuntimeMetadata(database.metadata, runtime.metadata);
            await this.databaseRepo.save(database);
            await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
            return { database, token: runtime.token };
        }
        const newToken = (0, tokens_1.randomToken)();
        database.encryptedToken = (0, crypto_1.encrypt)(newToken);
        await this.databaseRepo.save(database);
        await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
        return { database, token: newToken };
    }
    async testConnection(id) {
        const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
        if (!database)
            throw new Error('database not found');
        const runtimeUrl = getManagedRuntimeUrl(database);
        if (runtimeUrl && database.encryptedToken) {
            const token = (0, crypto_1.decrypt)(database.encryptedToken);
            const libClient = (0, LibsqlClient_1.createLibsqlClient)(runtimeUrl, token);
            try {
                await libClient.execute('SELECT 1');
                return { ok: true, details: 'connection ok' };
            }
            catch (error) {
                return { ok: false, details: error.message };
            }
            finally {
                libClient.close();
            }
        }
        if (database.type === 'sqlite') {
            const url = database.url || this.storageService.managedDatabasePath(database.project.id, database.id);
            if (!fs_1.default.existsSync(url)) {
                return { ok: false, details: 'sqlite file missing', code: 'SQLITE_CANTOPEN' };
            }
            let client;
            try {
                client = new SqliteClient_1.SqliteClient(url);
            }
            catch (error) {
                return { ok: false, details: error.message || 'failed to open database', code: error.code || 'SQLITE_CANTOPEN' };
            }
            try {
                const integrity = await client.checkIntegrity();
                if (!integrity.ok) {
                    return { ok: false, details: `Integrity check failed: ${integrity.details}`, code: 'SQLITE_CORRUPT' };
                }
                return { ok: true, details: 'sqlite connection ok - integrity check passed' };
            }
            catch (error) {
                return { ok: false, details: error.message || 'failed to verify database', code: error.code || 'SQLITE_ERROR' };
            }
            finally {
                client.close();
            }
        }
        if (!database.url || !database.encryptedToken)
            return { ok: false, details: 'missing url or token' };
        const token = (0, crypto_1.decrypt)(database.encryptedToken);
        const libClient = (0, LibsqlClient_1.createLibsqlClient)(database.url, token);
        try {
            await libClient.execute('SELECT 1');
            return { ok: true, details: 'connection ok' };
        }
        catch (error) {
            return { ok: false, details: error.message };
        }
        finally {
            libClient.close();
        }
    }
    async deleteDatabase(id) {
        const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
        if (!database)
            throw new Error('database not found');
        await this.runtimeService.removeDatabase(database);
        await this.databaseRepo.remove(database);
        await this.auditService.record({
            action: 'database.delete',
            resourceType: 'database',
            resourceId: id,
            metadata: { name: database.name, type: database.type },
        });
        return { ok: true };
    }
    async updateDatabase(id, input) {
        const database = await this.databaseRepo.findOneByOrFail({ id });
        if (input.name)
            database.name = input.name;
        if (input.status)
            database.status = input.status;
        await this.databaseRepo.save(database);
        await this.auditService.record({
            action: 'database.update',
            resourceType: 'database',
            resourceId: id,
            metadata: input,
        });
        return database;
    }
    isManagedRuntimeRequest(input) {
        return isManagedRuntimeType(input);
    }
    isManagedRuntime(database) {
        return getManagedRuntimeUrl(database) !== null;
    }
    async cleanupCreatedDatabase(databaseId, extraPaths = [], runtimeMetadata) {
        const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
        if (database) {
            try {
                await this.runtimeService.removeDatabase({
                    ...database,
                    metadata: runtimeMetadata ? { ...(database.metadata ?? {}), runtime: runtimeMetadata } : database.metadata,
                });
            }
            catch {
                // Best-effort cleanup after a failed create/import flow.
            }
            await this.databaseRepo.remove(database);
        }
        for (const filePath of extraPaths) {
            try {
                await fs_1.default.promises.rm(filePath, { force: true });
            }
            catch {
                // Best-effort cleanup.
            }
        }
    }
}
exports.DatabaseService = DatabaseService;
function deriveDatabaseName(name, sourceName, sourcePath) {
    const explicitName = name?.trim();
    if (explicitName)
        return explicitName;
    const candidate = sourceName || (sourcePath ? path_1.default.basename(sourcePath) : '');
    return candidate.replace(/\.[^.]+$/, '').trim() || 'imported-database';
}
function mergeRuntimeMetadata(existing, runtime) {
    return {
        ...(existing ?? {}),
        runtime,
    };
}
function getManagedRuntimeUrl(database) {
    const runtime = database.metadata?.runtime;
    if (runtime && typeof runtime.internalUrl === 'string') {
        return runtime.internalUrl;
    }
    if (runtime && typeof runtime.publicUrl === 'string') {
        return runtime.publicUrl;
    }
    if (database.type === 'sqlite' && database.url && database.url.startsWith('http')) {
        return database.url;
    }
    return null;
}
function isManagedRuntimeType(input) {
    if (input.type === 'sqlite')
        return true;
    if (input.type === 'libsql' && !input.url)
        return true;
    return false;
}
