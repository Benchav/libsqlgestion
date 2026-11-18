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

export function getAnalyticsConfig() {
  return {
    enabled: booleanValue(process.env.ANALYTICS_ENABLED, true),
    rawRetentionDays: positiveInt(process.env.ANALYTICS_RAW_RETENTION_DAYS, 14),
    flushIntervalMs: positiveInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS, 1000),
    maxQueue: positiveInt(process.env.ANALYTICS_MAX_QUEUE, 10_000),
    storageSampleMinutes: positiveInt(process.env.ANALYTICS_STORAGE_SAMPLE_MINUTES, 60),
    storageRetentionDays: positiveInt(process.env.ANALYTICS_STORAGE_RETENTION_DAYS, 90),
    trafficEnabled: booleanValue(process.env.ANALYTICS_TRAFFIC_ENABLED, true),
  };
}
