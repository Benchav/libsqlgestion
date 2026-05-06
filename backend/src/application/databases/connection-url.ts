type ConnectionUrlDatabase = {
  id: string;
  name: string;
  type: string;
  url?: string | null;
  subdomain?: string | null;
};

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
  const template = process.env.DATABASE_PUBLIC_URL_TEMPLATE?.trim();

  if (database.type === 'sqlite' && database.subdomain) {
    if (template) {
      return applyTemplate(template, database);
    }
    return `libsql://${database.subdomain}.libsqlite.local`;
  }

  if (database.url) {
    if (template && (database.type === 'libsql' || database.type === 'remote')) {
      return database.url;
    }
    return database.url;
  }

  if (template && database.subdomain) {
    return applyTemplate(template, database);
  }

  return database.subdomain ? `libsql://${database.subdomain}.libsqlite.local` : '';
}