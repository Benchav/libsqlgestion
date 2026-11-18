import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Not } from 'typeorm';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import {
  DatabaseSnapshot,
  DatabaseSnapshotReason,
} from '../../domain/entities/DatabaseSnapshot';
import { encrypt } from '../../infrastructure/crypto';
import { randomToken } from '../../infrastructure/security/tokens';
import { ensureSubdomain } from '../../infrastructure/security/slug';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';
import { resolveEffectiveDatabaseType } from '../databases/database-runtime';
import { resolveLocalDatabasePath } from '../databases/local-database-path';
import { getSnapshotConfig, getSnapshotPolicy } from './snapshot-config';
import { AuditService } from '../audit/AuditService';

type SnapshotListOptions = {
  limit?: number;
  before?: Date;
};

type CreateSnapshotOptions = {
  reason?: DatabaseSnapshotReason;
  pinned?: boolean;
  actorId?: string;
  ipAddress?: string;
};

type RestoreSnapshotInput = {
  name?: string;
  actorId?: string;
  ipAddress?: string;
};

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Shared across SnapshotService instances (API controller + scheduler) so a
// single backend process respects one concurrency limit and does not mark an
// actively running snapshot as stale.
const snapshotRuntimeState = {
  activeRuns: 0,
  waiters: [] as Array<() => void>,
  activeSnapshotIds: new Set<string>(),
};

function httpError(statusCode: number, message: string) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function quoteSqlite(value: string) {
  return value.replace(/'/g, "''");
}

function formatTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function fileSha256(filePath: string) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export class SnapshotService {
  private snapshotRepo = AppDataSource.getRepository(DatabaseSnapshot);
  private databaseRepo = AppDataSource.getRepository(Database);
  private storageService = new SqliteStorageService();
  private auditService = new AuditService();

  private async acquireRunSlot() {
    const maxConcurrent = Math.max(1, getSnapshotConfig().maxConcurrent);
    if (snapshotRuntimeState.activeRuns < maxConcurrent) {
      snapshotRuntimeState.activeRuns += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      snapshotRuntimeState.waiters.push(resolve);
    });
  }

  private releaseRunSlot() {
    const next = snapshotRuntimeState.waiters.shift();
    if (next) {
      // Transfer the slot directly to the next waiter.
      next();
      return;
    }
    snapshotRuntimeState.activeRuns = Math.max(0, snapshotRuntimeState.activeRuns - 1);
  }

  private async runExclusive<T>(job: () => Promise<T>): Promise<T> {
    await this.acquireRunSlot();
    try {
      return await job();
    } finally {
      this.releaseRunSlot();
    }
  }

  supportsDatabase(database: Pick<Database, 'type' | 'url' | 'metadata'>) {
    return resolveEffectiveDatabaseType(database) === 'sqlite';
  }

  async listSnapshots(databaseId: string, options: SnapshotListOptions = {}) {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
    const snapshots = await this.snapshotRepo.find({
      where: { databaseId, status: Not('deleted') },
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
      policy: getSnapshotPolicy(),
    };
  }

  async getSnapshot(databaseId: string, snapshotId: string) {
    const snapshot = await this.snapshotRepo.findOne({ where: { id: snapshotId, databaseId } });
    if (!snapshot || snapshot.status === 'deleted') {
      throw httpError(404, 'snapshot not found');
    }
    return snapshot;
  }

  async getSchedulerState(databaseId: string) {
    const [latest, pending] = await Promise.all([
      this.snapshotRepo.findOne({ where: { databaseId }, order: { takenAt: 'DESC' } }),
      this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } }),
    ]);

    return {
      latest: latest && latest.status !== 'deleted' ? latest : null,
      pending: Boolean(pending),
    };
  }

  async createSnapshot(databaseId: string, options: CreateSnapshotOptions = {}) {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!database) throw httpError(404, 'database not found');
    if (!this.supportsDatabase(database)) {
      throw httpError(409, 'snapshots are only supported for LOCAL-FILE SQLite databases');
    }

    const sourcePath = resolveLocalDatabasePath(database, { createIfMissing: false });
    if (!sourcePath) {
      throw httpError(404, 'database file not found on disk');
    }

    await this.markStalePending();

    const existing = await this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } });
    if (existing) {
      throw httpError(409, 'a snapshot is already in progress for this database');
    }

    const takenAt = new Date();
    const fileName = `${formatTimestamp(takenAt)}-${crypto.randomUUID().slice(0, 8)}.db`;
    const filePath = this.storageService.snapshotFilePath(database.project.id, database.id, fileName);

    let snapshot: DatabaseSnapshot;
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
    } catch (error: any) {
      const pending = await this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } });
      if (pending) {
        throw httpError(409, 'a snapshot is already in progress for this database');
      }
      throw error;
    }

    snapshotRuntimeState.activeSnapshotIds.add(snapshot.id);
    const saved = await this.runExclusive(async () => {
      const tempPath = path.join(path.dirname(filePath), `.tmp-${snapshot.id}.db`);
      const startedAt = Date.now();
      let finalized = false;
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await this.assertDiskSpace(sourcePath, path.dirname(filePath));
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${tempPath}-wal`, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${tempPath}-shm`, { force: true }).catch(() => undefined);

        const client = new SqliteClient(sourcePath);
        try {
          await client.exec('PRAGMA busy_timeout = 30000;');
          await client.exec(`VACUUM INTO '${quoteSqlite(tempPath)}';`);
        } finally {
          await client.close();
        }

        const verification = new SqliteClient(tempPath);
        try {
          const integrity = await verification.checkIntegrity();
          if (!integrity.ok) {
            throw new Error(`snapshot integrity check failed: ${integrity.details}`);
          }
        } finally {
          await verification.close();
        }

        await fs.promises.rm(`${tempPath}-wal`, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${tempPath}-shm`, { force: true }).catch(() => undefined);

        await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
        await fs.promises.rename(tempPath, filePath);
        finalized = true;

        const stat = await fs.promises.stat(filePath);
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
        } else {
          console.log(
            `[snapshots] created ${saved.fileName} for ${database.name} (${saved.sizeBytes} bytes)`,
          );
        }

        return saved;
      } catch (error: any) {
        const failedPath = finalized ? filePath : tempPath;
        await fs.promises.rm(failedPath, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${failedPath}-wal`, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${failedPath}-shm`, { force: true }).catch(() => undefined);
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

        if (error?.statusCode) throw error;
        throw httpError(500, `failed to create snapshot: ${snapshot.errorMessage}`);
      }
    }).finally(() => {
      snapshotRuntimeState.activeSnapshotIds.delete(snapshot.id);
    });

    await this.pruneSnapshots(databaseId).catch((error: any) => {
      console.warn(`[snapshots] retention pruning failed for ${databaseId}:`, error?.message || error);
    });

    return saved;
  }

  async deleteSnapshot(databaseId: string, snapshotId: string, actorId?: string, ipAddress?: string) {
    const snapshot = await this.getSnapshot(databaseId, snapshotId);
    await fs.promises.rm(snapshot.filePath, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${snapshot.filePath}-wal`, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${snapshot.filePath}-shm`, { force: true }).catch(() => undefined);
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

  async restoreSnapshot(databaseId: string, snapshotId: string, input: RestoreSnapshotInput = {}) {
    const sourceDatabase = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!sourceDatabase) throw httpError(404, 'database not found');
    if (!this.supportsDatabase(sourceDatabase)) {
      throw httpError(409, 'snapshots are only supported for LOCAL-FILE SQLite databases');
    }

    const snapshot = await this.getSnapshot(databaseId, snapshotId);
    if (snapshot.status !== 'ready') {
      throw httpError(409, 'snapshot is not ready to restore');
    }
    if (!fs.existsSync(snapshot.filePath)) {
      throw httpError(404, 'snapshot file not found on disk');
    }

    const config = getSnapshotConfig();
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

    const subdomain = ensureSubdomain(name, randomToken());
    const token = randomToken();

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
      managedPath = await this.storageService.restoreSnapshotFile(
        snapshot.filePath,
        sourceDatabase.project.id,
        database.id,
      );

      const client = new SqliteClient(managedPath);
      try {
        await client.exec('PRAGMA journal_mode = WAL;');
      } finally {
        await client.close();
      }

      database.url = managedPath;
      database.status = 'active';
      database.encryptedToken = encrypt(token);
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
    } catch (error: any) {
      if (managedPath) {
        await fs.promises.rm(managedPath, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${managedPath}-wal`, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${managedPath}-shm`, { force: true }).catch(() => undefined);
      }
      await this.databaseRepo.remove(database).catch(() => undefined);
      if (error?.statusCode) throw error;
      throw httpError(500, `failed to restore snapshot: ${error?.message || error}`);
    }
  }

  async pruneSnapshots(databaseId: string, now = new Date()) {
    const config = getSnapshotConfig();
    const snapshots = await this.snapshotRepo.find({
      where: { databaseId, status: 'ready' },
      order: { takenAt: 'DESC' },
    });

    if (snapshots.length === 0) {
      return { deleted: 0 };
    }

    const keep = new Set<string>();
    const fullWindowMs = config.fullWindowHours * 60 * 60 * 1000;
    const sixHourlyWindowMs = config.sixHourlyWindowHours * 60 * 60 * 1000;
    const retentionMs = config.retentionDays * DAY_MS;
    const sixHourBuckets = new Set<number>();
    const dayBuckets = new Set<number>();

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
      if (keep.has(snapshot.id)) continue;
      try {
        await fs.promises.rm(snapshot.filePath, { force: true });
        await fs.promises.rm(`${snapshot.filePath}-wal`, { force: true }).catch(() => undefined);
        await fs.promises.rm(`${snapshot.filePath}-shm`, { force: true }).catch(() => undefined);
      } catch {
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

  async cleanupOrphans() {
    await this.markStalePending();

    const root = this.storageService.snapshotRootDirectory();
    const threshold = Date.now() - getSnapshotConfig().staleMinutes * 60 * 1000;

    const walk = async (directory: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.startsWith('.tmp-')) continue;
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.mtimeMs < threshold) {
            await fs.promises.rm(fullPath, { force: true });
          }
        } catch {
          // Best-effort cleanup only.
        }
      }
    };

    await walk(root);
  }

  private async markStalePending() {
    const threshold = Date.now() - getSnapshotConfig().staleMinutes * 60 * 1000;
    const pending = await this.snapshotRepo.find({ where: { status: 'pending' } });
    for (const snapshot of pending) {
      if (snapshotRuntimeState.activeSnapshotIds.has(snapshot.id)) continue;
      if (new Date(snapshot.takenAt).getTime() >= threshold) continue;
      await fs.promises.rm(path.join(path.dirname(snapshot.filePath), `.tmp-${snapshot.id}.db`), { force: true }).catch(() => undefined);
      await this.snapshotRepo.update(snapshot.id, {
        status: 'failed',
        errorMessage: 'snapshot was interrupted before it completed',
      });
    }
  }

  private async assertDiskSpace(sourcePath: string, targetDirectory: string) {
    const config = getSnapshotConfig();
    let sourceSize = 0;
    try {
      sourceSize = (await fs.promises.stat(sourcePath)).size;
    } catch {
      sourceSize = 0;
    }

    const required = Math.max(sourceSize * 2, config.minFreeBytes);
    try {
      const stats = await fs.promises.statfs(targetDirectory);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(freeBytes) && freeBytes < required) {
        throw httpError(507, `not enough free disk space for snapshot: need ${required} bytes, have ${freeBytes} bytes`);
      }
    } catch (error: any) {
      if (error?.statusCode) throw error;
      // statfs may be unavailable on some platforms; do not block snapshots for that.
    }
  }
}
