export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
}

export function ensureSubdomain(baseName: string, uniqueSuffix: string) {
  const slug = slugify(baseName) || 'db';
  return `${slug}-${uniqueSuffix.slice(0, 8)}`;
}
