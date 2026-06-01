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

const SUBDOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_REGEX = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function ensureSubdomain(baseName: string, uniqueSuffix: string) {
  const slug = slugify(baseName) || 'db';
  return `${slug}-${uniqueSuffix.slice(0, 8)}`;
}

export function normalizeSubdomain(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}

export function isValidSubdomainLabel(value: string) {
  return SUBDOMAIN_LABEL_REGEX.test(value);
}

export function assertValidSubdomainLabel(value: string, fieldName = 'subdomain') {
  const normalized = normalizeSubdomain(value);
  if (!normalized || !isValidSubdomainLabel(normalized)) {
    throw new Error(`${fieldName} must be a valid DNS label`);
  }
  return normalized;
}

export function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
}

export function assertValidDomain(value: string, fieldName = 'domain') {
  const normalized = normalizeDomain(value);
  if (!normalized || !DOMAIN_REGEX.test(normalized)) {
    throw new Error(`${fieldName} must be a valid domain name`);
  }
  return normalized;
}
