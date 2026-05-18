import { AppDataSource } from '../../infrastructure/db/data-source';
import { PlatformSetting } from '../../domain/entities/PlatformSetting';

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
    protocol: (process.env.DATABASE_PUBLIC_PROTOCOL || 'https').trim() || 'https',
  };
}

function normalizeSettings(settings: Partial<PublicDatabaseSettings>): PublicDatabaseSettings {
  return {
    domain: (settings.domain || '').trim(),
    template: (settings.template || '').trim(),
    baseUrl: (settings.baseUrl || '').trim(),
    host: (settings.host || '').trim(),
    protocol: (settings.protocol || 'https').trim() || 'https',
  };
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