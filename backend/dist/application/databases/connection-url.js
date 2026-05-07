"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDatabaseConnectionUrl = buildDatabaseConnectionUrl;
exports.buildDatabaseConnectionUrls = buildDatabaseConnectionUrls;
function slugify(value) {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 48);
}
function applyTemplate(template, database) {
    const values = {
        '{subdomain}': encodeURIComponent(database.subdomain || ''),
        '{name}': encodeURIComponent(database.name),
        '{id}': encodeURIComponent(database.id),
        '{slug}': encodeURIComponent(database.subdomain || database.name),
    };
    let result = template.trim();
    for (const [placeholder, value] of Object.entries(values)) {
        result = result.split(placeholder).join(value);
    }
    return result;
}
function buildDatabaseConnectionUrl(database) {
    return buildDatabaseConnectionUrls(database).publicUrl;
}
function buildDatabaseConnectionUrls(database) {
    const template = process.env.DATABASE_PUBLIC_URL_TEMPLATE?.trim();
    const baseUrl = process.env.DATABASE_PUBLIC_BASE_URL?.trim();
    const runtimeUrl = getRuntimeUrl(database);
    const internalUrl = database.subdomain ? `libsql://${database.subdomain}.libsqlite.local` : database.url || '';
    if (runtimeUrl) {
        return {
            publicUrl: runtimeUrl,
            internalUrl: runtimeUrl,
        };
    }
    if (database.type === 'sqlite' && database.subdomain) {
        if (template) {
            return {
                publicUrl: applyTemplate(template, database),
                internalUrl,
            };
        }
        if (baseUrl) {
            return {
                publicUrl: `${baseUrl.replace(/\/$/, '')}/${slugify(database.name)}`,
                internalUrl,
            };
        }
        return {
            publicUrl: internalUrl,
            internalUrl,
        };
    }
    if (database.url) {
        if (template && (database.type === 'libsql' || database.type === 'remote')) {
            return {
                publicUrl: database.url,
                internalUrl: database.url,
            };
        }
        return {
            publicUrl: database.url,
            internalUrl: database.url,
        };
    }
    if (template && database.subdomain) {
        return {
            publicUrl: applyTemplate(template, database),
            internalUrl,
        };
    }
    if (baseUrl && database.subdomain) {
        return {
            publicUrl: `${baseUrl.replace(/\/$/, '')}/${slugify(database.name)}`,
            internalUrl,
        };
    }
    return {
        publicUrl: internalUrl,
        internalUrl,
    };
}
function getRuntimeUrl(database) {
    const runtime = database.metadata?.runtime;
    if (runtime && typeof runtime.connectionUrl === 'string') {
        return runtime.connectionUrl;
    }
    if (runtime && typeof runtime.internalUrl === 'string') {
        return runtime.internalUrl;
    }
    if (runtime && typeof runtime.publicUrl === 'string') {
        return runtime.publicUrl;
    }
    return null;
}
