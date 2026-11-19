import path from 'path';

function safeSegment(value: string, label: string) {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`invalid ${label} for offsite object key`);
  }
  return normalized;
}

/**
 * Human-readable, stable-enough folder segment. Names are preferred, but the
 * fallback keeps UUID-only databases usable.
 */
export function offsiteSlug(value: string | null | undefined, fallback: string) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (slug) return slug;
  const fallbackSlug = String(fallback || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return fallbackSlug || 'snapshot';
}

export function offsiteSnapshotStem(databaseSlug: string, takenAt: Date | string, snapshotId: string) {
  const date = new Date(takenAt);
  const validDate = Number.isFinite(date.getTime()) ? date : new Date();
  const stamp = validDate.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const shortId = String(snapshotId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'snapshot';
  return `${databaseSlug}_${stamp}_${shortId}`;
}

export function offsiteHumanPrefix(input: {
  prefix: string;
  projectSlug: string;
  databaseSlug: string;
}) {
  const parts = [
    input.prefix.trim().replace(/^\/+|\/+$/g, ''),
    safeSegment(input.projectSlug, 'projectSlug'),
    safeSegment(input.databaseSlug, 'databaseSlug'),
  ].filter(Boolean);
  return parts.join('/');
}

export function offsiteDatabasePrefix(input: {
  prefix: string;
  databaseSlug: string;
}) {
  const parts = [
    input.prefix.trim().replace(/^\/+|\/+$/g, ''),
    safeSegment(input.databaseSlug, 'databaseSlug'),
  ].filter(Boolean);
  return parts.join('/');
}

export function offsiteHumanArtifactKey(snapshotPrefix: string, stem: string, extension: 'db' | 'sql') {
  return `${snapshotPrefix}/${safeSegment(stem, 'artifact stem')}.${extension}`;
}

export function offsiteHumanManifestKey(snapshotPrefix: string, stem: string) {
  return `${snapshotPrefix}/${safeSegment(stem, 'artifact stem')}.manifest.json`;
}

export function offsiteSnapshotPrefix(input: {
  prefix: string;
  projectId: string;
  databaseId: string;
  snapshotId: string;
}) {
  const parts = [
    input.prefix.trim().replace(/^\/+|\/+$/g, ''),
    safeSegment(input.projectId, 'projectId'),
    safeSegment(input.databaseId, 'databaseId'),
    safeSegment(input.snapshotId, 'snapshotId'),
  ].filter(Boolean);
  return parts.join('/');
}

export function offsiteArtifactKey(snapshotPrefix: string, fileName: string) {
  const baseName = path.basename(fileName);
  if (!baseName || baseName !== fileName || /[\\/]/.test(fileName)) {
    throw new Error('invalid snapshot file name for offsite object key');
  }
  return `${snapshotPrefix}/${baseName}`;
}

export function offsiteManifestKey(snapshotPrefix: string) {
  return `${snapshotPrefix}/manifest.json`;
}

export function offsiteContentType(kind: 'db' | 'sql' | 'manifest') {
  if (kind === 'sql') return 'application/sql; charset=utf-8';
  if (kind === 'manifest') return 'application/json';
  return 'application/vnd.sqlite3';
}
