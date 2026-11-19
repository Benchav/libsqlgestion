import path from 'path';

function safeSegment(value: string, label: string) {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`invalid ${label} for offsite object key`);
  }
  return normalized;
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
