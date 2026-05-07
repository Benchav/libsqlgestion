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
    const runtimeUrls = getRuntimeUrls(database);
    const internalUrl = database.subdomain ? `libsql://${database.subdomain}.libsqlite.local` : database.url || '';
    if (runtimeUrls) {
        const publicUrl = template
            ? applyTemplate(template, database)
            : baseUrl
                ? `${baseUrl.replace(/\/$/, '')}/${slugify(database.name)}`
                : runtimeUrls.publicUrl;
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
    return {
        publicUrl: internalUrl,
        internalUrl,
        backendUrl: internalUrl,
    };
}
function getRuntimeUrls(database) {
    const runtime = database.metadata?.runtime;
    if (!runtime) {
        return null;
    }
    const template = process.env.DATABASE_PUBLIC_URL_TEMPLATE?.trim();
    const baseUrl = process.env.DATABASE_PUBLIC_BASE_URL?.trim();
    const backendUrl = typeof runtime.connectionUrl === 'string'
        ? runtime.connectionUrl
        : typeof runtime.publicUrl === 'string'
            ? runtime.publicUrl
            : typeof runtime.internalUrl === 'string'
                ? runtime.internalUrl
                : null;
    const publicUrl = template || baseUrl
        ? (template ? applyTemplate(template, database) : `${baseUrl.replace(/\/$/, '')}/${slugify(database.name)}`)
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
