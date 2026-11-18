import path from 'path';

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function booleanValue(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export type SnapshotPolicy = {
  intervalMinutes: number;
  fullWindowHours: number;
  sixHourlyWindowHours: number;
  retentionDays: number;
  maxConcurrent: number;
};

export function getSnapshotPolicy(): SnapshotPolicy {
  return {
    intervalMinutes: positiveInt(process.env.SNAPSHOT_INTERVAL_MINUTES, 60),
    fullWindowHours: positiveInt(process.env.SNAPSHOT_FULL_WINDOW_HOURS, 24),
    sixHourlyWindowHours: positiveInt(process.env.SNAPSHOT_SIX_HOURLY_WINDOW_HOURS, 72),
    retentionDays: positiveInt(process.env.SNAPSHOT_RETENTION_DAYS, 14),
    maxConcurrent: positiveInt(process.env.SNAPSHOT_MAX_CONCURRENT, 1),
  };
}

export function getSnapshotConfig() {
  const storageRoot = process.env.SQLITE_STORAGE_ROOT || path.join(process.cwd(), 'data', 'sqlite');
  const snapshotRoot = process.env.SNAPSHOT_STORAGE_ROOT || path.join(storageRoot, 'snapshots');
  return {
    enabled: booleanValue(process.env.SNAPSHOTS_ENABLED, true),
    snapshotRoot,
    intervalMinutes: getSnapshotPolicy().intervalMinutes,
    fullWindowHours: getSnapshotPolicy().fullWindowHours,
    sixHourlyWindowHours: getSnapshotPolicy().sixHourlyWindowHours,
    retentionDays: getSnapshotPolicy().retentionDays,
    maxConcurrent: getSnapshotPolicy().maxConcurrent,
    minFreeBytes: positiveInt(process.env.SNAPSHOT_MIN_FREE_BYTES, 1024 * 1024 * 1024),
    staleMinutes: positiveInt(process.env.SNAPSHOT_STALE_MINUTES, 30),
    verifyOnRestore: booleanValue(process.env.SNAPSHOT_VERIFY_ON_RESTORE, true),
    initialDelayMs: positiveInt(process.env.SNAPSHOT_INITIAL_DELAY_SECONDS, 120) * 1000,
  };
}

export function snapshotRootDirectory() {
  return getSnapshotConfig().snapshotRoot;
}
