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
        protocol: (process.env.DATABASE_PUBLIC_PROTOCOL || 'http').trim() || 'http',
    };
}
function normalizeSettings(settings) {
    return {
        domain: (settings.domain || '').trim(),
        template: (settings.template || '').trim(),
        baseUrl: (settings.baseUrl || '').trim(),
        host: (settings.host || '').trim(),
        protocol: (settings.protocol || 'http').trim() || 'http',
    };
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
