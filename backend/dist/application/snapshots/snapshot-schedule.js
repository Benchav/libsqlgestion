"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getZonedParts = getZonedParts;
exports.getIsoWeekKey = getIsoWeekKey;
exports.getPeriodKeys = getPeriodKeys;
exports.getMilestones = getMilestones;
exports.getDueMilestones = getDueMilestones;
function pad(value) {
    return String(value).padStart(2, '0');
}
function getZonedParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    let hour = Number(parts.hour);
    if (hour === 24)
        hour = 0;
    return {
        year,
        month,
        day,
        hour,
        minute: Number(parts.minute),
        weekdayIndex: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    };
}
function getIsoWeekKey(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const dayNumber = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function getPeriodKeys(date, timeZone) {
    const parts = getZonedParts(date, timeZone);
    return {
        parts,
        dailyKey: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
        weeklyKey: getIsoWeekKey(parts.year, parts.month, parts.day),
        monthlyKey: `${parts.year}-${pad(parts.month)}`,
    };
}
function getMilestones(snapshot) {
    const milestones = snapshot.metadata?.milestones;
    if (!milestones || typeof milestones !== 'object')
        return {};
    const result = {};
    for (const type of ['daily', 'weekly', 'monthly']) {
        const value = milestones[type];
        if (typeof value === 'string')
            result[type] = value;
    }
    return result;
}
function getDueMilestones(now, policy, snapshots) {
    const { parts, dailyKey, weeklyKey, monthlyKey } = getPeriodKeys(now, policy.timezone);
    const existing = new Set();
    for (const snapshot of snapshots) {
        const milestones = getMilestones(snapshot);
        for (const type of ['daily', 'weekly', 'monthly']) {
            const value = milestones[type];
            if (value)
                existing.add(`${type}:${value}`);
        }
    }
    const due = [];
    if (policy.dailyEnabled && parts.hour >= policy.dailyAtHour && !existing.has(`daily:${dailyKey}`)) {
        due.push({ type: 'daily', key: dailyKey });
    }
    if (policy.weeklyEnabled) {
        const targetDay = (policy.weeklyDayOfWeek + 6) % 7;
        const currentDay = (parts.weekdayIndex + 6) % 7;
        const passed = currentDay > targetDay
            || (currentDay === targetDay && parts.hour >= policy.weeklyAtHour);
        if (passed && !existing.has(`weekly:${weeklyKey}`)) {
            due.push({ type: 'weekly', key: weeklyKey });
        }
    }
    if (policy.monthlyEnabled) {
        const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
        const targetDay = Math.min(policy.monthlyDayOfMonth, daysInMonth);
        const passed = parts.day > targetDay
            || (parts.day === targetDay && parts.hour >= policy.monthlyAtHour);
        if (passed && !existing.has(`monthly:${monthlyKey}`)) {
            due.push({ type: 'monthly', key: monthlyKey });
        }
    }
    return due;
}
