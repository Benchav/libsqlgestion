import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { LessThan, Not } from 'typeorm';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import {
  DatabaseSnapshot,
  DatabaseSnapshotReason,
} from '../../domain/entities/DatabaseSnapshot';
import { decrypt, encrypt } from '../../infrastructure/crypto';
import { randomToken } from '../../infrastructure/security/tokens';
import { ensureSubdomain } from '../../infrastructure/security/slug';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';
import { resolveEffectiveDatabaseType } from '../databases/database-runtime';
import { resolveLocalDatabasePath } from '../databases/local-database-path';
import {
  fetchLibsqlDump,
  isSqlDumpFile,
  replaySqlDumpToSqlite,
  validateLibsqlDump,
} from './libsql-dump';
import { getSnapshotConfig, getSnapshotPolicy } from './snapshot-config';
import { SnapshotPolicyService, SnapshotPolicyView } from './SnapshotPolicyService';
import { getMilestones, MilestoneDue } from './snapshot-schedule';
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
  // Large libSQL dumps are returned as a pending job and completed in the
  // background; the UI polls the snapshot list until it is ready.
  background?: boolean;
};

type RestoreSnapshotInput = {
  name?: string;
  actorId?: string;
  ipAddress?: string;
};

export type SnapshotFormat = 'sqlite' | 'libsql-sql-dump';

export function getSnapshotFormat(snapshot: Pick<DatabaseSnapshot, 'fileName' | 'metadata'>): SnapshotFormat {
  const format = snapshot.metadata?.format;
  if (format === 'libsql-sql-dump' || isSqlDumpFile(snapshot.fileName)) {
    return 'libsql-sql-dump';
  }
  return 'sqlite';
}

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
  private policyService = new SnapshotPolicyService();

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
    const effectiveType = resolveEffectiveDatabaseType(database);
    return effectiveType === 'sqlite' || effectiveType === 'libsql';
  }

  async listSnapshots(databaseId: string, options: SnapshotListOptions = {}) {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
    const snapshots = await this.snapshotRepo.find({
      where: {
        databaseId,
        status: Not('deleted'),
        ...(options.before ? { takenAt: LessThan(options.before) } : {}),
      },
      order: { takenAt: 'DESC' },
      take: limit + 1,
    });

    const visible = snapshots;
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
    const [latest, latestReady, pending] = await Promise.all([
      this.snapshotRepo.findOne({ where: { databaseId }, order: { takenAt: 'DESC' } }),
      this.snapshotRepo.findOne({ where: { databaseId, status: 'ready' }, order: { takenAt: 'DESC' } }),
      this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } }),
    ]);

    return {
      latest: latest && latest.status !== 'deleted' ? latest : null,
      latestReady: latestReady || null,
      pending: Boolean(pending),
    };
  }

  async getReadySnapshots(databaseId: string) {
    return this.snapshotRepo.find({
      where: { databaseId, status: 'ready' },
      order: { takenAt: 'DESC' },
    });
  }

  async applyMilestones(snapshotId: string, due: MilestoneDue[]) {
    if (due.length === 0) return null;
    const snapshot = await this.snapshotRepo.findOne({ where: { id: snapshotId } });
    if (!snapshot) throw httpError(404, 'snapshot not found');

    const milestones = { ...(getMilestones(snapshot) as Record<string, string>) };
    for (const item of due) {
      milestones[item.type] = item.key;
    }

    snapshot.metadata = {
      ...(snapshot.metadata ?? {}),
      milestones,
    };
    return this.snapshotRepo.save(snapshot);
  }

  async createSnapshot(databaseId: string, options: CreateSnapshotOptions = {}) {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!database) throw httpError(404, 'database not found');
    if (!this.supportsDatabase(database)) {
      throw httpError(409, 'snapshots are only supported for SQLite databases and managed libSQL primaries');
    }

    const effectiveType = resolveEffectiveDatabaseType(database);
    const sourcePath = effectiveType === 'sqlite'
      ? resolveLocalDatabasePath(database, { createIfMissing: false })
      : null;
    if (effectiveType === 'sqlite' && !sourcePath) {
      throw httpError(404, 'database file not found on disk');
    }

    await this.markStalePending();

    const existing = await this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } });
    if (existing) {
      throw httpError(409, 'a snapshot is already in progress for this database');
    }

    const takenAt = new Date();
    const extension = effectiveType === 'libsql' ? 'sql' : 'db';
    const fileName = `${formatTimestamp(takenAt)}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
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

    const execute = async () => {
      snapshotRuntimeState.activeSnapshotIds.add(snapshot.id);
      const saved = await this.runExclusive(async () => {
        const tempPath = path.join(path.dirname(filePath), `.tmp-${snapshot.id}.${extension}`);
        const startedAt = Date.now();
        try {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          const artifact = effectiveType === 'libsql'
            ? await this.createLibsqlSnapshotFile(database, tempPath, filePath)
            : await this.createSqliteSnapshotFile(sourcePath as string, tempPath, filePath);

          snapshot.status = 'ready';
          snapshot.sizeBytes = artifact.sizeBytes;
          snapshot.checksumSha256 = artifact.checksumSha256;
          snapshot.errorMessage = undefined;
          snapshot.metadata = {
            ...(snapshot.metadata ?? {}),
            ...artifact.metadata,
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
                format: artifact.metadata.format,
              },
            });
          } else {
            console.log(
              `[snapshots] created ${saved.fileName} for ${database.name} (${saved.sizeBytes} bytes, ` +
              `${artifact.metadata.format})`,
            );
          }

          return saved;
        } catch (error: any) {
          const failedPaths = [
            tempPath,
            filePath,
            `${tempPath}.verify.db`,
            `${filePath}.verify.db`,
          ];
          for (const failedPath of failedPaths) {
            await fs.promises.rm(failedPath, { force: true }).catch(() => undefined);
            await fs.promises.rm(`${failedPath}-wal`, { force: true }).catch(() => undefined);
            await fs.promises.rm(`${failedPath}-shm`, { force: true }).catch(() => undefined);
          }

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
    };

    if (options.background) {
      void execute().catch((error: any) => {
        console.warn(
          `[snapshots] background snapshot failed for ${databaseId}: ${error?.message || error}`,
        );
      });
      return snapshot;
    }

    return execute();
  }

  private async createSqliteSnapshotFile(sourcePath: string, tempPath: string, filePath: string) {
    await this.assertDiskSpace(sourcePath, path.dirname(filePath));
    await this.removeFileAndSidecars(tempPath);

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

    await this.removeSidecars(tempPath);
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    await fs.promises.rename(tempPath, filePath);

    const stat = await fs.promises.stat(filePath);
    return {
      sizeBytes: stat.size,
      checksumSha256: await fileSha256(filePath),
      metadata: { format: 'sqlite' as const },
    };
  }

  private async createLibsqlSnapshotFile(database: Database, tempPath: string, filePath: string) {
    if (!database.encryptedToken) {
      throw httpError(409, 'database has no token; rotate the token before creating a snapshot');
    }

    let token: string;
    try {
      token = decrypt(database.encryptedToken);
    } catch (error: any) {
      throw httpError(500, `failed to decrypt database token: ${error?.message || error}`);
    }

    await this.assertDiskSpace(undefined, path.dirname(filePath));
    await this.removeFileAndSidecars(tempPath);

    try {
      await fetchLibsqlDump(database, token, tempPath);
      const validation = await validateLibsqlDump(tempPath);
      // The dump itself plus the reconstructed database need space. A full
      // replay verifies the backup is restorable now, not only in an emergency.
      await this.assertDiskSpace(undefined, path.dirname(filePath), validation.sizeBytes * 2);

      const verifyReplay = !['0', 'false', 'no', 'off'].includes(
        String(process.env.SNAPSHOT_LIBSQL_VERIFY_REPLAY || 'true').trim().toLowerCase(),
      );
      if (verifyReplay) {
        const verifyPath = `${tempPath}.verify.db`;
        try {
          await replaySqlDumpToSqlite(tempPath, verifyPath);
        } finally {
          await this.removeFileAndSidecars(verifyPath);
        }
      }

      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      await fs.promises.rename(tempPath, filePath);
      const stat = await fs.promises.stat(filePath);

      return {
        sizeBytes: stat.size,
        checksumSha256: await fileSha256(filePath),
        metadata: {
          format: 'libsql-sql-dump' as const,
          verified: verifyReplay,
          preserveRowIds: true,
        },
      };
    } catch (error) {
      await this.removeFileAndSidecars(tempPath);
      throw error;
    }
  }

  private async removeFileAndSidecars(filePath: string) {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    await this.removeSidecars(filePath);
  }

  private async removeSidecars(filePath: string) {
    await fs.promises.rm(`${filePath}-wal`, { force: true }).catch(() => undefined);
    await fs.promises.rm(`${filePath}-shm`, { force: true }).catch(() => undefined);
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
      throw httpError(409, 'snapshots are only supported for SQLite databases and managed libSQL primaries');
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
    const snapshotFormat = getSnapshotFormat(snapshot);

    if (snapshotFormat === 'libsql-sql-dump') {
      return this.restoreLibsqlSnapshot(sourceDatabase, snapshot, name, subdomain, input);
    }

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

  private async restoreLibsqlSnapshot(
    sourceDatabase: Database,
    snapshot: DatabaseSnapshot,
    name: string,
    subdomain: string,
    input: RestoreSnapshotInput,
  ) {
    const tempPath = path.join(
      path.dirname(snapshot.filePath),
      `.restore-${snapshot.id}-${Date.now()}.db`,
    );

    try {
      await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
      await replaySqlDumpToSqlite(snapshot.filePath, tempPath);

      // Importing through DatabaseService keeps the libSQL-first policy: the
      // restored file becomes a fresh primary (or a local file only when the
      // deployment explicitly allows that fallback).
      const { DatabaseService } = await import('../databases/DatabaseService');
      const databaseService = new DatabaseService();
      const result = await databaseService.importExistingSqlite(sourceDatabase.project.id, {
        name,
        sourceName: snapshot.fileName,
        sourcePath: tempPath,
        subdomain,
        sourceIsUpload: true,
        metadata: {
          restoredFrom: {
            databaseId: sourceDatabase.id,
            databaseName: sourceDatabase.name,
            snapshotId: snapshot.id,
            takenAt: snapshot.takenAt,
          },
          restoredAt: new Date().toISOString(),
          snapshotFormat: 'libsql-sql-dump',
        },
      });

      await this.auditService.record({
        action: 'database.snapshot.restore',
        resourceType: 'database',
        resourceId: result.database.id,
        actorId: input.actorId,
        ipAddress: input.ipAddress,
        metadata: {
          sourceDatabaseId: sourceDatabase.id,
          snapshotId: snapshot.id,
          snapshotTakenAt: snapshot.takenAt,
          targetDatabaseId: result.database.id,
          snapshotFormat: 'libsql-sql-dump',
        },
      });

      return result;
    } catch (error: any) {
      if (error?.statusCode) throw error;
      throw httpError(500, `failed to restore libSQL snapshot: ${error?.message || error}`);
    } finally {
      await this.removeFileAndSidecars(tempPath);
    }
  }

  async pruneSnapshots(databaseId: string, now = new Date(), policyOverride?: SnapshotPolicyView) {
    const config = getSnapshotConfig();
    const policy = policyOverride || await this.policyService.getPolicy(databaseId);
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

    for (const type of ['daily', 'weekly', 'monthly'] as const) {
      const enabled = type === 'daily'
        ? policy.dailyEnabled
        : type === 'weekly'
          ? policy.weeklyEnabled
          : policy.monthlyEnabled;
      if (!enabled) continue;

      const retention = type === 'daily'
        ? policy.dailyRetention
        : type === 'weekly'
          ? policy.weeklyRetention
          : policy.monthlyRetention;

      const byKey = new Map<string, string>();
      for (const snapshot of snapshots) {
        const key = getMilestones(snapshot)[type];
        if (key && !byKey.has(key)) {
          byKey.set(key, snapshot.id);
        }
      }

      let kept = 0;
      for (const snapshotId of byKey.values()) {
        if (kept >= retention) break;
        keep.add(snapshotId);
        kept += 1;
      }
    }

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
          backupPolicy: {
            dailyEnabled: policy.dailyEnabled,
            weeklyEnabled: policy.weeklyEnabled,
            monthlyEnabled: policy.monthlyEnabled,
          },
        },
      });
    }

    return { deleted };
  }

  async recoverInterruptedSnapshots() {
    const pending = await this.snapshotRepo.find({ where: { status: 'pending' } });
    for (const snapshot of pending) {
      if (snapshotRuntimeState.activeSnapshotIds.has(snapshot.id)) continue;
      for (const extension of ['db', 'sql']) {
        const tempPath = path.join(path.dirname(snapshot.filePath), `.tmp-${snapshot.id}.${extension}`);
        for (const candidate of [tempPath, `${tempPath}.verify.db`]) {
          await fs.promises.rm(candidate, { force: true }).catch(() => undefined);
          await fs.promises.rm(`${candidate}-wal`, { force: true }).catch(() => undefined);
          await fs.promises.rm(`${candidate}-shm`, { force: true }).catch(() => undefined);
        }
      }
      await fs.promises.rm(snapshot.filePath, { force: true }).catch(() => undefined);
      await fs.promises.rm(`${snapshot.filePath}-wal`, { force: true }).catch(() => undefined);
      await fs.promises.rm(`${snapshot.filePath}-shm`, { force: true }).catch(() => undefined);
      await this.snapshotRepo.update(snapshot.id, {
        status: 'failed',
        errorMessage: 'snapshot was interrupted by a backend restart',
      });
    }
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
        if (!entry.isFile() || (!entry.name.startsWith('.tmp-') && !entry.name.startsWith('.restore-'))) continue;
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
      for (const extension of ['db', 'sql']) {
        const tempPath = path.join(path.dirname(snapshot.filePath), `.tmp-${snapshot.id}.${extension}`);
        for (const candidate of [tempPath, `${tempPath}.verify.db`]) {
          await fs.promises.rm(candidate, { force: true }).catch(() => undefined);
          await fs.promises.rm(`${candidate}-wal`, { force: true }).catch(() => undefined);
          await fs.promises.rm(`${candidate}-shm`, { force: true }).catch(() => undefined);
        }
      }
      await this.snapshotRepo.update(snapshot.id, {
        status: 'failed',
        errorMessage: 'snapshot was interrupted before it completed',
      });
    }
  }

  private async assertDiskSpace(sourcePath: string | undefined, targetDirectory: string, extraRequiredBytes = 0) {
    const config = getSnapshotConfig();
    let sourceSize = 0;
    if (sourcePath) {
      try {
        sourceSize = (await fs.promises.stat(sourcePath)).size;
      } catch {
        sourceSize = 0;
      }
    }

    const required = Math.max(sourceSize * 2 + Math.max(0, extraRequiredBytes), config.minFreeBytes);
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
