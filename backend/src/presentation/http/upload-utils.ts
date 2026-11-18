import path from 'path';

export function sanitizeUploadFileName(fileName?: string | null) {
  const normalized = String(fileName || 'database.db').replace(/\\/g, '/');
  const base = path.basename(normalized);
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160);

  return safe || 'database.db';
}

export function resolveImportStagingRoot() {
  const configured = process.env.IMPORT_STAGING_DIR?.trim();
  if (configured) {
    return configured;
  }

  const databaseFile = process.env.DATABASE_FILE?.trim();
  const baseDirectory = databaseFile
    ? path.dirname(databaseFile)
    : path.join(process.cwd(), 'data');

  return path.join(baseDirectory, 'tmp');
}
