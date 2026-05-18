type ConnectionUrlDatabase = {
  id: string;
  name: string;
  type: string;
  url?: string | null;
  subdomain?: string | null;
  metadata?: Record<string, unknown> | null;
};

type ConnectionUrls = {
  publicUrl: string;
  internalUrl: string;
  backendUrl: string;
};

import { getPublicDatabaseSettings } from '../settings/PlatformSettingsService';

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
}

function applyTemplate(template: string, database: ConnectionUrlDatabase) {
  const values = {
    '{subdomain}': encodeURIComponent(database.subdomain || ''),
    '{name}': encodeURIComponent(database.name),
    '{id}': encodeURIComponent(database.id),
    '{slug}': encodeURIComponent(database.subdomain || database.name),
  } as const;

  let result = template.trim();
  for (const [placeholder, value] of Object.entries(values)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

export function buildDatabaseConnectionUrl(database: ConnectionUrlDatabase) {
  return buildDatabaseConnectionUrls(database).publicUrl;
}

export function buildDatabaseConnectionUrls(database: ConnectionUrlDatabase): ConnectionUrls {
  const settings = getPublicDatabaseSettings();
  const template = settings.template || process.env.DATABASE_PUBLIC_URL_TEMPLATE?.trim();
  const baseUrl = settings.baseUrl || process.env.DATABASE_PUBLIC_BASE_URL?.trim();
  const publicDomain = settings.domain || process.env.DATABASE_PUBLIC_DOMAIN?.trim();
  const publicProtocol = settings.protocol || process.env.DATABASE_PUBLIC_PROTOCOL?.trim() || 'https';
  const runtimeUrls = getRuntimeUrls(database);
  const internalUrl = database.subdomain ? `libsql://${database.subdomain}.libsqlite.local` : database.url || '';

  const domainUrl = publicDomain && database.subdomain
    ? `${publicProtocol}://${database.subdomain}.${publicDomain.replace(/^\.+/, '')}`
    : '';

  if (runtimeUrls) {
    const publicUrl = template
      ? applyTemplate(template, database)
      : baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/${slugify(database.name)}`
        : domainUrl || runtimeUrls.publicUrl;

    return {
      publicUrl,
      internalUrl: runtimeUrls.internalUrl,
      backendUrl: runtimeUrls.backendUrl,
    };
  }

  if (database.type === 'sqlite' && database.subdomain) {
    if (template) {
      return {
        publicUrl: applyTemplate(template, database),
        internalUrl,
        backendUrl: internalUrl,
      };
    }
    if (baseUrl) {
      return {
        publicUrl: `${baseUrl.replace(/\/$/, '')}/${slugify(database.name)}`,
        internalUrl,
        backendUrl: internalUrl,
      };
    }
    if (domainUrl) {
      return {
        publicUrl: domainUrl,
        internalUrl,
        backendUrl: internalUrl,
      };
    }
    return {
      publicUrl: internalUrl,
      internalUrl,
      backendUrl: internalUrl,
    };
  }

  if (database.url) {
    if (template && (database.type === 'libsql' || database.type === 'remote')) {
      return {
        publicUrl: database.url,
        internalUrl: database.url,
        backendUrl: database.url,
      };
    }
    return {
      publicUrl: database.url,
      internalUrl: database.url,
      backendUrl: database.url,
    };
  }

  if (template && database.subdomain) {
    return {
      publicUrl: applyTemplate(template, database),
      internalUrl,
      backendUrl: internalUrl,
    };
  }

  if (baseUrl && database.subdomain) {
    return {
      publicUrl: `${baseUrl.replace(/\/$/, '')}/${slugify(database.name)}`,
      internalUrl,
      backendUrl: internalUrl,
    };
  }

  if (domainUrl) {
    return {
      publicUrl: domainUrl,
      internalUrl,
      backendUrl: internalUrl,
    };
  }

  return {
    publicUrl: internalUrl,
    internalUrl,
    backendUrl: internalUrl,
  };
}

function getRuntimeUrls(database: ConnectionUrlDatabase) {
  const runtime = database.metadata?.runtime as { connectionUrl?: unknown; internalUrl?: unknown; publicUrl?: unknown } | undefined;
  if (!runtime) {
    return null;
  }

  const settings = getPublicDatabaseSettings();
  const template = settings.template || process.env.DATABASE_PUBLIC_URL_TEMPLATE?.trim();
  const baseUrl = settings.baseUrl || process.env.DATABASE_PUBLIC_BASE_URL?.trim();

  const backendUrl = typeof runtime.connectionUrl === 'string'
    ? runtime.connectionUrl
    : typeof runtime.publicUrl === 'string'
      ? runtime.publicUrl
      : typeof runtime.internalUrl === 'string'
        ? runtime.internalUrl
        : null;

  const publicUrl = template || baseUrl
    ? (template ? applyTemplate(template, database) : `${baseUrl!.replace(/\/$/, '')}/${slugify(database.name)}`)
    : typeof runtime.publicUrl === 'string'
      ? runtime.publicUrl
      : backendUrl;

  const internalUrl = typeof runtime.internalUrl === 'string'
    ? runtime.internalUrl
    : typeof runtime.publicUrl === 'string'
      ? runtime.publicUrl
      : typeof runtime.connectionUrl === 'string'
        ? runtime.connectionUrl
        : null;

  if (!publicUrl || !internalUrl || !backendUrl) {
    return null;
  }

  return { publicUrl, internalUrl, backendUrl };
}
