import { AppDataSource } from '../../infrastructure/db/data-source';
import { PlatformSetting } from '../../domain/entities/PlatformSetting';
import { assertValidDomain, normalizeDomain } from '../../infrastructure/security/slug';

export type PublicDatabaseSettings = {
  domain: string;
  template: string;
  baseUrl: string;
  host: string;
  protocol: string;
};

const SETTING_KEYS = {
  domain: 'DATABASE_PUBLIC_DOMAIN',
  template: 'DATABASE_PUBLIC_URL_TEMPLATE',
  baseUrl: 'DATABASE_PUBLIC_BASE_URL',
  host: 'DATABASE_PUBLIC_HOST',
  protocol: 'DATABASE_PUBLIC_PROTOCOL',
} as const;

const cachedDefaults: PublicDatabaseSettings = loadEnvDefaults();
let cachedPublicDatabaseSettings: PublicDatabaseSettings = { ...cachedDefaults };

function loadEnvDefaults(): PublicDatabaseSettings {
  return {
    domain: (process.env.DATABASE_PUBLIC_DOMAIN || '').trim(),
    template: (process.env.DATABASE_PUBLIC_URL_TEMPLATE || '').trim(),
    baseUrl: (process.env.DATABASE_PUBLIC_BASE_URL || '').trim(),
    host: (process.env.DATABASE_PUBLIC_HOST || '').trim(),
    protocol: normalizeProtocol(process.env.DATABASE_PUBLIC_PROTOCOL),
  };
}

function normalizeProtocol(value?: string) {
  const normalized = (value || 'https').trim().toLowerCase();
  return normalized === 'http' ? 'http' : 'https';
}

function normalizeSettings(settings: Partial<PublicDatabaseSettings>): PublicDatabaseSettings {
  const domain = normalizeDomain(settings.domain || '');
  const host = normalizeDomain(settings.host || '');

  return {
    domain,
    template: (settings.template || '').trim(),
    baseUrl: (settings.baseUrl || '').trim(),
    host,
    protocol: normalizeProtocol(settings.protocol),
  };
}

function validateSettings(settings: PublicDatabaseSettings) {
  if (settings.domain) {
    assertValidDomain(settings.domain, 'domain');
  }
  if (settings.host) {
    assertValidDomain(settings.host, 'host');
  }
}

function mapRowsToSettings(rows: PlatformSetting[]): Partial<PublicDatabaseSettings> {
  const entries = new Map(rows.map((row) => [row.key, (row.value || '').trim()]));
  return {
    domain: entries.get(SETTING_KEYS.domain) || '',
    template: entries.get(SETTING_KEYS.template) || '',
    baseUrl: entries.get(SETTING_KEYS.baseUrl) || '',
    host: entries.get(SETTING_KEYS.host) || '',
    protocol: entries.get(SETTING_KEYS.protocol) || '',
  };
}

function rowsFromSettings(settings: Partial<PublicDatabaseSettings>) {
  return [
    [SETTING_KEYS.domain, settings.domain],
    [SETTING_KEYS.template, settings.template],
    [SETTING_KEYS.baseUrl, settings.baseUrl],
    [SETTING_KEYS.host, settings.host],
    [SETTING_KEYS.protocol, settings.protocol],
  ] as const;
}

export function getPublicDatabaseSettings(): PublicDatabaseSettings {
  return { ...cachedDefaults, ...cachedPublicDatabaseSettings };
}

export function getPublicDatabaseSettingsDefaults(): PublicDatabaseSettings {
  return { ...cachedDefaults };
}

export async function bootstrapPlatformSettings() {
  await reloadPublicDatabaseSettings();
}

export async function reloadPublicDatabaseSettings() {
  const repo = AppDataSource.getRepository(PlatformSetting);
  const rows = await repo.find();
  cachedPublicDatabaseSettings = normalizeSettings(mapRowsToSettings(rows));
  return getPublicDatabaseSettings();
}

export async function updatePublicDatabaseSettings(input: Partial<PublicDatabaseSettings>) {
  const repo = AppDataSource.getRepository(PlatformSetting);
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

export function getPublicDatabaseSettingSource(key: keyof PublicDatabaseSettings) {
  const current = getPublicDatabaseSettings();
  if (current[key]) {
    return 'panel';
  }

  const defaults = getPublicDatabaseSettingsDefaults();
  return defaults[key] ? 'env' : 'unset';
}
