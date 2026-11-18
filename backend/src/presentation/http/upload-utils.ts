import fs from 'fs';
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

export async function cleanupStaleUploadDirs(
  stagingRoot: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
) {
  try {
    const entries = await fs.promises.readdir(stagingRoot, { withFileTypes: true });
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('upload-'))
      .map(async (entry) => {
        const directory = path.join(stagingRoot, entry.name);
        try {
          const stat = await fs.promises.stat(directory);
          if (stat.mtimeMs < cutoff) {
            await fs.promises.rm(directory, { recursive: true, force: true });
          }
        } catch {
          // Best effort: another request may have removed it concurrently.
        }
      }));
  } catch {
    // Best effort: staging may not exist yet.
  }
}
