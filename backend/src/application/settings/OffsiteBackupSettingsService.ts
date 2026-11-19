import { promises as dns } from 'dns';
import net from 'net';
import { Repository } from 'typeorm';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { PlatformSetting } from '../../domain/entities/PlatformSetting';
import { decrypt, encrypt } from '../../infrastructure/crypto';

export type OffsiteUploadMode = 'all' | 'daily' | 'manual';
export type OffsiteArtifacts = 'db' | 'db+sql';
export type OffsiteSecretSource = 'panel' | 'env' | 'none';

export type OffsiteBackupSettings = {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKeyConfigured: boolean;
  secretSource: OffsiteSecretSource;
  uploadMode: OffsiteUploadMode;
  artifacts: OffsiteArtifacts;
  retentionDays: number;
  required: boolean;
  timeoutMs: number;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastError?: string;
  lastUploadAt?: string;
};

export type OffsiteBackupInternalSettings = OffsiteBackupSettings & {
  secretAccessKey?: string;
};

type SettingsInput = Partial<Omit<OffsiteBackupSettings, 'secretAccessKeyConfigured' | 'secretSource'>> & {
  secretAccessKey?: string;
  clearSecret?: boolean;
};

const SETTING_KEYS = {
  enabled: 'SNAPSHOT_OFFSITE_ENABLED',
  endpoint: 'SNAPSHOT_OFFSITE_ENDPOINT',
  bucket: 'SNAPSHOT_OFFSITE_BUCKET',
  region: 'SNAPSHOT_OFFSITE_REGION',
  prefix: 'SNAPSHOT_OFFSITE_PREFIX',
  accessKeyId: 'SNAPSHOT_OFFSITE_ACCESS_KEY_ID',
  secretAccessKeyEnc: 'SNAPSHOT_OFFSITE_SECRET_ACCESS_KEY_ENC',
  uploadMode: 'SNAPSHOT_OFFSITE_UPLOAD_MODE',
  artifacts: 'SNAPSHOT_OFFSITE_ARTIFACTS',
  retentionDays: 'SNAPSHOT_OFFSITE_RETENTION_DAYS',
  required: 'SNAPSHOT_OFFSITE_REQUIRED',
  timeoutMs: 'SNAPSHOT_OFFSITE_TIMEOUT_MS',
  lastTestAt: 'SNAPSHOT_OFFSITE_LAST_TEST_AT',
  lastTestOk: 'SNAPSHOT_OFFSITE_LAST_TEST_OK',
  lastError: 'SNAPSHOT_OFFSITE_LAST_ERROR',
  lastUploadAt: 'SNAPSHOT_OFFSITE_LAST_UPLOAD_AT',
} as const;

function envBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function envInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function normalizePrefix(value: string) {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (!prefix) return '';
  if (prefix.includes('\\') || prefix.includes('..') || prefix.includes('//')) {
    throw validationError('offsite prefix contains an invalid path segment');
  }
  for (const segment of prefix.split('/')) {
    if (!segment || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw validationError('offsite prefix contains invalid characters');
    }
  }
  return prefix;
}

function normalizeBucket(value: string) {
  const bucket = value.trim();
  if (!bucket) return '';
  if (bucket.length < 3 || bucket.length > 63) {
    throw validationError('offsite bucket must be between 3 and 63 characters');
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    throw validationError('offsite bucket must use lowercase letters, numbers, dots or hyphens');
  }
  return bucket;
}

function normalizeRegion(value: string) {
  const region = value.trim().toLowerCase() || 'auto';
  if (!/^[a-z0-9-]{1,64}$/.test(region)) {
    throw validationError('offsite region is invalid');
  }
  return region;
}

function normalizeUploadMode(value: string | undefined): OffsiteUploadMode {
  if (value === 'all' || value === 'daily' || value === 'manual') return value;
  return 'daily';
}

function normalizeArtifacts(value: string | undefined): OffsiteArtifacts {
  return value === 'db+sql' ? 'db+sql' : 'db';
}

function validationError(message: string) {
  const error: any = new Error(message);
  error.statusCode = 422;
  return error;
}

function loadEnvDefaults(): OffsiteBackupInternalSettings {
  const secret = (process.env.SNAPSHOT_OFFSITE_SECRET_ACCESS_KEY || '').trim();
  return {
    enabled: envBoolean(process.env.SNAPSHOT_OFFSITE_ENABLED, false),
    endpoint: normalizeEndpoint(process.env.SNAPSHOT_OFFSITE_ENDPOINT || ''),
    bucket: (process.env.SNAPSHOT_OFFSITE_BUCKET || '').trim(),
    region: (process.env.SNAPSHOT_OFFSITE_REGION || 'auto').trim().toLowerCase() || 'auto',
    prefix: (process.env.SNAPSHOT_OFFSITE_PREFIX || 'libsqlite').trim(),
    accessKeyId: (process.env.SNAPSHOT_OFFSITE_ACCESS_KEY_ID || '').trim(),
    secretAccessKeyConfigured: Boolean(secret),
    secretSource: secret ? 'env' : 'none',
    secretAccessKey: secret || undefined,
    uploadMode: normalizeUploadMode(process.env.SNAPSHOT_OFFSITE_UPLOAD_MODE),
    artifacts: normalizeArtifacts(process.env.SNAPSHOT_OFFSITE_ARTIFACTS),
    retentionDays: envInteger(process.env.SNAPSHOT_OFFSITE_RETENTION_DAYS, 30, 1, 3650),
    required: envBoolean(process.env.SNAPSHOT_OFFSITE_REQUIRED, false),
    timeoutMs: envInteger(process.env.SNAPSHOT_OFFSITE_TIMEOUT_MS, 300000, 5000, 1800000),
  };
}

const envDefaults = loadEnvDefaults();
let cached: OffsiteBackupInternalSettings = { ...envDefaults };

function publicView(settings: OffsiteBackupInternalSettings): OffsiteBackupSettings {
  const { secretAccessKey: _secret, ...rest } = settings;
  return { ...rest };
}

export function getOffsiteBackupSettings(): OffsiteBackupSettings {
  return publicView(cached);
}

export function getOffsiteBackupInternalSettings(): OffsiteBackupInternalSettings {
  return { ...cached };
}

export function getOffsiteBackupSettingsDefaults(): OffsiteBackupSettings {
  return publicView(envDefaults);
}

function isConfigured(settings: OffsiteBackupInternalSettings) {
  return Boolean(
    settings.endpoint
    && settings.bucket
    && settings.accessKeyId
    && settings.secretAccessKey,
  );
}

export function isOffsiteReady(settings: OffsiteBackupInternalSettings = cached) {
  return isConfigured(settings);
}

export function isOffsiteConfigured(settings: OffsiteBackupInternalSettings = cached) {
  return settings.enabled && isConfigured(settings);
}

function mapRows(rows: PlatformSetting[]) {
  return new Map(rows.map((row) => [row.key, row.value || '']));
}

function valueOr(value: string | undefined, fallback: string) {
  return value === undefined || value === '' ? fallback : value;
}

export async function bootstrapOffsiteBackupSettings() {
  await reloadOffsiteBackupSettings();
}

export async function reloadOffsiteBackupSettings() {
  const repo = AppDataSource.getRepository(PlatformSetting);
  const rows = await repo.find();
  const values = mapRows(rows);

  const panelSecretCipher = (values.get(SETTING_KEYS.secretAccessKeyEnc) || '').trim();
  let panelSecret: string | undefined;
  if (panelSecretCipher) {
    try {
      panelSecret = decrypt(panelSecretCipher);
    } catch (error: any) {
      console.warn(
        `[offsite] could not decrypt the stored S3 secret; re-enter it in Settings: ${error?.message || error}`,
      );
    }
  }
  const envSecret = envDefaults.secretAccessKey;
  const secret = panelSecret || envSecret;
  const secretSource: OffsiteSecretSource = panelSecret ? 'panel' : (envSecret ? 'env' : 'none');

  cached = {
    enabled: values.has(SETTING_KEYS.enabled)
      ? envBoolean(values.get(SETTING_KEYS.enabled), envDefaults.enabled)
      : envDefaults.enabled,
    endpoint: normalizeEndpoint(valueOr(values.get(SETTING_KEYS.endpoint), envDefaults.endpoint)),
    bucket: (valueOr(values.get(SETTING_KEYS.bucket), envDefaults.bucket) || '').trim(),
    region: normalizeRegion(valueOr(values.get(SETTING_KEYS.region), envDefaults.region)),
    prefix: normalizePrefix(valueOr(values.get(SETTING_KEYS.prefix), envDefaults.prefix)),
    accessKeyId: (valueOr(values.get(SETTING_KEYS.accessKeyId), envDefaults.accessKeyId) || '').trim(),
    secretAccessKeyConfigured: Boolean(secret),
    secretSource,
    secretAccessKey: secret,
    uploadMode: normalizeUploadMode(values.get(SETTING_KEYS.uploadMode) || envDefaults.uploadMode),
    artifacts: normalizeArtifacts(values.get(SETTING_KEYS.artifacts) || envDefaults.artifacts),
    retentionDays: envInteger(
      values.get(SETTING_KEYS.retentionDays),
      envDefaults.retentionDays,
      1,
      3650,
    ),
    required: values.has(SETTING_KEYS.required)
      ? envBoolean(values.get(SETTING_KEYS.required), envDefaults.required)
      : envDefaults.required,
    timeoutMs: envInteger(
      values.get(SETTING_KEYS.timeoutMs),
      envDefaults.timeoutMs,
      5000,
      1800000,
    ),
    lastTestAt: values.get(SETTING_KEYS.lastTestAt) || undefined,
    lastTestOk: values.has(SETTING_KEYS.lastTestOk)
      ? envBoolean(values.get(SETTING_KEYS.lastTestOk), false)
      : undefined,
    lastError: values.get(SETTING_KEYS.lastError) || undefined,
    lastUploadAt: values.get(SETTING_KEYS.lastUploadAt) || undefined,
  };

  return getOffsiteBackupSettings();
}

async function upsert(repo: Repository<PlatformSetting>, key: string, value: string) {
  const existing = await repo.findOneBy({ key });
  if (!value) {
    if (existing) await repo.remove(existing);
    return;
  }
  if (!existing) {
    await repo.save(repo.create({ key, value }));
    return;
  }
  existing.value = value;
  await repo.save(existing);
}

export async function updateOffsiteBackupSettings(input: SettingsInput) {
  const repo = AppDataSource.getRepository(PlatformSetting);
  const current = getOffsiteBackupInternalSettings();

  const endpoint = normalizeEndpoint(input.endpoint ?? current.endpoint);
  const bucket = normalizeBucket(input.bucket ?? current.bucket);
  const region = normalizeRegion(input.region ?? current.region);
  const prefix = normalizePrefix(input.prefix ?? current.prefix);
  const accessKeyId = (input.accessKeyId ?? current.accessKeyId).trim();
  const uploadMode = normalizeUploadMode(input.uploadMode ?? current.uploadMode);
  const artifacts = normalizeArtifacts(input.artifacts ?? current.artifacts);
  const retentionDays = Math.min(3650, Math.max(1, Math.floor(Number(input.retentionDays ?? current.retentionDays) || 30)));
  const timeoutMs = Math.min(1800000, Math.max(5000, Math.floor(Number(input.timeoutMs ?? current.timeoutMs) || 300000)));
  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  const required = input.required === undefined ? current.required : Boolean(input.required);

  if (enabled) {
    if (!endpoint) throw validationError('offsite endpoint is required');
    if (!bucket) throw validationError('offsite bucket is required');
    if (!accessKeyId) throw validationError('offsite access key id is required');
  }
  if (endpoint) assertEndpointSyntax(endpoint);

  let panelSecret = current.secretSource === 'panel' ? current.secretAccessKey : undefined;
  let secretAccessKeyEnc: string | undefined;
  if (input.clearSecret) {
    panelSecret = undefined;
  } else if (typeof input.secretAccessKey === 'string' && input.secretAccessKey.trim()) {
    panelSecret = input.secretAccessKey.trim();
  }
  if (panelSecret) {
    secretAccessKeyEnc = encrypt(panelSecret);
  }

  const envSecret = envDefaults.secretAccessKey;
  const effectiveSecret = panelSecret || envSecret;
  if (enabled && !effectiveSecret) {
    throw validationError('offsite secret access key is required');
  }

  await upsert(repo, SETTING_KEYS.enabled, enabled ? 'true' : 'false');
  await upsert(repo, SETTING_KEYS.endpoint, endpoint);
  await upsert(repo, SETTING_KEYS.bucket, bucket);
  await upsert(repo, SETTING_KEYS.region, region);
  await upsert(repo, SETTING_KEYS.prefix, prefix);
  await upsert(repo, SETTING_KEYS.accessKeyId, accessKeyId);
  await upsert(repo, SETTING_KEYS.uploadMode, uploadMode);
  await upsert(repo, SETTING_KEYS.artifacts, artifacts);
  await upsert(repo, SETTING_KEYS.retentionDays, String(retentionDays));
  await upsert(repo, SETTING_KEYS.required, required ? 'true' : 'false');
  await upsert(repo, SETTING_KEYS.timeoutMs, String(timeoutMs));

  if (input.clearSecret) {
    await upsert(repo, SETTING_KEYS.secretAccessKeyEnc, '');
  } else if (secretAccessKeyEnc) {
    await upsert(repo, SETTING_KEYS.secretAccessKeyEnc, secretAccessKeyEnc);
  }

  await reloadOffsiteBackupSettings();
  return getOffsiteBackupSettings();
}

export async function recordOffsiteTestResult(ok: boolean, error?: string) {
  const repo = AppDataSource.getRepository(PlatformSetting);
  await upsert(repo, SETTING_KEYS.lastTestAt, new Date().toISOString());
  await upsert(repo, SETTING_KEYS.lastTestOk, ok ? 'true' : 'false');
  await upsert(repo, SETTING_KEYS.lastError, error ? error.slice(0, 1000) : '');
  await reloadOffsiteBackupSettings();
}

export async function recordOffsiteError(error?: string) {
  const repo = AppDataSource.getRepository(PlatformSetting);
  await upsert(repo, SETTING_KEYS.lastError, error ? error.slice(0, 1000) : '');
  await reloadOffsiteBackupSettings();
}

export async function recordOffsiteUploadSuccess() {
  const repo = AppDataSource.getRepository(PlatformSetting);
  await upsert(repo, SETTING_KEYS.lastUploadAt, new Date().toISOString());
  await upsert(repo, SETTING_KEYS.lastError, '');
  await reloadOffsiteBackupSettings();
}

export function assertEndpointSyntax(endpoint: string) {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw validationError('offsite endpoint must be a valid URL');
  }
  if (parsed.username || parsed.password) {
    throw validationError('offsite endpoint must not contain credentials');
  }
  const allowInsecure = envBoolean(process.env.SNAPSHOT_OFFSITE_ALLOW_INSECURE, false);
  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) {
    throw validationError('offsite endpoint must use HTTPS');
  }
  return parsed;
}

function isPrivateIp(address: string) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:');
  }
  return false;
}

/**
 * Best-effort SSRF guard for the admin-supplied endpoint. DNS can still change
 * after validation, so private endpoints remain opt-in for local MinIO.
 */
export async function assertSafeOffsiteEndpoint(endpoint: string) {
  const parsed = assertEndpointSyntax(endpoint);
  if (envBoolean(process.env.SNAPSHOT_OFFSITE_ALLOW_PRIVATE_ENDPOINT, false)) return parsed;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw validationError('offsite endpoint must be a public host');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw validationError('offsite endpoint must not point to a private address');
    }
    return parsed;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw validationError('could not resolve the offsite endpoint host');
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw validationError('offsite endpoint must not resolve to a private address');
  }
  return parsed;
}
