import crypto from 'crypto';
import fs from 'fs';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { DatabaseSnapshot } from '../../domain/entities/DatabaseSnapshot';
import { AuditService } from '../audit/AuditService';
import {
  getSnapshotArtifacts,
  getSnapshotFormat,
  SnapshotArtifact,
} from '../snapshots/snapshot-artifacts';
import { acquireSnapshotLease } from '../snapshots/snapshot-leases';
import { getMilestones } from '../snapshots/snapshot-schedule';
import {
  OffsiteBackupInternalSettings,
  getOffsiteBackupInternalSettings,
  getOffsiteBackupSettings,
  isOffsiteConfigured,
  isOffsiteReady,
  recordOffsiteError,
  recordOffsiteTestResult,
  recordOffsiteUploadSuccess,
  reloadOffsiteBackupSettings,
} from '../settings/OffsiteBackupSettingsService';
import {
  createS3OffsiteStore,
  describeOffsiteError,
  OffsiteStore,
} from './S3OffsiteStore';
import {
  offsiteArtifactKey,
  offsiteContentType,
  offsiteManifestKey,
  offsiteSnapshotPrefix,
} from './offsite-object-key';

export type OffsiteStatus = 'disabled' | 'pending' | 'uploading' | 'uploaded' | 'failed';

export type OffsiteArtifactRecord = {
  kind: 'db' | 'sql';
  fileName: string;
  objectKey: string;
  sizeBytes: number;
  checksumSha256: string;
};

export type OffsiteSnapshotState = {
  status: OffsiteStatus;
  provider: 's3';
  bucket: string;
  prefix: string;
  artifactKind: 'db' | 'sql';
  fileName: string;
  objectKey: string;
  manifestKey: string;
  sizeBytes: number;
  checksumSha256: string;
  artifacts: OffsiteArtifactRecord[];
  uploadedAt?: string;
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
};

type OffsiteManifest = {
  schemaVersion: 1;
  snapshotId: string;
  databaseId: string;
  projectId: string;
  takenAt: string;
  reason: string;
  pinned: boolean;
  format: string;
  artifacts: Array<{
    kind: 'db' | 'sql';
    fileName: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
  }>;
  appVersion?: string;
  createdAt: string;
};

type OffsiteStoreFactory = (settings: OffsiteBackupInternalSettings) => OffsiteStore;
type EnqueueOptions = { force?: boolean; manual?: boolean; resume?: boolean };

const MAX_ATTEMPTS = 10;
const RETRY_DELAYS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
const RETENTION_CHECK_MS = 24 * 60 * 60 * 1000;

function sha256File(filePath: string) {
  const hash = crypto.createHash('sha256');
  return new Promise<string>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readOffsite(snapshot: DatabaseSnapshot): OffsiteSnapshotState | undefined {
  const value = snapshot.metadata?.offsite;
  if (!value || typeof value !== 'object') return undefined;
  return value as OffsiteSnapshotState;
}

function retryDelay(attempts: number) {
  return RETRY_DELAYS_MS[Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, attempts - 1))];
}

function selectedArtifacts(snapshot: DatabaseSnapshot, mode: 'db' | 'db+sql') {
  const artifacts = getSnapshotArtifacts(snapshot);
  const selected: SnapshotArtifact[] = [artifacts.preferred];
  if (mode === 'db+sql' && artifacts.dump && artifacts.dump.kind !== artifacts.preferred.kind) {
    selected.push(artifacts.dump);
  }
  return selected.filter((artifact, index, all) => (
    artifact
    && all.findIndex((candidate) => candidate.kind === artifact.kind && candidate.path === artifact.path) === index
  ));
}

function shouldUploadForMode(snapshot: DatabaseSnapshot, mode: string, manual: boolean) {
  if (manual) return true;
  if (mode === 'manual') return false;
  if (mode === 'all') return true;
  if (snapshot.pinned || snapshot.reason === 'manual') return true;
  return Boolean(getMilestones(snapshot).daily);
}

export class OffsiteBackupService {
  private snapshotRepo = AppDataSource.getRepository(DatabaseSnapshot);
  private auditService = new AuditService();
  private queue: string[] = [];
  private queued = new Set<string>();
  private processing = false;
  private currentSnapshotId: string | null = null;
  private currentJob: Promise<void> | null = null;
  private stopped = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private settingsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly storeFactory: OffsiteStoreFactory = createS3OffsiteStore) {}

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.resumePending().catch((error: any) => {
      console.warn('[offsite] could not resume pending uploads:', error?.message || error);
    });
    this.scheduleRetry();
    this.scheduleRetention();
    // Keep multiple backend processes in sync when settings are changed from
    // another replica. A single-instance deployment simply reloads the cache.
    this.settingsTimer = setInterval(() => {
      void reloadOffsiteBackupSettings().catch((error: any) => {
        console.warn('[offsite] could not reload settings:', error?.message || error);
      });
    }, 60_000);
    this.settingsTimer.unref?.();
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.retryTimer = null;
    this.retentionTimer = null;
    this.settingsTimer = null;
    if (this.currentJob) {
      await Promise.race([
        this.currentJob,
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    }
  }

  async testConnection(settingsOverride?: OffsiteBackupInternalSettings) {
    const settings = settingsOverride || getOffsiteBackupInternalSettings();
    if (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
      throw new Error('offsite configuration is incomplete');
    }
    const startedAt = Date.now();
    try {
      const result = await this.storeFactory(settings).testConnection();
      await recordOffsiteTestResult(true);
      return {
        ok: true,
        latencyMs: result.latencyMs,
        bucket: settings.bucket,
        endpoint: settings.endpoint,
        message: `Connected to ${settings.bucket} in ${result.latencyMs}ms.`,
      };
    } catch (error: any) {
      const detail = describeOffsiteError(error);
      await recordOffsiteTestResult(false, detail);
      const wrapped: any = new Error(detail);
      wrapped.statusCode = 502;
      wrapped.cause = error;
      throw wrapped;
    } finally {
      if (Date.now() - startedAt > 30_000) {
        console.warn('[offsite] connection test took longer than 30s');
      }
    }
  }

  async enqueue(snapshotId: string, options: EnqueueOptions = {}) {
    const settings = getOffsiteBackupInternalSettings();
    if (!isOffsiteConfigured(settings)) {
      return { queued: false, reason: 'disabled' as const };
    }

    const snapshot = await this.snapshotRepo.findOneBy({ id: snapshotId });
    if (!snapshot || snapshot.status !== 'ready') {
      return { queued: false, reason: 'not-ready' as const };
    }
    if (!shouldUploadForMode(snapshot, settings.uploadMode, Boolean(options.manual || options.force))) {
      return { queued: false, reason: 'mode' as const };
    }

    const existing = readOffsite(snapshot);
    if (existing?.status === 'uploaded' && !options.force) {
      return { queued: false, reason: 'already-uploaded' as const };
    }
    if (this.queued.has(snapshotId) || this.currentSnapshotId === snapshotId) {
      return { queued: false, reason: 'already-queued' as const };
    }
    if (existing?.nextRetryAt && !options.force && !options.resume) {
      const retryAt = new Date(existing.nextRetryAt).getTime();
      if (Number.isFinite(retryAt) && retryAt > Date.now()) {
        return { queued: false, reason: 'retry-later' as const };
      }
    }

    const artifacts = selectedArtifacts(snapshot, settings.artifacts);
    const preferred = artifacts[0];
    if (!preferred) {
      return { queued: false, reason: 'no-artifact' as const };
    }
    const prefix = settings.prefix;
    const snapshotPrefix = offsiteSnapshotPrefix({
      prefix,
      projectId: snapshot.projectId,
      databaseId: snapshot.databaseId,
      snapshotId: snapshot.id,
    });
    const manifestKey = offsiteManifestKey(snapshotPrefix);
    const objectKey = offsiteArtifactKey(snapshotPrefix, preferred.fileName);

    const state: OffsiteSnapshotState = {
      status: 'pending',
      provider: 's3',
      bucket: settings.bucket,
      prefix,
      artifactKind: preferred.kind,
      fileName: preferred.fileName,
      objectKey,
      manifestKey,
      sizeBytes: preferred.sizeBytes || 0,
      checksumSha256: preferred.checksumSha256 || '',
      artifacts: artifacts.map((artifact) => ({
        kind: artifact.kind,
        fileName: artifact.fileName,
        objectKey: offsiteArtifactKey(snapshotPrefix, artifact.fileName),
        sizeBytes: artifact.sizeBytes || 0,
        checksumSha256: artifact.checksumSha256 || '',
      })),
      attempts: options.force ? 0 : (existing?.attempts || 0),
      lastError: undefined,
      nextRetryAt: undefined,
    };
    await this.saveOffsiteState(snapshot.id, state);
    this.queued.add(snapshotId);
    this.queue.push(snapshotId);
    this.kick();
    return { queued: true };
  }

  async syncPending(options: { includeExisting?: boolean; limit?: number; snapshotId?: string } = {}) {
    if (options.snapshotId) {
      return this.enqueue(options.snapshotId, { force: true, manual: true });
    }
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 25)));
    const snapshots = await this.snapshotRepo.find({
      where: { status: 'ready' },
      order: { takenAt: 'DESC' },
    });
    let queued = 0;
    for (const snapshot of snapshots) {
      if (queued >= limit) break;
      const state = readOffsite(snapshot);
      if (state?.status === 'uploaded') continue;
      if (!options.includeExisting && !state) continue;
      const result = await this.enqueue(snapshot.id, { force: true, manual: true });
      if (result.queued) queued += 1;
    }
    return { queued };
  }

  async resumePending() {
    if (!isOffsiteConfigured()) return { queued: 0 };
    const snapshots = await this.snapshotRepo.find({ where: { status: 'ready' } });
    let queued = 0;
    for (const snapshot of snapshots) {
      const state = readOffsite(snapshot);
      if (!state || state.status === 'uploaded' || state.status === 'disabled') continue;
      if (state.attempts >= MAX_ATTEMPTS) continue;
      if (state.nextRetryAt && new Date(state.nextRetryAt).getTime() > Date.now()) continue;
      const result = await this.enqueue(snapshot.id, { resume: true, manual: true });
      if (result.queued) queued += 1;
    }
    if (queued > 0) console.log(`[offsite] resumed ${queued} pending upload(s)`);
    return { queued };
  }

  async getStatus() {
    const snapshots = await this.snapshotRepo.find({ where: { status: 'ready' } });
    let pendingUploads = 0;
    let failedUploads = 0;
    let uploaded = 0;
    for (const snapshot of snapshots) {
      const state = readOffsite(snapshot);
      if (!state) continue;
      if (state.status === 'pending' || state.status === 'uploading') pendingUploads += 1;
      else if (state.status === 'failed') failedUploads += 1;
      else if (state.status === 'uploaded') uploaded += 1;
    }
    const settings = getOffsiteBackupSettings();
    return {
      configured: isOffsiteReady(),
      pendingUploads,
      failedUploads,
      uploaded,
      queued: this.queue.length + (this.processing ? 1 : 0),
      lastTestAt: settings.lastTestAt,
      lastTestOk: settings.lastTestOk,
      lastError: settings.lastError,
      lastUploadAt: settings.lastUploadAt,
    };
  }

  async runRemoteRetention() {
    const settings = getOffsiteBackupInternalSettings();
    if (!isOffsiteConfigured(settings)) return { deleted: 0 };
    const store = this.storeFactory(settings);
    const prefix = settings.prefix ? `${settings.prefix}/` : '';
    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
    const objects = await store.listObjects(prefix);
    const manifests = objects.filter((object) => object.key.endsWith('/manifest.json'));
    let deleted = 0;

    for (const manifestObject of manifests) {
      if (!manifestObject.lastModified || manifestObject.lastModified.getTime() >= cutoff) continue;
      try {
        const manifest = await store.getJson<OffsiteManifest>(manifestObject.key);
        if (manifest.pinned) continue;
        const snapshotPrefix = manifestObject.key.slice(0, -'/manifest.json'.length);
        const group = objects.filter((object) => object.key.startsWith(`${snapshotPrefix}/`));
        for (const object of group) {
          await store.deleteObject(object.key);
        }
        deleted += 1;
      } catch (error: any) {
        console.warn(
          `[offsite] could not prune ${manifestObject.key}: ${error?.message || error}`,
        );
      }
    }
    if (deleted > 0) console.log(`[offsite] pruned ${deleted} remote snapshot group(s)`);
    return { deleted };
  }

  private kick() {
    if (this.stopped || this.processing) return;
    const snapshotId = this.queue.shift();
    if (!snapshotId) return;
    this.queued.delete(snapshotId);
    this.processing = true;
    this.currentSnapshotId = snapshotId;
    this.currentJob = this.process(snapshotId)
      .catch((error: any) => {
        console.warn(`[offsite] upload job failed for ${snapshotId}: ${error?.message || error}`);
      })
      .finally(() => {
        this.processing = false;
        this.currentSnapshotId = null;
        this.currentJob = null;
        this.kick();
      });
  }

  private async process(snapshotId: string) {
    const settings = getOffsiteBackupInternalSettings();
    if (!isOffsiteConfigured(settings)) return;

    const snapshot = await this.snapshotRepo.findOneBy({ id: snapshotId });
    if (!snapshot || snapshot.status !== 'ready') return;

    const releaseLease = acquireSnapshotLease(snapshotId);
    const current = readOffsite(snapshot) || {
      status: 'pending',
      provider: 's3',
      bucket: settings.bucket,
      prefix: settings.prefix,
      artifactKind: 'db',
      fileName: '',
      objectKey: '',
      manifestKey: '',
      sizeBytes: 0,
      checksumSha256: '',
      artifacts: [],
      attempts: 0,
    } as OffsiteSnapshotState;
    const attempts = (current.attempts || 0) + 1;

    try {
      await this.saveOffsiteState(snapshot.id, {
        ...current,
        status: 'uploading',
        attempts,
        lastError: undefined,
        nextRetryAt: undefined,
      });

      const store = this.storeFactory(settings);
      const snapshotPrefix = offsiteSnapshotPrefix({
        prefix: settings.prefix,
        projectId: snapshot.projectId,
        databaseId: snapshot.databaseId,
        snapshotId: snapshot.id,
      });
      const artifacts = selectedArtifacts(snapshot, settings.artifacts);
      if (artifacts.length === 0) throw new Error('snapshot has no artifacts to upload');

      const records: OffsiteArtifactRecord[] = [];
      for (const artifact of artifacts) {
        const stat = await fs.promises.stat(artifact.path).catch(() => null);
        if (!stat?.isFile() || stat.size <= 0) {
          throw new Error(`snapshot artifact is missing or empty: ${artifact.fileName}`);
        }
        const checksum = await sha256File(artifact.path);
        if (artifact.checksumSha256 && artifact.checksumSha256 !== checksum) {
          throw new Error(`snapshot artifact checksum mismatch: ${artifact.fileName}`);
        }
        const objectKey = offsiteArtifactKey(snapshotPrefix, artifact.fileName);
        await store.uploadFile({
          filePath: artifact.path,
          key: objectKey,
          contentType: offsiteContentType(artifact.kind),
          metadata: {
            snapshotId: snapshot.id,
            databaseId: snapshot.databaseId,
            projectId: snapshot.projectId,
            artifactKind: artifact.kind,
            sha256: checksum,
            takenAt: new Date(snapshot.takenAt).toISOString(),
          },
        });
        records.push({
          kind: artifact.kind,
          fileName: artifact.fileName,
          objectKey,
          sizeBytes: stat.size,
          checksumSha256: checksum,
        });
      }

      const preferred = records[0];
      const manifest: OffsiteManifest = {
        schemaVersion: 1,
        snapshotId: snapshot.id,
        databaseId: snapshot.databaseId,
        projectId: snapshot.projectId,
        takenAt: new Date(snapshot.takenAt).toISOString(),
        reason: snapshot.reason,
        pinned: Boolean(snapshot.pinned),
        format: getSnapshotFormat(snapshot),
        artifacts: records.map((record) => ({
          kind: record.kind,
          fileName: record.fileName,
          sizeBytes: record.sizeBytes,
          sha256: record.checksumSha256,
          contentType: offsiteContentType(record.kind),
        })),
        appVersion: process.env.APP_VERSION || undefined,
        createdAt: new Date().toISOString(),
      };
      const manifestKey = offsiteManifestKey(snapshotPrefix);
      await store.putJson(manifestKey, manifest);

      await this.saveOffsiteState(snapshot.id, {
        ...current,
        status: 'uploaded',
        provider: 's3',
        bucket: settings.bucket,
        prefix: settings.prefix,
        artifactKind: preferred.kind,
        fileName: preferred.fileName,
        objectKey: preferred.objectKey,
        manifestKey,
        sizeBytes: preferred.sizeBytes,
        checksumSha256: preferred.checksumSha256,
        artifacts: records,
        uploadedAt: new Date().toISOString(),
        attempts,
        lastError: undefined,
        nextRetryAt: undefined,
      });
      // The object is already durable. A failure to update the global "last
      // upload" badge must not turn a successful upload into a retry loop.
      await recordOffsiteUploadSuccess().catch((error: any) => {
        console.warn('[offsite] could not record upload success:', error?.message || error);
      });
      await this.auditService.record({
        action: 'snapshot.offsite.upload',
        resourceType: 'database',
        resourceId: snapshot.databaseId,
        metadata: {
          snapshotId: snapshot.id,
          bucket: settings.bucket,
          artifacts: records.map((record) => record.fileName),
          sizeBytes: records.reduce((total, record) => total + record.sizeBytes, 0),
        },
      }).catch(() => undefined);
    } catch (error: any) {
      const detail = describeOffsiteError(error);
      const nextRetryAt = new Date(
        Date.now() + retryDelay(attempts),
      ).toISOString();
      await this.saveOffsiteState(snapshot.id, {
        ...current,
        status: 'failed',
        attempts,
        lastError: detail,
        nextRetryAt,
      }).catch(() => undefined);
      await recordOffsiteError(detail).catch(() => undefined);
      await this.auditService.record({
        action: 'snapshot.offsite.upload_failed',
        resourceType: 'database',
        resourceId: snapshot.databaseId,
        metadata: {
          snapshotId: snapshot.id,
          attempts,
          error: detail,
        },
      }).catch(() => undefined);
      this.scheduleRetry();
    } finally {
      releaseLease();
    }
  }

  /**
   * Updates only the offsite key of the metadata JSON. This avoids losing a
   * concurrent milestone tag when an upload finishes at the same time.
   */
  private async saveOffsiteState(snapshotId: string, state: OffsiteSnapshotState) {
    const payload = JSON.stringify(state);
    try {
      await this.snapshotRepo.createQueryBuilder()
        .update(DatabaseSnapshot)
        .set({
          metadata: () => `json_set(coalesce(metadata, '{}'), '$.offsite', json(:offsiteState))`,
        })
        .setParameter('offsiteState', payload)
        .where('id = :id', { id: snapshotId })
        .execute();
    } catch {
      // JSON1 is available in the bundled SQLite, but keep a safe fallback for
      // older/custom builds.
      const fresh = await this.snapshotRepo.findOneBy({ id: snapshotId });
      if (!fresh) return;
      fresh.metadata = {
        ...(fresh.metadata ?? {}),
        offsite: state,
      };
      await this.snapshotRepo.save(fresh);
    }
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.snapshotRepo.find({ where: { status: 'ready' } })
      .then((snapshots) => {
        const next = snapshots
          .map((snapshot) => readOffsite(snapshot))
          .filter((state): state is OffsiteSnapshotState => Boolean(state?.nextRetryAt))
          .filter((state) => state.status !== 'uploaded')
          .map((state) => new Date(state.nextRetryAt as string).getTime())
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => a - b)[0];
        if (!next) return;
        const delay = Math.max(5_000, next - Date.now());
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.resumePending()
            .catch((error: any) => console.warn('[offsite] retry failed:', error?.message || error))
            .finally(() => this.scheduleRetry());
        }, delay);
        this.retryTimer.unref?.();
      })
      .catch((error: any) => {
        console.warn('[offsite] could not schedule retry:', error?.message || error);
      });
  }

  private scheduleRetention() {
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = null;
      void this.runRemoteRetention()
        .catch((error: any) => console.warn('[offsite] remote retention failed:', error?.message || error))
        .finally(() => this.scheduleRetention());
    }, RETENTION_CHECK_MS);
    this.retentionTimer.unref?.();
  }
}

let singleton: OffsiteBackupService | undefined;

/**
 * Lazy singleton: repositories are only resolved after AppDataSource has been
 * initialized, which matters for tests and for the module import graph.
 */
export function getOffsiteBackupService() {
  if (!singleton) singleton = new OffsiteBackupService();
  return singleton;
}
