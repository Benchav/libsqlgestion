import crypto from 'crypto';
import { detectMainStatementKeyword } from '../databases/sql-guard';

export function detectOperation(sql: string) {
  const keyword = detectMainStatementKeyword(sql).toLowerCase();
  if (keyword === 'select' || keyword === 'values') return 'select';
  if (keyword === 'insert') return 'insert';
  if (keyword === 'update') return 'update';
  if (keyword === 'delete') return 'delete';
  if (keyword === 'replace') return 'replace';
  if (keyword === 'pragma') return 'pragma';
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
