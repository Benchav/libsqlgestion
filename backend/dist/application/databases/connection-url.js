"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDatabaseConnectionUrl = buildDatabaseConnectionUrl;
function applyTemplate(template, database) {
    const values = {
        '{subdomain}': encodeURIComponent(database.subdomain || ''),
        '{name}': encodeURIComponent(database.name),
        '{id}': encodeURIComponent(database.id),
        '{slug}': encodeURIComponent(database.subdomain || database.name),
    };
    let result = template.trim();
    for (const [placeholder, value] of Object.entries(values)) {
        result = result.replaceAll(placeholder, value);
    }
    return result;
}
function buildDatabaseConnectionUrl(database) {
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
