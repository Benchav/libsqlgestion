import path from 'path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a value looks like an internal UUID rather than a human name.
 * Used to avoid showing raw IDs in analytics and to stop imports from using
 * UUID-shaped file names as database names.
 */
export function isUuidLike(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/**
 * Derives the initial database name from an explicit name, the uploaded file
 * name, or a server path. UUID-shaped file names are treated as internal IDs
 * and replaced with a neutral name so the UI never defaults to a raw UUID.
 */
export function deriveDatabaseName(name?: string, sourceName?: string, sourcePath?: string): string {
  const explicitName = name?.trim();
  if (explicitName) return explicitName;

  const candidate = sourceName || (sourcePath ? path.basename(sourcePath) : '');
  const derived = candidate.replace(/\.[^.]+$/, '').trim();
  if (!derived || isUuidLike(derived)) return 'imported-database';
  return derived;
}
