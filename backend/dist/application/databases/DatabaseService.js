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
const LibsqlNamespaceService_1 = require("../../infrastructure/libsql/LibsqlNamespaceService");
const ConnectionPool_1 = require("../../infrastructure/db/ConnectionPool");
const database_runtime_1 = require("./database-runtime");
class DatabaseService {
    constructor() {
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.projectRepo = data_source_1.AppDataSource.getRepository(Project_1.Project);
        this.auditService = new AuditService_1.AuditService();
        this.storageService = new SqliteStorageService_1.SqliteStorageService();
        this.runtimeService = new LibsqlRuntimeService_1.LibsqlRuntimeService();
        this.namespaceService = new LibsqlNamespaceService_1.LibsqlNamespaceService();
    }
    async createDatabase(projectId, input) {
        const project = await this.projectRepo.findOneByOrFail({ id: projectId });
        const subdomain = input.subdomain ? (0, slug_1.assertValidSubdomainLabel)(input.subdomain) : (0, slug_1.ensureSubdomain)(input.name, (0, tokens_1.randomToken)());
        const isNamespace = this.namespaceService.isEnabled() && (input.type === 'libsql' || (!input.url && process.env.SQLITE_PREFER_NAMESPACE === 'true'));
        if (isNamespace) {
            await this.namespaceService.createNamespace(subdomain);
            const token = input.token ?? this.namespaceService.generateToken(subdomain);
            const urls = this.namespaceService.buildNamespaceUrls(subdomain);
            const database = await this.databaseRepo.save(this.databaseRepo.create({
                name: input.name,
                type: 'libsql',
                status: 'active',
                subdomain,
                url: urls.connectionUrl,
                encryptedToken: (0, crypto_1.encrypt)(token),
                metadata: {
                    ...(input.metadata ?? {}),
                    runtime: {
                        provider: 'sqld-namespace',
                        namespace: subdomain,
                        connectionUrl: urls.connectionUrl,
                        internalUrl: urls.internalUrl,
                        backendUrl: urls.backendUrl,
                        publicUrl: urls.publicUrl,
                        publicHost: urls.publicHost,
                    },
                },
                project,
            }));
            await this.auditService.record({
                action: 'database.create',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { projectId, type: 'libsql', subdomain, runtime: 'sqld-namespace' },
            });
            return { database, token };
        }
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
        if (this.namespaceService.isEnabled()) {
            try {
                await this.storageService.importToNamespace(input.sourcePath, subdomain);
            }
            catch (err) {
                console.warn('[DatabaseService] Failed to copy SQLite file to namespace directory:', err);
            }
            await this.namespaceService.createNamespace(subdomain);
            const token = input.token ?? this.namespaceService.generateToken(subdomain);
            const urls = this.namespaceService.buildNamespaceUrls(subdomain);
            const database = await this.databaseRepo.save(this.databaseRepo.create({
                name: databaseName,
                type: 'libsql',
                status: 'active',
                subdomain,
                url: urls.connectionUrl,
                encryptedToken: (0, crypto_1.encrypt)(token),
                metadata: {
                    ...(input.metadata ?? {}),
                    imported: true,
                    sourcePath: input.sourcePath,
                    runtime: {
                        provider: 'sqld-namespace',
                        namespace: subdomain,
                        connectionUrl: urls.connectionUrl,
                        internalUrl: urls.internalUrl,
                        backendUrl: urls.backendUrl,
                        publicUrl: urls.publicUrl,
                        publicHost: urls.publicHost,
                    },
                },
                project,
            }));
            await this.auditService.record({
                action: 'database.import',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { projectId, sourcePath: input.sourcePath, subdomain, runtime: 'sqld-namespace' },
            });
            return { database, token };
        }
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
    async reconcileLegacyDatabases() {
        const databases = await this.databaseRepo.find();
        let reconciled = 0;
        for (const database of databases) {
            if (!(0, database_runtime_1.shouldReconcileLegacyLocalDatabase)(database)) {
                continue;
            }
            const normalized = (0, database_runtime_1.normalizeLegacyLocalDatabase)(database);
            database.type = normalized.type;
            database.status = normalized.status;
            database.metadata = normalized.metadata;
            await this.databaseRepo.save(database);
            reconciled += 1;
        }
        return { reconciled };
    }
    async rotateToken(id) {
        const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
        if (!database)
            throw new Error('database not found');
        if (database.status === 'provisioning') {
            throw new Error('Cannot rotate token while database is provisioning');
        }
        ConnectionPool_1.ConnectionPool.getInstance().evict(id);
        if (this.isManagedRuntimeEntry(database)) {
            const runtime = database.metadata?.runtime;
            if (runtime?.provider === 'sqld-namespace' && database.subdomain) {
                const newToken = this.namespaceService.generateToken(database.subdomain);
                database.encryptedToken = (0, crypto_1.encrypt)(newToken);
                await this.databaseRepo.save(database);
                await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
                return { database, token: newToken };
            }
            const runtimeBundle = await this.runtimeService.rotateDatabase(database);
            if (!runtimeBundle) {
                throw new Error('database runtime is missing');
            }
            database.encryptedToken = (0, crypto_1.encrypt)(runtimeBundle.token);
            database.metadata = mergeRuntimeMetadata(database.metadata, runtimeBundle.metadata);
            await this.databaseRepo.save(database);
            await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
            return { database, token: runtimeBundle.token };
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
        if (database.status === 'provisioning') {
            return { ok: false, details: 'Database is still provisioning. Please wait a moment and try again.' };
        }
        if (database.status === 'error') {
            const errorMsg = database.metadata?.runtimeError || 'Database runtime is in an error state.';
            return { ok: false, details: `Database runtime error: ${errorMsg}` };
        }
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
        if ((0, database_runtime_1.resolveEffectiveDatabaseType)(database) === 'sqlite') {
            const managedPath = this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
            const url = (database.url && fs_1.default.existsSync(database.url)) ? database.url : managedPath;
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
        const runtime = database.metadata?.runtime;
        if (runtime?.provider === 'sqld-namespace' && database.subdomain) {
            await this.namespaceService.deleteNamespace(database.subdomain);
            const nsPath = this.storageService.namespaceDatabasePath(database.subdomain);
            await fs_1.default.promises.rm(path_1.default.dirname(nsPath), { recursive: true, force: true }).catch(() => undefined);
        }
        else {
            await this.runtimeService.removeDatabase(database);
        }
        // Explicit physical file cleanup for SQLite files, WAL and SHM
        if ((0, database_runtime_1.resolveEffectiveDatabaseType)(database) === 'sqlite') {
            const candidates = new Set();
            if (database.url) {
                candidates.add(database.url);
                candidates.add(`${database.url}-wal`);
                candidates.add(`${database.url}-shm`);
            }
            if (database.project?.id) {
                const managed = this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
                candidates.add(managed);
                candidates.add(`${managed}-wal`);
                candidates.add(`${managed}-shm`);
            }
            for (const filePath of candidates) {
                await fs_1.default.promises.rm(filePath, { recursive: true, force: true }).catch(() => undefined);
            }
        }
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
        const managedPath = this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
        return (database.url && fs_1.default.existsSync(database.url)) ? database.url : managedPath;
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
            const errorMessage = this.runtimeService.getRuntimeErrorMessage(error);
            database.status = 'error';
            database.metadata = {
                ...(database.metadata ?? {}),
                runtimeError: errorMessage,
                lastProvisioningAttemptAt: new Date().toISOString(),
            };
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: 'database.provision_failed',
                resourceType: 'database',
                resourceId: database.id,
                metadata: { ...auditMetadata, error: errorMessage },
            });
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
function getManagedRuntimeUrl(database) {
    const runtimeUrl = (0, database_runtime_1.getRuntimeConnectionUrl)(database);
    if ((0, database_runtime_1.resolveEffectiveDatabaseType)(database) !== 'libsql') {
        return null;
    }
    return runtimeUrl || null;
}
function isManagedRuntimeType(input) {
    if (input.type === 'sqlite')
        return true;
    if (input.type === 'libsql' && !input.url)
        return true;
    return false;
}
