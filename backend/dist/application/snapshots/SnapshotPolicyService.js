"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotPolicyService = void 0;
const data_source_1 = require("../../infrastructure/db/data-source");
const DatabaseSnapshotPolicy_1 = require("../../domain/entities/DatabaseSnapshotPolicy");
const snapshot_config_1 = require("./snapshot-config");
function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}
function validateTimezone(timezone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    }
    catch {
        throw httpError(422, `invalid timezone: ${timezone}`);
    }
}
class SnapshotPolicyService {
    constructor() {
        this.policyRepo = data_source_1.AppDataSource.getRepository(DatabaseSnapshotPolicy_1.DatabaseSnapshotPolicy);
    }
    async getPolicy(databaseId) {
        const row = await this.policyRepo.findOne({ where: { databaseId } });
        if (!row) {
            return {
                databaseId,
                ...(0, snapshot_config_1.getDefaultSnapshotPolicyConfig)(),
                isDefault: true,
            };
        }
        return this.toView(row);
    }
    async upsertPolicy(databaseId, input) {
        const defaults = (0, snapshot_config_1.getDefaultSnapshotPolicyConfig)();
        const existing = await this.policyRepo.findOne({ where: { databaseId } });
        const current = existing ? this.toView(existing) : { databaseId, ...defaults, isDefault: true };
        const next = {
            ...current,
            ...input,
            databaseId,
            isDefault: false,
        };
        this.validate(next);
        const row = existing || this.policyRepo.create({ databaseId });
        row.restorePointIntervalMinutes = next.restorePointIntervalMinutes;
        row.dailyEnabled = next.dailyEnabled;
        row.dailyAtHour = next.dailyAtHour;
        row.dailyRetention = next.dailyRetention;
        row.weeklyEnabled = next.weeklyEnabled;
        row.weeklyDayOfWeek = next.weeklyDayOfWeek;
        row.weeklyAtHour = next.weeklyAtHour;
        row.weeklyRetention = next.weeklyRetention;
        row.monthlyEnabled = next.monthlyEnabled;
        row.monthlyDayOfMonth = next.monthlyDayOfMonth;
        row.monthlyAtHour = next.monthlyAtHour;
        row.monthlyRetention = next.monthlyRetention;
        row.timezone = next.timezone;
        const saved = await this.policyRepo.save(row);
        return this.toView(saved);
    }
    validate(policy) {
        validateTimezone(policy.timezone);
        if (policy.dailyAtHour < 0 || policy.dailyAtHour > 23) {
            throw httpError(422, 'dailyAtHour must be between 0 and 23');
        }
        if (policy.weeklyDayOfWeek < 0 || policy.weeklyDayOfWeek > 6) {
            throw httpError(422, 'weeklyDayOfWeek must be between 0 and 6');
        }
        if (policy.weeklyAtHour < 0 || policy.weeklyAtHour > 23) {
            throw httpError(422, 'weeklyAtHour must be between 0 and 23');
        }
        if (policy.monthlyDayOfMonth < 1 || policy.monthlyDayOfMonth > 28) {
            throw httpError(422, 'monthlyDayOfMonth must be between 1 and 28');
        }
        if (policy.monthlyAtHour < 0 || policy.monthlyAtHour > 23) {
            throw httpError(422, 'monthlyAtHour must be between 0 and 23');
        }
        if (policy.restorePointIntervalMinutes < 5 || policy.restorePointIntervalMinutes > 1440) {
            throw httpError(422, 'restorePointIntervalMinutes must be between 5 and 1440');
        }
        for (const [label, value] of [
            ['dailyRetention', policy.dailyRetention],
            ['weeklyRetention', policy.weeklyRetention],
            ['monthlyRetention', policy.monthlyRetention],
        ]) {
            if (value < 1 || value > 365) {
                throw httpError(422, `${label} must be between 1 and 365`);
            }
        }
    }
    toView(row) {
        return {
            databaseId: row.databaseId,
            restorePointIntervalMinutes: row.restorePointIntervalMinutes,
            dailyEnabled: Boolean(row.dailyEnabled),
            dailyAtHour: row.dailyAtHour,
            dailyRetention: row.dailyRetention,
            weeklyEnabled: Boolean(row.weeklyEnabled),
            weeklyDayOfWeek: row.weeklyDayOfWeek,
            weeklyAtHour: row.weeklyAtHour,
            weeklyRetention: row.weeklyRetention,
            monthlyEnabled: Boolean(row.monthlyEnabled),
            monthlyDayOfMonth: row.monthlyDayOfMonth,
            monthlyAtHour: row.monthlyAtHour,
            monthlyRetention: row.monthlyRetention,
            timezone: row.timezone,
            isDefault: false,
        };
    }
}
exports.SnapshotPolicyService = SnapshotPolicyService;
