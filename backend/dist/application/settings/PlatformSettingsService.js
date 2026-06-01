"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPublicDatabaseSettings = getPublicDatabaseSettings;
exports.getPublicDatabaseSettingsDefaults = getPublicDatabaseSettingsDefaults;
exports.bootstrapPlatformSettings = bootstrapPlatformSettings;
exports.reloadPublicDatabaseSettings = reloadPublicDatabaseSettings;
exports.updatePublicDatabaseSettings = updatePublicDatabaseSettings;
exports.getPublicDatabaseSettingSource = getPublicDatabaseSettingSource;
const data_source_1 = require("../../infrastructure/db/data-source");
const PlatformSetting_1 = require("../../domain/entities/PlatformSetting");
const slug_1 = require("../../infrastructure/security/slug");
const SETTING_KEYS = {
    domain: 'DATABASE_PUBLIC_DOMAIN',
    template: 'DATABASE_PUBLIC_URL_TEMPLATE',
    baseUrl: 'DATABASE_PUBLIC_BASE_URL',
    host: 'DATABASE_PUBLIC_HOST',
    protocol: 'DATABASE_PUBLIC_PROTOCOL',
};
const cachedDefaults = loadEnvDefaults();
let cachedPublicDatabaseSettings = { ...cachedDefaults };
function loadEnvDefaults() {
    return {
        domain: (process.env.DATABASE_PUBLIC_DOMAIN || '').trim(),
        template: (process.env.DATABASE_PUBLIC_URL_TEMPLATE || '').trim(),
        baseUrl: (process.env.DATABASE_PUBLIC_BASE_URL || '').trim(),
        host: (process.env.DATABASE_PUBLIC_HOST || '').trim(),
        protocol: normalizeProtocol(process.env.DATABASE_PUBLIC_PROTOCOL),
    };
}
function normalizeProtocol(value) {
    const normalized = (value || 'https').trim().toLowerCase();
    return normalized === 'http' ? 'http' : 'https';
}
function normalizeSettings(settings) {
    const domain = (0, slug_1.normalizeDomain)(settings.domain || '');
    const host = (0, slug_1.normalizeDomain)(settings.host || '');
    return {
        domain,
        template: (settings.template || '').trim(),
        baseUrl: (settings.baseUrl || '').trim(),
        host,
        protocol: normalizeProtocol(settings.protocol),
    };
}
function validateSettings(settings) {
    if (settings.domain) {
        (0, slug_1.assertValidDomain)(settings.domain, 'domain');
    }
    if (settings.host) {
        (0, slug_1.assertValidDomain)(settings.host, 'host');
    }
}
function mapRowsToSettings(rows) {
    const entries = new Map(rows.map((row) => [row.key, (row.value || '').trim()]));
    return {
        domain: entries.get(SETTING_KEYS.domain) || '',
        template: entries.get(SETTING_KEYS.template) || '',
        baseUrl: entries.get(SETTING_KEYS.baseUrl) || '',
        host: entries.get(SETTING_KEYS.host) || '',
        protocol: entries.get(SETTING_KEYS.protocol) || '',
    };
}
function rowsFromSettings(settings) {
    return [
        [SETTING_KEYS.domain, settings.domain],
        [SETTING_KEYS.template, settings.template],
        [SETTING_KEYS.baseUrl, settings.baseUrl],
        [SETTING_KEYS.host, settings.host],
        [SETTING_KEYS.protocol, settings.protocol],
    ];
}
function getPublicDatabaseSettings() {
    return { ...cachedDefaults, ...cachedPublicDatabaseSettings };
}
function getPublicDatabaseSettingsDefaults() {
    return { ...cachedDefaults };
}
async function bootstrapPlatformSettings() {
    await reloadPublicDatabaseSettings();
}
async function reloadPublicDatabaseSettings() {
    const repo = data_source_1.AppDataSource.getRepository(PlatformSetting_1.PlatformSetting);
    const rows = await repo.find();
    cachedPublicDatabaseSettings = normalizeSettings(mapRowsToSettings(rows));
    return getPublicDatabaseSettings();
}
async function updatePublicDatabaseSettings(input) {
    const repo = data_source_1.AppDataSource.getRepository(PlatformSetting_1.PlatformSetting);
    const settings = normalizeSettings(input);
    validateSettings(settings);
    for (const [key, value] of rowsFromSettings(settings)) {
        const existing = await repo.findOneBy({ key });
        if (!value) {
            if (existing) {
                await repo.remove(existing);
            }
            continue;
        }
        if (!existing) {
            await repo.save(repo.create({ key, value }));
            continue;
        }
        existing.value = value;
        await repo.save(existing);
    }
    await reloadPublicDatabaseSettings();
    return getPublicDatabaseSettings();
}
function getPublicDatabaseSettingSource(key) {
    const current = getPublicDatabaseSettings();
    if (current[key]) {
        return 'panel';
    }
    const defaults = getPublicDatabaseSettingsDefaults();
    return defaults[key] ? 'env' : 'unset';
}
