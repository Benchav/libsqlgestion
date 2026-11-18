import crypto from 'crypto';

export function detectOperation(sql: string) {
  const normalized = sql.trim().toLowerCase();
  if (normalized.startsWith('select') || normalized.startsWith('with')) return 'select';
  if (normalized.startsWith('insert')) return 'insert';
  if (normalized.startsWith('update')) return 'update';
  if (normalized.startsWith('delete')) return 'delete';
  if (normalized.startsWith('pragma')) return 'pragma';
  return 'other';
}

export function normalizeSql(sql: string) {
  const normalized = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g, '?')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.slice(0, 500);
}

export function fingerprintSql(sql: string) {
  return crypto.createHash('sha256').update(normalizeSql(sql)).digest('hex');
}
