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
import { resolveEffectiveDatabaseType, getRuntimeConnectionUrl } from '../databases/database-runtime';
import { resolveLocalDatabasePath } from '../databases/local-database-path';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import {
  fetchLibsqlDump,
  replaySqlDumpToSqlite,
  validateLibsqlDump,
} from './libsql-dump';
import {
  DatabaseSnapshotFileView,
  getSnapshotArtifacts,
  getSnapshotFormat,
  SnapshotArtifact,
  SnapshotArtifactKind,
  SnapshotArtifacts,
  SnapshotFormat,
} from './snapshot-artifacts';
import {
  acquireSnapshotLease as leaseSnapshot,
  beginSnapshotRemoval,
  endSnapshotRemoval,
  isSnapshotLeased,
} from './snapshot-leases';
import { getSnapshotConfig, getSnapshotPolicy, LibsqlArtifactMode } from './snapshot-config';
import { SnapshotPolicyService, SnapshotPolicyView } from './SnapshotPolicyService';
import { getMilestones, MilestoneDue } from './snapshot-schedule';
import { AuditService } from '../audit/AuditService';
import { getOffsiteBackupService } from '../offsite/OffsiteBackupService';
import {
  getOffsiteBackupSettings,
  isOffsiteConfigured,
} from '../settings/OffsiteBackupSettingsService';

export { getSnapshotArtifacts, getSnapshotFormat };
export type {
  SnapshotArtifact,
  SnapshotArtifactKind,
  SnapshotArtifacts,
  SnapshotFormat,
};

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
  // Escape hatch for operators: restore from the raw SQL dump even when a
  // materialized SQLite export is available.
  artifactFormat?: SnapshotArtifactKind;
  actorId?: string;
  ipAddress?: string;
};

type SnapshotArtifactResult = {
  sizeBytes: number;
  checksumSha256: string;
  metadata: Record<string, unknown>;
  filePath: string;
  fileName: string;
};

type SourcePragmas = {
  userVersion?: number;
  applicationId?: number;
  pageSize?: number;
  encoding?: string;
  autoVacuum?: number;
};

function normalizeSnapshotPath(value: string) {
  return path.normalize(path.resolve(value));
}

function generatedSnapshotName(value: string) {
  return /^\d{8}T\d{6}Z-[0-9a-f]{8}\.(db|sql)$/i.test(value);
}

function snapshotSiblingPath(filePath: string, extension: 'db' | 'sql') {
  return filePath.replace(/\.(db|sql)$/i, `.${extension}`);
}

function readPragmaValue(result: any, name: string) {
  const row = result?.rows?.[0];
  if (!row || typeof row !== 'object') return undefined;
  return row[name];
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  // A restore of a large database can exceed SNAPSHOT_STALE_MINUTES while it
  // replays or imports. Track the temp path so orphan cleanup never deletes a
  // file that an in-flight restore still needs.
  activeRestorePaths: new Set<string>(),
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
    // In the transitional "both" mode a snapshot owns a .sql dump and a .db
    // export. Report the real disk footprint so retention does not undercount
    // the backup volume.
    const totalSizeBytes = visible
      .filter((snapshot) => snapshot.status === 'ready')
      .reduce((total, snapshot) => total + getSnapshotArtifacts(snapshot).totalBytes, 0);

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

  acquireSnapshotLease(snapshotId: string) {
    return leaseSnapshot(snapshotId);
  }

  private async resolveArtifact(
    snapshot: DatabaseSnapshot,
    requestedFormat?: SnapshotArtifactKind,
  ) {
    const artifacts = getSnapshotArtifacts(snapshot);
    const candidates: SnapshotArtifact[] = [];

    if (requestedFormat === 'db') {
      if (!artifacts.db) {
        throw httpError(
          409,
          'this snapshot stores only the raw SQL dump; restore it to materialize a SQLite file or download the .sql artifact',
        );
      }
      candidates.push(artifacts.db);
    } else if (requestedFormat === 'sql') {
      if (!artifacts.dump) {
        throw httpError(409, 'the raw SQL dump was not retained for this snapshot');
      }
      candidates.push(artifacts.dump);
    } else {
      candidates.push(artifacts.preferred);
      for (const artifact of artifacts.downloadFormats.length > 1
        ? [artifacts.primary, artifacts.dump, artifacts.preferred]
        : [artifacts.primary]) {
        if (artifact && !candidates.some((candidate) => candidate.kind === artifact.kind)) {
          candidates.push(artifact);
        }
      }
    }

    for (const artifact of candidates) {
      try {
        const stat = await fs.promises.stat(artifact.path);
        if (stat.isFile()) {
          return { ...artifact, sizeBytes: stat.size };
        }
      } catch {
        // Try the next usable artifact in default mode.
      }
    }

    if (requestedFormat) {
      throw httpError(404, `snapshot ${requestedFormat} file not found on disk`);
    }
    throw httpError(404, 'snapshot file not found on disk');
  }

  async resolveSnapshotDownload(
    databaseId: string,
    snapshotId: string,
    requestedFormat?: SnapshotArtifactKind,
  ) {
    const snapshot = await this.getSnapshot(databaseId, snapshotId);
    if (snapshot.status !== 'ready') {
      throw httpError(409, 'snapshot is not ready');
    }
    const artifact = await this.resolveArtifact(snapshot, requestedFormat);
    return { snapshot, artifact };
  }

  async getSchedulerState(databaseId: string) {
    const [latest, latestReady, pending] = await Promise.all([
      // A recently deleted snapshot is newer than every valid row but must not
      // hide the real latest state from the scheduler/API.
      this.snapshotRepo.findOne({
        where: { databaseId, status: Not('deleted') },
        order: { takenAt: 'DESC' },
      }),
      this.snapshotRepo.findOne({ where: { databaseId, status: 'ready' }, order: { takenAt: 'DESC' } }),
      this.snapshotRepo.findOne({ where: { databaseId, status: 'pending' } }),
    ]);

    return {
      latest: latest || null,
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

    // Update only the milestones key so a concurrent offsite upload cannot
    // overwrite the tag (and vice versa).
    try {
      await this.snapshotRepo.createQueryBuilder()
        .update(DatabaseSnapshot)
        .set({
          metadata: () => `json_set(coalesce(metadata, '{}'), '$.milestones', json(:milestones))`,
        })
        .setParameter('milestones', JSON.stringify(milestones))
        .where('id = :id', { id: snapshotId })
        .execute();
    } catch {
      snapshot.metadata = {
        ...(snapshot.metadata ?? {}),
        milestones,
      };
      await this.snapshotRepo.save(snapshot);
    }

    const saved = await this.snapshotRepo.findOneBy({ id: snapshotId });
    if (!saved) throw httpError(404, 'snapshot not found');
    void getOffsiteBackupService().enqueue(saved.id).catch((error: any) => {
      console.warn(
        `[offsite] could not enqueue milestone snapshot ${saved.id}: ${error?.message || error}`,
      );
    });
    return saved;
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
    const config = getSnapshotConfig();
    const libsqlArtifactMode = config.libsqlArtifactMode;
    const extension = effectiveType === 'libsql' && libsqlArtifactMode !== 'sqlite' ? 'sql' : 'db';
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
            ? await this.createLibsqlSnapshotFile(database, {
              mode: libsqlArtifactMode,
              snapshotId: snapshot.id,
              primaryPath: filePath,
            })
            : await this.createSqliteSnapshotFile(sourcePath as string, tempPath, filePath);

          snapshot.status = 'ready';
          snapshot.filePath = artifact.filePath;
          snapshot.fileName = artifact.fileName;
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

          // Offsite upload is deliberately detached from snapshot creation. A
          // missing S3 configuration or an R2 outage must never turn a valid
          // local backup into a failed snapshot.
          void getOffsiteBackupService().enqueue(saved.id).catch((error: any) => {
            console.warn(
              `[offsite] could not enqueue snapshot ${saved.id}: ${error?.message || error}`,
            );
          });

          return saved;
        } catch (error: any) {
          await this.cleanupFailedSnapshotCreation(snapshot.id, filePath);

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

  private async createSqliteSnapshotFile(
    sourcePath: string,
    tempPath: string,
    filePath: string,
  ): Promise<SnapshotArtifactResult> {
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
      metadata: { format: 'sqlite' },
      filePath,
      fileName: path.basename(filePath),
    };
  }

  private async createLibsqlSnapshotFile(
    database: Database,
    options: { mode: LibsqlArtifactMode; snapshotId: string; primaryPath: string },
  ): Promise<SnapshotArtifactResult> {
    const { mode, snapshotId, primaryPath } = options;
    const directory = path.dirname(primaryPath);
    const tempDumpPath = path.join(directory, `.tmp-${snapshotId}.sql`);
    const tempDbPath = path.join(directory, `.tmp-${snapshotId}.db`);
    const finalDumpPath = mode === 'sqlite' ? null : primaryPath;
    const finalDbPath = mode === 'sqlite'
      ? primaryPath
      : mode === 'both'
        ? snapshotSiblingPath(primaryPath, 'db')
        : primaryPath;

    if (mode === 'both' && finalDbPath === primaryPath) {
      throw httpError(500, 'internal snapshot error: SQLite export requires a .sql primary path');
    }

    if (!database.encryptedToken) {
      throw httpError(409, 'database has no token; rotate the token before creating a snapshot');
    }

    let token: string;
    try {
      token = decrypt(database.encryptedToken);
    } catch (error: any) {
      throw httpError(500, `failed to decrypt database token: ${error?.message || error}`);
    }

    await this.assertDiskSpace(undefined, directory);
    await this.removeFileAndSidecars(tempDumpPath);
    await this.removeFileAndSidecars(tempDbPath);
    if (mode !== 'dump') {
      await this.removeFileAndSidecars(finalDbPath);
    }
    if (finalDumpPath) {
      await this.removeFileAndSidecars(finalDumpPath);
    }

    try {
      await fetchLibsqlDump(database, token, tempDumpPath);
      const validation = await validateLibsqlDump(tempDumpPath);
      // The dump itself plus the reconstructed database need space. A full
      // replay verifies the backup is restorable now, not only in an emergency.
      await this.assertDiskSpace(undefined, directory, validation.sizeBytes * 2);

      const config = getSnapshotConfig();
      const verifyReplay = config.verifyReplay;

      if (mode === 'dump') {
        if (verifyReplay) {
          try {
            await replaySqlDumpToSqlite(tempDumpPath, tempDbPath);
          } finally {
            await this.removeFileAndSidecars(tempDbPath);
          }
        }

        await this.finalizeDump(tempDumpPath, primaryPath);
        const stat = await fs.promises.stat(primaryPath);
        return {
          sizeBytes: stat.size,
          checksumSha256: await fileSha256(primaryPath),
          metadata: {
            format: 'libsql-sql-dump',
            verified: verifyReplay,
            preserveRowIds: true,
          },
          filePath: primaryPath,
          fileName: path.basename(primaryPath),
        };
      }

      // Materializing the .db is mandatory in both/sqlite modes: the replay is
      // what produces the downloadable SQLite file and verifies it now.
      const sourcePragmas = await this.captureLibsqlSourcePragmas(database, token);
      try {
        await replaySqlDumpToSqlite(tempDumpPath, tempDbPath, sourcePragmas);
      } catch (error: any) {
        await this.removeFileAndSidecars(tempDbPath);
        // A structurally valid dump is still a backup. Never lose it because
        // the SQLite materialization failed; expose the fallback as a warning.
        const fallbackPath = finalDumpPath || snapshotSiblingPath(primaryPath, 'sql');
        await this.finalizeDump(tempDumpPath, fallbackPath);
        const stat = await fs.promises.stat(fallbackPath);
        const warning = (
          'SQLite export could not be materialized; the replay-validated SQL dump was kept instead. '
          + String(error?.message || error)
        ).slice(0, 800);
        console.warn(
          `[snapshots] SQLite export failed for ${database.id}; keeping SQL dump: ${error?.message || error}`,
        );
        return {
          sizeBytes: stat.size,
          checksumSha256: await fileSha256(fallbackPath),
          metadata: {
            format: 'libsql-sql-dump',
            verified: false,
            preserveRowIds: true,
            warning,
            sourcePragmas,
          },
          filePath: fallbackPath,
          fileName: path.basename(fallbackPath),
        };
      }

      await this.removeSidecars(tempDbPath);
      await fs.promises.rename(tempDbPath, finalDbPath);
      await this.removeSidecars(finalDbPath);

      let dumpStat: fs.Stats | undefined;
      let dumpChecksum: string | undefined;
      if (finalDumpPath) {
        await this.finalizeDump(tempDumpPath, finalDumpPath);
        dumpStat = await fs.promises.stat(finalDumpPath);
        dumpChecksum = await fileSha256(finalDumpPath);
      } else {
        await this.removeFileAndSidecars(tempDumpPath);
      }

      const dbStat = await fs.promises.stat(finalDbPath);
      const dbChecksum = await fileSha256(finalDbPath);
      const actualPrimaryPath = finalDumpPath || finalDbPath;
      const metadata: Record<string, unknown> = {
        format: 'libsql-sqlite-export',
        verified: true,
        preserveRowIds: true,
        sqliteFileName: path.basename(finalDbPath),
        sqliteSizeBytes: dbStat.size,
        sqliteChecksumSha256: dbChecksum,
        totalBytes: dbStat.size + (dumpStat?.size || 0),
      };
      if (dumpStat && dumpChecksum && finalDumpPath) {
        metadata.dumpFileName = path.basename(finalDumpPath);
        metadata.dumpSizeBytes = dumpStat.size;
        metadata.dumpChecksumSha256 = dumpChecksum;
      }
      if (Object.keys(sourcePragmas).length > 0) {
        metadata.sourcePragmas = sourcePragmas;
      }

      return {
        sizeBytes: dumpStat ? dumpStat.size : dbStat.size,
        checksumSha256: dumpChecksum || dbChecksum,
        metadata,
        filePath: actualPrimaryPath,
        fileName: path.basename(actualPrimaryPath),
      };
    } catch (error) {
      await this.removeFileAndSidecars(tempDumpPath);
      await this.removeFileAndSidecars(tempDbPath);
      throw error;
    }
  }

  private async finalizeDump(tempPath: string, finalPath: string) {
    await this.removeFileAndSidecars(finalPath);
    await this.removeSidecars(tempPath);
    await fs.promises.rename(tempPath, finalPath);
    await this.removeSidecars(finalPath);
  }

  private async cleanupFailedSnapshotCreation(snapshotId: string, primaryPath: string) {
    const directory = path.dirname(primaryPath);
    const tempBase = path.join(directory, `.tmp-${snapshotId}`);
    const sibling = snapshotSiblingPath(
      primaryPath,
      primaryPath.toLowerCase().endsWith('.sql') ? 'db' : 'sql',
    );
    const candidates = new Set([
      `${tempBase}.sql`,
      `${tempBase}.db`,
      `${tempBase}.sql.verify.db`,
      `${tempBase}.db.verify.db`,
      primaryPath,
      sibling,
    ]);

    for (const candidate of candidates) {
      await this.removeFileAndSidecars(candidate);
    }
  }

  /**
   * Reads file-level settings from the live primary. A logical dump cannot carry
   * them, so they are reapplied while the materialized database is still empty.
   * This is best-effort: a failure must not block the backup.
   */
  private async captureLibsqlSourcePragmas(database: Database, token: string): Promise<SourcePragmas> {
    const connectionUrl = getRuntimeConnectionUrl(database);
    if (!connectionUrl) return {};

    const client = createLibsqlClient(connectionUrl, token);
    let timer: NodeJS.Timeout | undefined;
    try {
      const query = client.batch([
        { sql: 'PRAGMA user_version;' },
        { sql: 'PRAGMA application_id;' },
        { sql: 'PRAGMA page_size;' },
        { sql: 'PRAGMA encoding;' },
        { sql: 'PRAGMA auto_vacuum;' },
      ], 'read');
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 10_000);
        timer.unref?.();
      });
      const results = await Promise.race([query, timeout]);
      if (!results) {
        query.catch(() => undefined);
        return {};
      }

      const encoding = readPragmaValue(results[3], 'encoding');
      const pragmas: SourcePragmas = {
        userVersion: finiteNumber(readPragmaValue(results[0], 'user_version')),
        applicationId: finiteNumber(readPragmaValue(results[1], 'application_id')),
        pageSize: finiteNumber(readPragmaValue(results[2], 'page_size')),
        encoding: typeof encoding === 'string' ? encoding : undefined,
        autoVacuum: finiteNumber(readPragmaValue(results[4], 'auto_vacuum')),
      };

      return Object.fromEntries(
        Object.entries(pragmas).filter(([, value]) => value !== undefined),
      ) as SourcePragmas;
    } catch (error: any) {
      console.warn(
        `[snapshots] could not read source pragmas for ${database.id}: ${error?.message || error}`,
      );
      return {};
    } finally {
      if (timer) clearTimeout(timer);
      try {
        client.close();
      } catch {
        // Best effort.
      }
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

  private artifactPaths(snapshot: DatabaseSnapshotFileView) {
    const artifacts = getSnapshotArtifacts(snapshot);
    const paths = new Set<string>();
    for (const artifact of [artifacts.primary, artifacts.db, artifacts.dump]) {
      if (artifact) paths.add(artifact.path);
    }
    return [...paths];
  }

  private async removeSnapshotArtifacts(snapshot: DatabaseSnapshotFileView) {
    for (const artifactPath of this.artifactPaths(snapshot)) {
      await fs.promises.rm(artifactPath, { force: true });
      await fs.promises.rm(`${artifactPath}-wal`, { force: true });
      await fs.promises.rm(`${artifactPath}-shm`, { force: true });
    }
  }

  async deleteSnapshot(databaseId: string, snapshotId: string, actorId?: string, ipAddress?: string) {
    const snapshot = await this.getSnapshot(databaseId, snapshotId);
    if (snapshot.status === 'pending' || snapshotRuntimeState.activeSnapshotIds.has(snapshot.id)) {
      throw httpError(409, 'snapshot is still being created');
    }
    if (!beginSnapshotRemoval(snapshot.id)) {
      throw httpError(
        409,
        isSnapshotLeased(snapshot.id)
          ? 'snapshot is in use by a running restore or download'
          : 'snapshot is already being deleted',
      );
    }

    try {
      try {
        await this.removeSnapshotArtifacts(snapshot);
      } catch (error: any) {
        // Keep the row so the operator can retry; never report a deletion while
        // any backup artifact may still be on disk.
        throw httpError(500, `failed to delete snapshot files: ${error?.message || error}`);
      }

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
        metadata: {
          snapshotId,
          reason: snapshot.reason,
          takenAt: snapshot.takenAt,
          artifacts: this.artifactPaths(snapshot).map((artifactPath) => path.basename(artifactPath)),
        },
      });

      return { ok: true };
    } finally {
      endSnapshotRemoval(snapshot.id);
    }
  }

  async restoreSnapshot(databaseId: string, snapshotId: string, input: RestoreSnapshotInput = {}) {
    const sourceDatabase = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!sourceDatabase) throw httpError(404, 'database not found');
    if (!this.supportsDatabase(sourceDatabase)) {
      throw httpError(409, 'snapshots are only supported for SQLite databases and managed libSQL primaries');
    }

    // Lease before reading the row so retention cannot unlink the artifact
    // between the status check and the restore itself.
    const releaseLease = leaseSnapshot(snapshotId);
    try {
      const snapshot = await this.getSnapshot(databaseId, snapshotId);
      if (snapshot.status !== 'ready') {
        throw httpError(409, 'snapshot is not ready to restore');
      }

      const artifact = await this.resolveArtifact(snapshot, input.artifactFormat);
      const config = getSnapshotConfig();
      if (config.verifyOnRestore && artifact.checksumSha256) {
        const actual = await fileSha256(artifact.path);
        if (actual !== artifact.checksumSha256) {
          throw httpError(409, `snapshot ${artifact.kind.toUpperCase()} checksum verification failed`);
        }
      }

      // A restore creates a full second copy (plus WAL during provisioning).
      await this.assertDiskSpace(undefined, path.dirname(artifact.path), (artifact.sizeBytes || 0) * 2);

      const timestamp = formatTimestamp(new Date());
      const name = String(input.name || '').trim() || `${sourceDatabase.name}-restore-${timestamp}`;
      if (name.length > 512) {
        throw httpError(422, 'restore database name is too long');
      }

      const subdomain = ensureSubdomain(name, randomToken());
      const effectiveType = resolveEffectiveDatabaseType(sourceDatabase);

      if (effectiveType === 'libsql') {
        return await this.restoreLibsqlSnapshot(
          sourceDatabase,
          snapshot,
          artifact,
          name,
          subdomain,
          input,
        );
      }

      if (artifact.kind !== 'db') {
        throw httpError(
          409,
          'this snapshot contains only a SQL dump; restore it into a libSQL primary or choose a SQLite artifact',
        );
      }

      return await this.restoreSqliteSnapshot(
        sourceDatabase,
        snapshot,
        artifact,
        name,
        subdomain,
        input,
      );
    } finally {
      releaseLease();
    }
  }

  private async restoreSqliteSnapshot(
    sourceDatabase: Database,
    snapshot: DatabaseSnapshot,
    artifact: SnapshotArtifact,
    name: string,
    subdomain: string,
    input: RestoreSnapshotInput,
  ) {
    const token = randomToken();
    const snapshotFormat = getSnapshotFormat(snapshot);

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
        artifact.path,
        sourceDatabase.project.id,
        database.id,
      );

      const client = new SqliteClient(managedPath);
      try {
        const integrity = await client.checkIntegrity();
        if (!integrity.ok) {
          throw httpError(409, `restored database integrity check failed: ${integrity.details}`);
        }
        await client.exec('PRAGMA journal_mode = WAL;');
      } finally {
        await client.close();
      }

      database.url = managedPath;
      database.status = 'active';
      database.encryptedToken = encrypt(token);
      database.metadata = {
        ...(database.metadata ?? {}),
        snapshotFormat,
        snapshotArtifact: artifact.kind,
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
          snapshotFormat,
          snapshotArtifact: artifact.kind,
        },
      });

      return { database, token };
    } catch (error: any) {
      if (managedPath) {
        await this.removeFileAndSidecars(managedPath);
      }
      await this.databaseRepo.remove(database).catch(() => undefined);
      if (error?.statusCode) throw error;
      throw httpError(500, `failed to restore snapshot: ${error?.message || error}`);
    }
  }

  private async restoreLibsqlSnapshot(
    sourceDatabase: Database,
    snapshot: DatabaseSnapshot,
    artifact: SnapshotArtifact,
    name: string,
    subdomain: string,
    input: RestoreSnapshotInput,
  ) {
    const tempPath = path.join(
      path.dirname(artifact.path),
      `.restore-${snapshot.id}-${Date.now()}.db`,
    );
    const snapshotFormat = artifact.kind === 'db'
      ? 'libsql-sqlite-export'
      : 'libsql-sql-dump';

    snapshotRuntimeState.activeRestorePaths.add(normalizeSnapshotPath(tempPath));
    try {
      await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
      if (artifact.kind === 'sql') {
        await replaySqlDumpToSqlite(
          artifact.path,
          tempPath,
          this.sourcePragmaOptions(snapshot),
        );
      } else {
        // Never let the importer move or mutate the durable snapshot: work on a
        // private copy and verify it before provisioning the new primary.
        await fs.promises.copyFile(artifact.path, tempPath);
        const verification = new SqliteClient(tempPath);
        try {
          const integrity = await verification.checkIntegrity();
          if (!integrity.ok) {
            throw httpError(409, `snapshot SQLite integrity check failed: ${integrity.details}`);
          }
        } finally {
          await verification.close();
        }
        await this.removeSidecars(tempPath);
      }

      // Importing through DatabaseService keeps the libSQL-first policy: the
      // restored file becomes a fresh primary (or a local file only when the
      // deployment explicitly allows that fallback).
      const { DatabaseService } = await import('../databases/DatabaseService');
      const databaseService = new DatabaseService();
      const result = await databaseService.importExistingSqlite(sourceDatabase.project.id, {
        name,
        sourceName: artifact.fileName,
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
          snapshotFormat,
          snapshotArtifact: artifact.kind,
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
          snapshotFormat,
          snapshotArtifact: artifact.kind,
        },
      });

      return result;
    } catch (error: any) {
      if (error?.statusCode) throw error;
      throw httpError(500, `failed to restore libSQL snapshot: ${error?.message || error}`);
    } finally {
      snapshotRuntimeState.activeRestorePaths.delete(normalizeSnapshotPath(tempPath));
      await this.removeFileAndSidecars(tempPath);
    }
  }

  private sourcePragmaOptions(snapshot: DatabaseSnapshot): SourcePragmas {
    const raw = snapshot.metadata?.sourcePragmas;
    if (!raw || typeof raw !== 'object') return {};
    const value = raw as Record<string, unknown>;
    const options: SourcePragmas = {
      userVersion: finiteNumber(value.userVersion),
      applicationId: finiteNumber(value.applicationId),
      pageSize: finiteNumber(value.pageSize),
      encoding: typeof value.encoding === 'string' ? value.encoding : undefined,
      autoVacuum: finiteNumber(value.autoVacuum),
    };
    return Object.fromEntries(
      Object.entries(options).filter(([, entry]) => entry !== undefined),
    ) as SourcePragmas;
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

    const offsiteConfigured = isOffsiteConfigured();
    const offsiteSettings = getOffsiteBackupSettings();
    let deleted = 0;
    for (const snapshot of snapshots) {
      if (keep.has(snapshot.id)) continue;
      const offsite = snapshot.metadata?.offsite as { status?: string } | undefined;
      // Do not unlink the local source while an offsite upload is queued or in
      // progress. With the explicit `required` policy, also keep failed
      // snapshots until the operator fixes the bucket; otherwise failed
      // uploads follow normal retention with a visible error.
      if (offsiteConfigured && (
        offsite?.status === 'pending'
        || offsite?.status === 'uploading'
        || (offsiteSettings.required && offsite?.status !== 'uploaded')
      )) {
        continue;
      }
      if (!beginSnapshotRemoval(snapshot.id)) continue;
      try {
        try {
          await this.removeSnapshotArtifacts(snapshot);
        } catch {
          // Keep the row so the next pruning pass can retry the file removal.
          continue;
        }
        await this.snapshotRepo.update(snapshot.id, {
          status: 'deleted',
          expiresAt: now,
        });
        deleted += 1;
      } finally {
        endSnapshotRemoval(snapshot.id);
      }
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

  private async cleanupInterruptedSnapshot(snapshot: DatabaseSnapshot) {
    const directory = path.dirname(snapshot.filePath);
    for (const extension of ['db', 'sql']) {
      const tempPath = path.join(directory, `.tmp-${snapshot.id}.${extension}`);
      await this.removeFileAndSidecars(tempPath);
      await this.removeFileAndSidecars(`${tempPath}.verify.db`);
    }

    // A crash can leave the finalized primary and its sibling (.db/.sql)
    // before the row metadata is saved. Remove both candidates.
    const basePath = snapshot.filePath.replace(/\.(db|sql)$/i, '');
    for (const candidate of new Set([snapshot.filePath, `${basePath}.db`, `${basePath}.sql`])) {
      await this.removeFileAndSidecars(candidate);
    }
  }

  async recoverInterruptedSnapshots() {
    const pending = await this.snapshotRepo.find({ where: { status: 'pending' } });
    for (const snapshot of pending) {
      if (snapshotRuntimeState.activeSnapshotIds.has(snapshot.id)) continue;
      await this.cleanupInterruptedSnapshot(snapshot);
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

    // Only remove final artifacts that are not referenced by a live snapshot
    // row. The generated timestamp/UUID pattern avoids touching operator files
    // that happen to live under the snapshot root.
    const rows = await this.snapshotRepo.find({ where: { status: Not('deleted') } });
    const referenced = new Set<string>();
    for (const snapshot of rows) {
      for (const artifactPath of this.artifactPaths(snapshot)) {
        referenced.add(normalizeSnapshotPath(artifactPath));
      }
      if (snapshot.status === 'pending') {
        const basePath = snapshot.filePath.replace(/\.(db|sql)$/i, '');
        referenced.add(normalizeSnapshotPath(`${basePath}.db`));
        referenced.add(normalizeSnapshotPath(`${basePath}.sql`));
      }
    }

    const isStale = async (filePath: string) => {
      try {
        const stat = await fs.promises.stat(filePath);
        return stat.mtimeMs < threshold;
      } catch {
        return false;
      }
    };

    const isActiveManagedPath = (filePath: string) => {
      const normalized = normalizeSnapshotPath(filePath);
      if (snapshotRuntimeState.activeRestorePaths.has(normalized)) return true;
      const name = path.basename(filePath);
      for (const snapshotId of snapshotRuntimeState.activeSnapshotIds) {
        if (name.startsWith(`.tmp-${snapshotId}.`)) return true;
      }
      return false;
    };

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
        if (!entry.isFile()) continue;

        const sidecar = /^(.*)-(wal|shm)$/i.exec(entry.name);
        if (sidecar) {
          const baseName = sidecar[1];
          const basePath = path.join(directory, baseName);
          const managedName = generatedSnapshotName(baseName)
            || baseName.startsWith('.tmp-')
            || baseName.startsWith('.restore-');
          if (managedName
            && !isActiveManagedPath(basePath)
            && !referenced.has(normalizeSnapshotPath(basePath))
            && await isStale(fullPath)) {
            await fs.promises.rm(fullPath, { force: true }).catch(() => undefined);
          }
          continue;
        }

        const isInterrupted = entry.name.startsWith('.tmp-')
          || entry.name.startsWith('.restore-')
          || entry.name.endsWith('.verify.db');
        if (isInterrupted) {
          if (!isActiveManagedPath(fullPath) && await isStale(fullPath)) {
            await fs.promises.rm(fullPath, { force: true }).catch(() => undefined);
          }
          continue;
        }

        if (generatedSnapshotName(entry.name)
          && !referenced.has(normalizeSnapshotPath(fullPath))
          && await isStale(fullPath)) {
          await fs.promises.rm(fullPath, { force: true }).catch(() => undefined);
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
      await this.cleanupInterruptedSnapshot(snapshot);
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
