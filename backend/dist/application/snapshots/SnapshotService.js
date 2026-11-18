"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const typeorm_1 = require("typeorm");
const data_source_1 = require("../../infrastructure/db/data-source");
const Database_1 = require("../../domain/entities/Database");
const DatabaseSnapshot_1 = require("../../domain/entities/DatabaseSnapshot");
const crypto_2 = require("../../infrastructure/crypto");
const tokens_1 = require("../../infrastructure/security/tokens");
const slug_1 = require("../../infrastructure/security/slug");
const SqliteClient_1 = require("../../infrastructure/sqlite/SqliteClient");
const SqliteStorageService_1 = require("../../infrastructure/storage/SqliteStorageService");
const database_runtime_1 = require("../databases/database-runtime");
const local_database_path_1 = require("../databases/local-database-path");
const snapshot_config_1 = require("./snapshot-config");
const AuditService_1 = require("../audit/AuditService");
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Shared across SnapshotService instances (API controller + scheduler) so a
// single backend process respects one concurrency limit and does not mark an
// actively running snapshot as stale.
const snapshotRuntimeState = {
    activeRuns: 0,
    waiters: [],
    activeSnapshotIds: new Set(),
};
function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}
function quoteSqlite(value) {
    return value.replace(/'/g, "''");
}
function formatTimestamp(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
async function fileSha256(filePath) {
    const hash = crypto_1.default.createHash('sha256');
    for await (const chunk of fs_1.default.createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}
class SnapshotService {
    constructor() {
        this.snapshotRepo = data_source_1.AppDataSource.getRepository(DatabaseSnapshot_1.DatabaseSnapshot);
        this.databaseRepo = data_source_1.AppDataSource.getRepository(Database_1.Database);
        this.storageService = new SqliteStorageService_1.SqliteStorageService();
        this.auditService = new AuditService_1.AuditService();
    }
    async acquireRunSlot() {
        const maxConcurrent = Math.max(1, (0, snapshot_config_1.getSnapshotConfig)().maxConcurrent);
        if (snapshotRuntimeState.activeRuns < maxConcurrent) {
            snapshotRuntimeState.activeRuns += 1;
            return;
        }
        await new Promise((resolve) => {
            snapshotRuntimeState.waiters.push(resolve);
        });
    }
    releaseRunSlot() {
        const next = snapshotRuntimeState.waiters.shift();
        if (next) {
            // Transfer the slot directly to the next waiter.
            next();
            return;
        }
        snapshotRuntimeState.activeRuns = Math.max(0, snapshotRuntimeState.activeRuns - 1);
    }
    async runExclusive(job) {
        await this.acquireRunSlot();
        try {
            return await job();
        }
        finally {
            this.releaseRunSlot();
        }
    }
    supportsDatabase(database) {
        return (0, database_runtime_1.resolveEffectiveDatabaseType)(database) === 'sqlite';
    }
    async listSnapshots(databaseId, options = {}) {
        const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
        const snapshots = await this.snapshotRepo.find({
            where: { databaseId, status: (0, typeorm_1.Not)('deleted') },
            order: { takenAt: 'DESC' },
            take: limit + 1,
        });
        const visible = snapshots
            .filter((snapshot) => !options.before || new Date(snapshot.takenAt).getTime() < options.before.getTime());
        const page = visible.slice(0, limit);
        const totalSizeBytes = visible
            .filter((snapshot) => snapshot.status === 'ready')
            .reduce((total, snapshot) => total + Number(snapshot.sizeBytes || 0), 0);
        return {
            snapshots: page,
            totalSizeBytes,
            hasMore: visible.length > limit,
            policy: (0, snapshot_config_1.getSnapshotPolicy)(),
        };
    }
    async getSnapshot(databaseId, snapshotId) {
        const snapshot = await this.snapshotRepo.findOne({ where: { id: snapshotId, databaseId } });
        if (!snapshot || snapshot.status === 'deleted') {
            throw httpError(404, 'snapshot not found');
        }
        return snapshot;
    }
    async getSchedulerState(databaseId) {
        const [latest, pending] = await Promise.all([
            this.snapshotRepo.findOne({ where: { databaseId }, order: { takenAt: 'DESC' } }),
            this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } }),
        ]);
        return {
            latest: latest && latest.status !== 'deleted' ? latest : null,
            pending: Boolean(pending),
        };
    }
    async createSnapshot(databaseId, options = {}) {
        const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
        if (!database)
            throw httpError(404, 'database not found');
        if (!this.supportsDatabase(database)) {
            throw httpError(409, 'snapshots are only supported for LOCAL-FILE SQLite databases');
        }
        const sourcePath = (0, local_database_path_1.resolveLocalDatabasePath)(database, { createIfMissing: false });
        if (!sourcePath) {
            throw httpError(404, 'database file not found on disk');
        }
        await this.markStalePending();
        const existing = await this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } });
        if (existing) {
            throw httpError(409, 'a snapshot is already in progress for this database');
        }
        const takenAt = new Date();
        const fileName = `${formatTimestamp(takenAt)}-${crypto_1.default.randomUUID().slice(0, 8)}.db`;
        const filePath = this.storageService.snapshotFilePath(database.project.id, database.id, fileName);
        let snapshot;
        try {
            snapshot = await this.snapshotRepo.save(this.snapshotRepo.create({
                databaseId: database.id,
                projectId: database.project.id,
                status: 'pending',
                reason: options.reason || 'manual',
                filePath,
                fileName,
                sizeBytes: 0,
                takenAt,
                pinned: options.pinned === true,
            }));
        }
        catch (error) {
            const pending = await this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } });
            if (pending) {
                throw httpError(409, 'a snapshot is already in progress for this database');
            }
            throw error;
        }
        snapshotRuntimeState.activeSnapshotIds.add(snapshot.id);
        const saved = await this.runExclusive(async () => {
            const tempPath = path_1.default.join(path_1.default.dirname(filePath), `.tmp-${snapshot.id}.db`);
            const startedAt = Date.now();
            let finalized = false;
            try {
                await fs_1.default.promises.mkdir(path_1.default.dirname(filePath), { recursive: true });
                await this.assertDiskSpace(sourcePath, path_1.default.dirname(filePath));
                await fs_1.default.promises.rm(tempPath, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${tempPath}-wal`, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${tempPath}-shm`, { force: true }).catch(() => undefined);
                const client = new SqliteClient_1.SqliteClient(sourcePath);
                try {
                    await client.exec('PRAGMA busy_timeout = 30000;');
                    await client.exec(`VACUUM INTO '${quoteSqlite(tempPath)}';`);
                }
                finally {
                    await client.close();
                }
                const verification = new SqliteClient_1.SqliteClient(tempPath);
                try {
                    const integrity = await verification.checkIntegrity();
                    if (!integrity.ok) {
                        throw new Error(`snapshot integrity check failed: ${integrity.details}`);
                    }
                }
                finally {
                    await verification.close();
                }
                await fs_1.default.promises.rm(`${tempPath}-wal`, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${tempPath}-shm`, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(filePath, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rename(tempPath, filePath);
                finalized = true;
                const stat = await fs_1.default.promises.stat(filePath);
                const checksumSha256 = await fileSha256(filePath);
                snapshot.status = 'ready';
                snapshot.sizeBytes = stat.size;
                snapshot.checksumSha256 = checksumSha256;
                snapshot.errorMessage = undefined;
                snapshot.metadata = {
                    ...(snapshot.metadata ?? {}),
                    durationMs: Date.now() - startedAt,
                    sourceDatabaseId: database.id,
                };
                const saved = await this.snapshotRepo.save(snapshot);
                if (saved.reason !== 'scheduled') {
                    await this.auditService.record({
                        action: 'database.snapshot.create',
                        resourceType: 'database',
                        resourceId: database.id,
                        actorId: options.actorId,
                        ipAddress: options.ipAddress,
                        metadata: {
                            snapshotId: saved.id,
                            reason: saved.reason,
                            sizeBytes: saved.sizeBytes,
                            pinned: saved.pinned,
                        },
                    });
                }
                else {
                    console.log(`[snapshots] created ${saved.fileName} for ${database.name} (${saved.sizeBytes} bytes)`);
                }
                return saved;
            }
            catch (error) {
                const failedPath = finalized ? filePath : tempPath;
                await fs_1.default.promises.rm(failedPath, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${failedPath}-wal`, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${failedPath}-shm`, { force: true }).catch(() => undefined);
                snapshot.status = 'failed';
                snapshot.errorMessage = error?.message || 'snapshot failed';
                snapshot.metadata = {
                    ...(snapshot.metadata ?? {}),
                    durationMs: Date.now() - startedAt,
                };
                await this.snapshotRepo.save(snapshot).catch(() => undefined);
                await this.auditService.record({
                    action: 'database.snapshot.failed',
                    resourceType: 'database',
                    resourceId: database.id,
                    actorId: options.actorId,
                    ipAddress: options.ipAddress,
                    metadata: {
                        snapshotId: snapshot.id,
                        reason: snapshot.reason,
                        error: snapshot.errorMessage,
                    },
                }).catch(() => undefined);
                if (error?.statusCode)
                    throw error;
                throw httpError(500, `failed to create snapshot: ${snapshot.errorMessage}`);
            }
        }).finally(() => {
            snapshotRuntimeState.activeSnapshotIds.delete(snapshot.id);
        });
        await this.pruneSnapshots(databaseId).catch((error) => {
            console.warn(`[snapshots] retention pruning failed for ${databaseId}:`, error?.message || error);
        });
        return saved;
    }
    async deleteSnapshot(databaseId, snapshotId, actorId, ipAddress) {
        const snapshot = await this.getSnapshot(databaseId, snapshotId);
        await fs_1.default.promises.rm(snapshot.filePath, { force: true }).catch(() => undefined);
        await fs_1.default.promises.rm(`${snapshot.filePath}-wal`, { force: true }).catch(() => undefined);
        await fs_1.default.promises.rm(`${snapshot.filePath}-shm`, { force: true }).catch(() => undefined);
        await this.snapshotRepo.update(snapshot.id, {
            status: 'deleted',
            expiresAt: new Date(),
        });
        await this.auditService.record({
            action: 'database.snapshot.delete',
            resourceType: 'database',
            resourceId: databaseId,
            actorId,
            ipAddress,
            metadata: { snapshotId, reason: snapshot.reason, takenAt: snapshot.takenAt },
        });
        return { ok: true };
    }
    async restoreSnapshot(databaseId, snapshotId, input = {}) {
        const sourceDatabase = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
        if (!sourceDatabase)
            throw httpError(404, 'database not found');
        if (!this.supportsDatabase(sourceDatabase)) {
            throw httpError(409, 'snapshots are only supported for LOCAL-FILE SQLite databases');
        }
        const snapshot = await this.getSnapshot(databaseId, snapshotId);
        if (snapshot.status !== 'ready') {
            throw httpError(409, 'snapshot is not ready to restore');
        }
        if (!fs_1.default.existsSync(snapshot.filePath)) {
            throw httpError(404, 'snapshot file not found on disk');
        }
        const config = (0, snapshot_config_1.getSnapshotConfig)();
        if (config.verifyOnRestore && snapshot.checksumSha256) {
            const actual = await fileSha256(snapshot.filePath);
            if (actual !== snapshot.checksumSha256) {
                throw httpError(409, 'snapshot checksum verification failed');
            }
        }
        const timestamp = formatTimestamp(new Date());
        const name = String(input.name || '').trim() || `${sourceDatabase.name}-restore-${timestamp}`;
        if (name.length > 512) {
            throw httpError(422, 'restore database name is too long');
        }
        const subdomain = (0, slug_1.ensureSubdomain)(name, (0, tokens_1.randomToken)());
        const token = (0, tokens_1.randomToken)();
        const database = await this.databaseRepo.save(this.databaseRepo.create({
            name,
            type: 'sqlite',
            status: 'inactive',
            subdomain,
            metadata: {
                restoredFrom: {
                    databaseId: sourceDatabase.id,
                    databaseName: sourceDatabase.name,
                    snapshotId: snapshot.id,
                    takenAt: snapshot.takenAt,
                },
                restoredAt: new Date().toISOString(),
            },
            project: sourceDatabase.project,
        }));
        let managedPath = '';
        try {
            managedPath = await this.storageService.restoreSnapshotFile(snapshot.filePath, sourceDatabase.project.id, database.id);
            const client = new SqliteClient_1.SqliteClient(managedPath);
            try {
                await client.exec('PRAGMA journal_mode = WAL;');
            }
            finally {
                await client.close();
            }
            database.url = managedPath;
            database.status = 'active';
            database.encryptedToken = (0, crypto_2.encrypt)(token);
            database.metadata = {
                ...(database.metadata ?? {}),
                runtime: {
                    provider: 'local-file',
                    databasePath: managedPath,
                    connectionUrl: managedPath,
                    internalUrl: managedPath,
                    publicUrl: managedPath,
                },
            };
            await this.databaseRepo.save(database);
            await this.auditService.record({
                action: 'database.snapshot.restore',
                resourceType: 'database',
                resourceId: database.id,
                actorId: input.actorId,
                ipAddress: input.ipAddress,
                metadata: {
                    sourceDatabaseId: sourceDatabase.id,
                    snapshotId: snapshot.id,
                    snapshotTakenAt: snapshot.takenAt,
                    targetDatabaseId: database.id,
                },
            });
            return { database, token };
        }
        catch (error) {
            if (managedPath) {
                await fs_1.default.promises.rm(managedPath, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${managedPath}-wal`, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${managedPath}-shm`, { force: true }).catch(() => undefined);
            }
            await this.databaseRepo.remove(database).catch(() => undefined);
            if (error?.statusCode)
                throw error;
            throw httpError(500, `failed to restore snapshot: ${error?.message || error}`);
        }
    }
    async pruneSnapshots(databaseId, now = new Date()) {
        const config = (0, snapshot_config_1.getSnapshotConfig)();
        const snapshots = await this.snapshotRepo.find({
            where: { databaseId, status: 'ready' },
            order: { takenAt: 'DESC' },
        });
        if (snapshots.length === 0) {
            return { deleted: 0 };
        }
        const keep = new Set();
        const fullWindowMs = config.fullWindowHours * 60 * 60 * 1000;
        const sixHourlyWindowMs = config.sixHourlyWindowHours * 60 * 60 * 1000;
        const retentionMs = config.retentionDays * DAY_MS;
        const sixHourBuckets = new Set();
        const dayBuckets = new Set();
        snapshots.forEach((snapshot, index) => {
            if (index < 2 || snapshot.pinned) {
                keep.add(snapshot.id);
                return;
            }
            const age = now.getTime() - new Date(snapshot.takenAt).getTime();
            const takenAtMs = new Date(snapshot.takenAt).getTime();
            if (age <= fullWindowMs) {
                keep.add(snapshot.id);
                return;
            }
            if (age <= sixHourlyWindowMs) {
                const bucket = Math.floor(takenAtMs / SIX_HOURS_MS);
                if (!sixHourBuckets.has(bucket)) {
                    sixHourBuckets.add(bucket);
                    keep.add(snapshot.id);
                }
                return;
            }
            if (age <= retentionMs) {
                const bucket = Math.floor(takenAtMs / DAY_MS);
                if (!dayBuckets.has(bucket)) {
                    dayBuckets.add(bucket);
                    keep.add(snapshot.id);
                }
            }
        });
        let deleted = 0;
        for (const snapshot of snapshots) {
            if (keep.has(snapshot.id))
                continue;
            try {
                await fs_1.default.promises.rm(snapshot.filePath, { force: true });
                await fs_1.default.promises.rm(`${snapshot.filePath}-wal`, { force: true }).catch(() => undefined);
                await fs_1.default.promises.rm(`${snapshot.filePath}-shm`, { force: true }).catch(() => undefined);
            }
            catch {
                // Keep the row so the next pruning pass can retry the file removal.
                continue;
            }
            await this.snapshotRepo.update(snapshot.id, {
                status: 'deleted',
                expiresAt: now,
            });
            deleted += 1;
        }
        if (deleted > 0) {
            await this.auditService.record({
                action: 'database.snapshot.prune',
                resourceType: 'database',
                resourceId: databaseId,
                metadata: {
                    deleted,
                    kept: keep.size,
                    retentionDays: config.retentionDays,
                },
            });
        }
        return { deleted };
    }
    async recoverInterruptedSnapshots() {
        const pending = await this.snapshotRepo.find({ where: { status: 'pending' } });
        for (const snapshot of pending) {
            if (snapshotRuntimeState.activeSnapshotIds.has(snapshot.id))
                continue;
            const tempPath = path_1.default.join(path_1.default.dirname(snapshot.filePath), `.tmp-${snapshot.id}.db`);
            await fs_1.default.promises.rm(tempPath, { force: true }).catch(() => undefined);
            await fs_1.default.promises.rm(`${tempPath}-wal`, { force: true }).catch(() => undefined);
            await fs_1.default.promises.rm(`${tempPath}-shm`, { force: true }).catch(() => undefined);
            await fs_1.default.promises.rm(snapshot.filePath, { force: true }).catch(() => undefined);
            await fs_1.default.promises.rm(`${snapshot.filePath}-wal`, { force: true }).catch(() => undefined);
            await fs_1.default.promises.rm(`${snapshot.filePath}-shm`, { force: true }).catch(() => undefined);
            await this.snapshotRepo.update(snapshot.id, {
                status: 'failed',
                errorMessage: 'snapshot was interrupted by a backend restart',
            });
        }
    }
    async cleanupOrphans() {
        await this.markStalePending();
        const root = this.storageService.snapshotRootDirectory();
        const threshold = Date.now() - (0, snapshot_config_1.getSnapshotConfig)().staleMinutes * 60 * 1000;
        const walk = async (directory) => {
            let entries = [];
            try {
                entries = await fs_1.default.promises.readdir(directory, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path_1.default.join(directory, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                    continue;
                }
                if (!entry.isFile() || !entry.name.startsWith('.tmp-'))
                    continue;
                try {
                    const stat = await fs_1.default.promises.stat(fullPath);
                    if (stat.mtimeMs < threshold) {
                        await fs_1.default.promises.rm(fullPath, { force: true });
                    }
                }
                catch {
                    // Best-effort cleanup only.
                }
            }
        };
        await walk(root);
    }
    async markStalePending() {
        const threshold = Date.now() - (0, snapshot_config_1.getSnapshotConfig)().staleMinutes * 60 * 1000;
        const pending = await this.snapshotRepo.find({ where: { status: 'pending' } });
        for (const snapshot of pending) {
            if (snapshotRuntimeState.activeSnapshotIds.has(snapshot.id))
                continue;
            if (new Date(snapshot.takenAt).getTime() >= threshold)
                continue;
            await fs_1.default.promises.rm(path_1.default.join(path_1.default.dirname(snapshot.filePath), `.tmp-${snapshot.id}.db`), { force: true }).catch(() => undefined);
            await this.snapshotRepo.update(snapshot.id, {
                status: 'failed',
                errorMessage: 'snapshot was interrupted before it completed',
            });
        }
    }
    async assertDiskSpace(sourcePath, targetDirectory) {
        const config = (0, snapshot_config_1.getSnapshotConfig)();
        let sourceSize = 0;
        try {
            sourceSize = (await fs_1.default.promises.stat(sourcePath)).size;
        }
        catch {
            sourceSize = 0;
        }
        const required = Math.max(sourceSize * 2, config.minFreeBytes);
        try {
            const stats = await fs_1.default.promises.statfs(targetDirectory);
            const freeBytes = Number(stats.bavail) * Number(stats.bsize);
            if (Number.isFinite(freeBytes) && freeBytes < required) {
                throw httpError(507, `not enough free disk space for snapshot: need ${required} bytes, have ${freeBytes} bytes`);
            }
        }
        catch (error) {
            if (error?.statusCode)
                throw error;
            // statfs may be unavailable on some platforms; do not block snapshots for that.
        }
    }
}
exports.SnapshotService = SnapshotService;
