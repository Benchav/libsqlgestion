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
        let managedPath;
        let managedRuntime = null;
        let managedRuntimeMetadata;
        const canProvisionRuntime = this.isManagedRuntimeRequest(input) && this.runtimeService.isEnabled();
        const provisionAsync = canProvisionRuntime && this.shouldProvisionAsync();
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: canProvisionRuntime ? 'libsql' : input.type,
            url: input.url,
            subdomain,
            status: canProvisionRuntime ? 'provisioning' : 'inactive',
            metadata: input.metadata,
            project,
        }));
        try {
            if (canProvisionRuntime) {
                managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id, database.type);
                if (provisionAsync) {
                    this.scheduleManagedRuntimeProvisioning({
                        databaseId: database.id,
                        managedPath,
                        auditAction: 'database.create',
                        auditMetadata: { projectId, type: input.type, subdomain: input.subdomain },
                    });
                    return { database };
                }
                try {
                    managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
                    managedRuntimeMetadata = managedRuntime.metadata;
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
                catch (error) {
                    await this.markProvisioningError(database, error, managedPath);
                    throw error;
                }
            }
            if (input.type === 'sqlite') {
                managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id, database.type);
                await fs_1.default.promises.writeFile(managedPath, '');
                // Initialize the new SQLite file and set WAL mode persistently once
                const initClient = new SqliteClient_1.SqliteClient(managedPath);
                try {
                    await initClient.run('PRAGMA journal_mode = WAL;');
                }
                finally {
                    await initClient.close();
                }
                const token = input.token ?? (0, tokens_1.randomToken)();
                database.url = managedPath;
                database.status = 'active';
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
                    action: 'database.create',
                    resourceType: 'database',
                    resourceId: database.id,
                    metadata: { projectId, type: input.type, subdomain: input.subdomain, runtime: 'local-file' },
                });
                return { database, token };
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
            if (database.status === 'error') {
                throw error;
            }
            await this.cleanupCreatedDatabase(database.id, managedPath ? [managedPath] : [], managedRuntimeMetadata);
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
        const canProvisionRuntime = this.runtimeService.isEnabled();
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: databaseName,
            type: canProvisionRuntime ? 'libsql' : 'sqlite',
            status: canProvisionRuntime ? 'provisioning' : 'inactive',
            subdomain,
            metadata: { ...(input.metadata ?? {}), imported: true, sourcePath: input.sourcePath },
            project,
        }));
        const managedPath = await this.storageService.importDatabaseFile(input.sourcePath, project.id, database.id, database.type);
        let managedRuntime = null;
        let managedRuntimeMetadata;
        try {
            if (canProvisionRuntime) {
                if (this.shouldProvisionAsync()) {
                    this.scheduleManagedRuntimeProvisioning({
                        databaseId: database.id,
                        managedPath,
                        auditAction: 'database.import',
                        auditMetadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain },
                    });
                    return { database };
                }
                try {
                    managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
                    managedRuntimeMetadata = managedRuntime.metadata;
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
                    await this.markProvisioningError(database, error, managedPath);
                    throw error;
                }
            }
            const token = input.token ?? (0, tokens_1.randomToken)();
            database.url = managedPath;
            database.status = 'active';
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
            return { database, token };
        }
        catch (error) {
            if (database.status === 'error') {
                throw error;
            }
            await this.cleanupCreatedDatabase(database.id, [managedPath], managedRuntimeMetadata);
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
        // Evict old connection from pool before rotating credentials
        ConnectionPool_1.ConnectionPool.getInstance().evict(id);
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
        // Evict connection from pool before removing the database
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
        // Resolve the source SQLite file path
        const sourcePath = sourceDatabase.url || this.storageService.managedDatabasePath(project.id, sourceDatabase.id, sourceDatabase.type);
        if (!fs_1.default.existsSync(sourcePath)) {
            throw new Error('source database file not found on disk');
        }
        const subdomain = (0, slug_1.ensureSubdomain)(input.name, (0, tokens_1.randomToken)());
        const canProvisionRuntime = this.runtimeService.isEnabled();
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name: input.name,
            type: canProvisionRuntime ? 'libsql' : sourceDatabase.type,
            status: canProvisionRuntime ? 'provisioning' : 'inactive',
            subdomain,
            metadata: {
                backup: true,
                sourceId: sourceDatabase.id,
                sourceName: sourceDatabase.name,
                backupTimestamp: new Date().toISOString(),
            },
            project,
        }));
        // Copy the SQLite file byte-by-byte to the new managed location
        const managedPath = await this.storageService.importDatabaseFile(sourcePath, project.id, database.id, database.type);
        let managedRuntime = null;
        let managedRuntimeMetadata;
        try {
            if (canProvisionRuntime) {
                if (this.shouldProvisionAsync()) {
                    this.scheduleManagedRuntimeProvisioning({
                        databaseId: database.id,
                        managedPath,
                        auditAction: 'database.backup',
                        auditMetadata: { sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id },
                    });
                    return { database };
                }
                try {
                    managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
                    managedRuntimeMetadata = managedRuntime.metadata;
                    database.url = managedPath;
                    database.status = 'active';
                    database.encryptedToken = (0, crypto_1.encrypt)(managedRuntime.token);
                    database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
                    await this.databaseRepo.save(database);
                    await this.auditService.record({
                        action: 'database.backup',
                        resourceType: 'database',
                        resourceId: database.id,
                        metadata: { sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id, runtime: managedRuntime.metadata.provider },
                    });
                    return { database, token: managedRuntime.token };
                }
                catch (error) {
                    await this.markProvisioningError(database, error, managedPath);
                    throw error;
                }
            }
            const token = (0, tokens_1.randomToken)();
            database.url = managedPath;
            database.status = 'active';
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
            return { database, token };
        }
        catch (error) {
            if (database.status === 'error') {
                throw error;
            }
            await this.cleanupCreatedDatabase(database.id, [managedPath], managedRuntimeMetadata);
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
    async markProvisioningError(database, error, managedPath) {
        database.status = 'error';
        database.url = managedPath || database.url;
        database.metadata = {
            ...(database.metadata ?? {}),
            runtimeError: this.runtimeService.getRuntimeErrorMessage(error),
            lastProvisioningAttemptAt: new Date().toISOString(),
        };
        await this.databaseRepo.save(database);
    }
    shouldProvisionAsync() {
        return String(process.env.LIBSQL_PROVISION_ASYNC || 'false').toLowerCase() === 'true';
    }
    scheduleManagedRuntimeProvisioning(input) {
        setImmediate(async () => {
            const database = await this.databaseRepo.findOne({ where: { id: input.databaseId }, relations: ['project'] }).catch(() => null);
            if (!database) {
                return;
            }
            try {
                const managedRuntime = await this.runtimeService.provisionDatabase(database, input.managedPath);
                database.url = input.managedPath;
                database.status = 'active';
                database.encryptedToken = (0, crypto_1.encrypt)(managedRuntime.token);
                database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
                await this.databaseRepo.save(database);
                await this.auditService.record({
                    action: input.auditAction,
                    resourceType: 'database',
                    resourceId: database.id,
                    metadata: { ...input.auditMetadata, runtime: managedRuntime.metadata.provider, asyncProvisioned: true },
                });
            }
            catch (error) {
                await this.markProvisioningError(database, error, input.managedPath);
            }
        });
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
function getManagedRuntimeUrl(database) {
    const runtime = database.metadata?.runtime;
    if (!runtime || runtime.provider !== 'docker-libsql') {
        return null;
    }
    if (typeof runtime.connectionUrl === 'string') {
        return runtime.connectionUrl;
    }
    if (typeof runtime.internalUrl === 'string') {
        return runtime.internalUrl;
    }
    if (typeof runtime.publicUrl === 'string') {
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
