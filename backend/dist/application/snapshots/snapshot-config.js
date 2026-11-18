"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSnapshotPolicy = getSnapshotPolicy;
exports.getSnapshotConfig = getSnapshotConfig;
exports.getDefaultSnapshotPolicyConfig = getDefaultSnapshotPolicyConfig;
exports.snapshotRootDirectory = snapshotRootDirectory;
const path_1 = __importDefault(require("path"));
function positiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
function booleanValue(value, fallback) {
    if (value === undefined || value === '')
        return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'off'].includes(normalized))
        return false;
    return fallback;
}
function getSnapshotPolicy() {
    return {
        intervalMinutes: positiveInt(process.env.SNAPSHOT_INTERVAL_MINUTES, 60),
        fullWindowHours: positiveInt(process.env.SNAPSHOT_FULL_WINDOW_HOURS, 24),
        sixHourlyWindowHours: positiveInt(process.env.SNAPSHOT_SIX_HOURLY_WINDOW_HOURS, 72),
        retentionDays: positiveInt(process.env.SNAPSHOT_RETENTION_DAYS, 14),
        maxConcurrent: positiveInt(process.env.SNAPSHOT_MAX_CONCURRENT, 1),
    };
}
function getSnapshotConfig() {
    const storageRoot = process.env.SQLITE_STORAGE_ROOT || path_1.default.join(process.cwd(), 'data', 'sqlite');
    const snapshotRoot = process.env.SNAPSHOT_STORAGE_ROOT || path_1.default.join(storageRoot, 'snapshots');
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
        tickMinutes: positiveInt(process.env.SNAPSHOT_SCHEDULER_TICK_MINUTES, 5),
        defaultTimezone: process.env.SNAPSHOT_TIMEZONE || 'UTC',
    };
}
function getDefaultSnapshotPolicyConfig() {
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
function snapshotRootDirectory() {
    return getSnapshotConfig().snapshotRoot;
}
