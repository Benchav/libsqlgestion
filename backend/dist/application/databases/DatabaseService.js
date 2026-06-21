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
const ConnectionPool_1 = require("../../infrastructure/db/ConnectionPool");
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
        const subdomain = input.subdomain ? (0, slug_1.assertValidSubdomainLabel)(input.subdomain) : (0, slug_1.ensureSubdomain)(input.name, (0, tokens_1.randomToken)());
        const willProvisionRuntime = this.isManagedRuntimeRequest(input) && this.runtimeService.isEnabled();
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: input.type,
            status: willProvisionRuntime ? 'provisioning' : 'inactive',
            subdomain,
            metadata: input.metadata,
            project,
        }));
        let managedPath;
        try {
            const token = input.token ?? (0, tokens_1.randomToken)();
            if (input.type === 'sqlite' || willProvisionRuntime) {
                const storageType = willProvisionRuntime ? 'libsql' : input.type;
                managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id, storageType);
                if (input.type === 'sqlite' && !willProvisionRuntime) {
                    const initClient = new SqliteClient_1.SqliteClient(managedPath);
                    try {
                        await initClient.run('PRAGMA journal_mode = WAL;');
                    }
                    finally {
                        await initClient.close();
                    }
                }
            }
            database.url = managedPath || input.url || undefined;
            database.status = database.type === 'remote' && !managedPath ? (input.url ? 'active' : 'inactive') : willProvisionRuntime ? 'provisioning' : 'active';
            database.encryptedToken = (0, crypto_1.encrypt)(token);
            database.metadata = mergeRuntimeMetadata(database.metadata, {
                provider: 'local-file',
                databasePath: managedPath || null,
                connectionUrl: managedPath || null,
                internalUrl: managedPath || null,
                publicUrl: managedPath || null,
            });
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: 'database.create',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { projectId, type: input.type, subdomain: input.subdomain, runtime: 'local-file' },
            });
            if (willProvisionRuntime && managedPath) {
                this.attemptRuntimeProvisioning(database.id, managedPath, 'database.create', {
                    projectId, type: input.type, subdomain: input.subdomain,
                }).catch((error) => {
                    console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
                });
            }
            return { database, token };
        }
        catch (error) {
            await this.cleanupCreatedDatabase(database.id, managedPath ? [managedPath] : []);
            throw error;
        }
    }
    async importExistingSqlite(projectId, input) {
        const project = await this.projectRepo.findOneByOrFail({ id: projectId });
        if (!fs_1.default.existsSync(input.sourcePath)) {
            throw new Error('sourcePath does not exist');
        }
        const databaseName = deriveDatabaseName(input.name, input.sourceName, input.sourcePath);
        const subdomain = input.subdomain ? (0, slug_1.assertValidSubdomainLabel)(input.subdomain) : (0, slug_1.ensureSubdomain)(databaseName, (0, tokens_1.randomToken)());
        const willProvisionRuntime = this.runtimeService.isEnabled();
        const storageType = willProvisionRuntime ? 'libsql' : 'sqlite';
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: databaseName,
            type: 'sqlite',
            status: willProvisionRuntime ? 'provisioning' : 'inactive',
            subdomain,
            metadata: { ...(input.metadata ?? {}), imported: true, sourcePath: input.sourcePath },
            project,
        }));
        const managedPath = await this.storageService.importDatabaseFile(input.sourcePath, project.id, database.id, storageType);
        try {
            const token = input.token ?? (0, tokens_1.randomToken)();
            database.url = managedPath;
            database.status = willProvisionRuntime ? 'provisioning' : 'active';
            database.encryptedToken = (0, crypto_1.encrypt)(token);
            database.metadata = mergeRuntimeMetadata(database.metadata, {
                provider: 'local-file',
                databasePath: managedPath,
                connectionUrl: managedPath,
                internalUrl: managedPath,
                publicUrl: managedPath,
            });
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: 'database.import',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain, runtime: 'local-file' },
            });
            if (willProvisionRuntime) {
                this.attemptRuntimeProvisioning(database.id, managedPath, 'database.import', {
                    projectId, sourcePath: input.sourcePath, subdomain: input.subdomain,
                }).catch((error) => {
                    console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
                });
            }
            return { database, token };
        }
        catch (error) {
            await this.cleanupCreatedDatabase(database.id, [managedPath]);
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
        ConnectionPool_1.ConnectionPool.getInstance().evict(id);
        if (this.isManagedRuntimeEntry(database)) {
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
        if (isLocalFileDatabase(database)) {
            const url = database.url || this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
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
        ConnectionPool_1.ConnectionPool.getInstance().evict(id);
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
    async backupDatabase(sourceId, input) {
        const sourceDatabase = await this.databaseRepo.findOne({ where: { id: sourceId }, relations: ['project'] });
        if (!sourceDatabase)
            throw new Error('source database not found');
        const project = sourceDatabase.project;
        const sourcePath = sourceDatabase.url || this.storageService.managedDatabasePath(project.id, sourceDatabase.id, sourceDatabase.type);
        if (!fs_1.default.existsSync(sourcePath)) {
            throw new Error('source database file not found on disk');
        }
        const subdomain = (0, slug_1.ensureSubdomain)(input.name, (0, tokens_1.randomToken)());
        const willProvisionRuntime = this.runtimeService.isEnabled();
        const storageType = willProvisionRuntime ? 'libsql' : sourceDatabase.type;
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: sourceDatabase.type,
            status: willProvisionRuntime ? 'provisioning' : 'inactive',
            subdomain,
            metadata: {
                backup: true,
                sourceId: sourceDatabase.id,
                sourceName: sourceDatabase.name,
                backupTimestamp: new Date().toISOString(),
            },
            project,
        }));
        const managedPath = await this.storageService.importDatabaseFile(sourcePath, project.id, database.id, storageType);
        try {
            const token = (0, tokens_1.randomToken)();
            database.url = managedPath;
            database.status = willProvisionRuntime ? 'provisioning' : 'active';
            database.encryptedToken = (0, crypto_1.encrypt)(token);
            database.metadata = mergeRuntimeMetadata(database.metadata, {
                provider: 'local-file',
                databasePath: managedPath,
                connectionUrl: managedPath,
                internalUrl: managedPath,
                publicUrl: managedPath,
            });
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: 'database.backup',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id, runtime: 'local-file' },
            });
            if (willProvisionRuntime) {
                this.attemptRuntimeProvisioning(database.id, managedPath, 'database.backup', {
                    sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id,
                }).catch((error) => {
                    console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
                });
            }
            return { database, token };
        }
        catch (error) {
            await this.cleanupCreatedDatabase(database.id, [managedPath]);
            throw error;
        }
    }
    async getDatabaseFilePath(id) {
        const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
        if (!database)
            throw new Error('database not found');
        return database.url || this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
    }
    isManagedRuntimeRequest(input) {
        return isManagedRuntimeType(input);
    }
    isManagedRuntimeEntry(database) {
        return getManagedRuntimeUrl(database) !== null;
    }
    async attemptRuntimeProvisioning(databaseId, managedPath, auditAction, auditMetadata) {
        const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
        if (!database)
            return;
        try {
            const managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
            database.type = 'libsql';
            database.url = managedPath;
            database.status = 'active';
            database.encryptedToken = (0, crypto_1.encrypt)(managedRuntime.token);
            database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: auditAction,
                resourceType: 'database',
                resourceId: database.id,
                metadata: { ...auditMetadata, runtime: managedRuntime.metadata.provider, asyncProvisioned: true },
            });
        }
        catch (error) {
            database.status = 'error';
            database.metadata = {
                ...(database.metadata ?? {}),
                runtimeError: this.runtimeService.getRuntimeErrorMessage(error),
                lastProvisioningAttemptAt: new Date().toISOString(),
            };
            await this.databaseRepo.save(database);
        }
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
            }
            await this.databaseRepo.remove(database);
        }
        for (const filePath of extraPaths) {
            try {
                await fs_1.default.promises.rm(filePath, { force: true });
            }
            catch {
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
        runtimeError: undefined,
        lastHealthyAt: new Date().toISOString(),
        runtime,
    };
}
function isLocalFileDatabase(database) {
    const runtime = database.metadata?.runtime;
    if (runtime?.provider === 'docker-libsql')
        return false;
    if (database.type === 'sqlite')
        return true;
    if (!database.url)
        return true;
    return !/^(https?|libsql):\/\//.test(database.url);
}
function getManagedRuntimeUrl(database) {
    const runtime = database.metadata?.runtime;
    if (!runtime || runtime.provider !== 'docker-libsql') {
        return null;
    }
    if (typeof runtime.connectionUrl === 'string')
        return runtime.connectionUrl;
    if (typeof runtime.internalUrl === 'string')
        return runtime.internalUrl;
    if (typeof runtime.publicUrl === 'string')
        return runtime.publicUrl;
    if (database.type === 'sqlite' && database.url && database.url.startsWith('http'))
        return database.url;
    return null;
}
function isManagedRuntimeType(input) {
    if (input.type === 'sqlite')
        return true;
    if (input.type === 'libsql' && !input.url)
        return true;
    return false;
}
