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

export type LibsqlArtifactMode = 'dump' | 'both' | 'sqlite';
export type LibsqlArtifactSetting = 'auto' | LibsqlArtifactMode;

function resolveLibsqlArtifactSetting(value: string | undefined): LibsqlArtifactSetting {
  const normalized = String(value ?? 'auto').trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'dump' || normalized === 'both' || normalized === 'sqlite') {
    return normalized;
  }
  if (normalized) {
    console.warn(
      `[snapshots] unknown SNAPSHOT_LIBSQL_ARTIFACT="${value}", falling back to auto`,
    );
  }
  return 'auto';
}

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
  const verifyReplay = booleanValue(process.env.SNAPSHOT_LIBSQL_VERIFY_REPLAY, true);
  const libsqlArtifactSetting = resolveLibsqlArtifactSetting(process.env.SNAPSHOT_LIBSQL_ARTIFACT);
  // `auto` keeps the historical behaviour for installations that disabled the
  // replay verification: they continue to store the raw .sql dump. Everything
  // else materializes a standalone, verified SQLite file.
  const libsqlArtifactMode: LibsqlArtifactMode = libsqlArtifactSetting === 'auto'
    ? (verifyReplay ? 'sqlite' : 'dump')
    : libsqlArtifactSetting;
  return {
    enabled: booleanValue(process.env.SNAPSHOTS_ENABLED, true),
    // libSQL logical dumps can be large; keep them enabled by default because
    // they are the only durable backup path for managed primaries, but allow
    // operators to pause scheduled dumps without disabling SQLite snapshots.
    libsqlEnabled: booleanValue(process.env.SNAPSHOT_LIBSQL_ENABLED, true),
    snapshotRoot,
    intervalMinutes: getSnapshotPolicy().intervalMinutes,
    fullWindowHours: getSnapshotPolicy().fullWindowHours,
    sixHourlyWindowHours: getSnapshotPolicy().sixHourlyWindowHours,
    retentionDays: getSnapshotPolicy().retentionDays,
    maxConcurrent: getSnapshotPolicy().maxConcurrent,
    minFreeBytes: positiveInt(process.env.SNAPSHOT_MIN_FREE_BYTES, 1024 * 1024 * 1024),
    staleMinutes: positiveInt(process.env.SNAPSHOT_STALE_MINUTES, 30),
    verifyOnRestore: booleanValue(process.env.SNAPSHOT_VERIFY_ON_RESTORE, true),
    verifyReplay,
    libsqlArtifactSetting,
    libsqlArtifactMode,
    initialDelayMs: positiveInt(process.env.SNAPSHOT_INITIAL_DELAY_SECONDS, 120) * 1000,
    tickMinutes: positiveInt(process.env.SNAPSHOT_SCHEDULER_TICK_MINUTES, 5),
    defaultTimezone: process.env.SNAPSHOT_TIMEZONE || 'UTC',
  };
}

export function getDefaultSnapshotPolicyConfig() {
  const config = getSnapshotConfig();
  return {
    restorePointIntervalMinutes: config.intervalMinutes,
    dailyEnabled: booleanValue(process.env.SNAPSHOT_DAILY_ENABLED, true),
    dailyAtHour: positiveInt(process.env.SNAPSHOT_DAILY_AT_HOUR, 2),
    dailyRetention: positiveInt(process.env.SNAPSHOT_DAILY_RETENTION, config.retentionDays),
    weeklyEnabled: booleanValue(process.env.SNAPSHOT_WEEKLY_ENABLED, false),
    weeklyDayOfWeek: positiveInt(process.env.SNAPSHOT_WEEKLY_DAY, 0) % 7,
    weeklyAtHour: positiveInt(process.env.SNAPSHOT_WEEKLY_AT_HOUR, 2),
    weeklyRetention: positiveInt(process.env.SNAPSHOT_WEEKLY_RETENTION, 8),
    monthlyEnabled: booleanValue(process.env.SNAPSHOT_MONTHLY_ENABLED, false),
    monthlyDayOfMonth: Math.min(28, positiveInt(process.env.SNAPSHOT_MONTHLY_DAY, 1)),
    monthlyAtHour: positiveInt(process.env.SNAPSHOT_MONTHLY_AT_HOUR, 2),
    monthlyRetention: positiveInt(process.env.SNAPSHOT_MONTHLY_RETENTION, 12),
    timezone: config.defaultTimezone,
  };
}

export function snapshotRootDirectory() {
  return getSnapshotConfig().snapshotRoot;
}
