"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRemoteDatabaseUrl = isRemoteDatabaseUrl;
exports.getRuntimeMetadata = getRuntimeMetadata;
exports.getRuntimeProvider = getRuntimeProvider;
exports.getRuntimeConnectionUrl = getRuntimeConnectionUrl;
exports.resolveEffectiveDatabaseType = resolveEffectiveDatabaseType;
exports.shouldReconcileLegacyLocalDatabase = shouldReconcileLegacyLocalDatabase;
exports.normalizeLegacyLocalDatabase = normalizeLegacyLocalDatabase;
function isRemoteDatabaseUrl(url) {
    return Boolean(url && /^(https?|libsql):\/\//.test(url));
}
function getRuntimeMetadata(database) {
    const runtime = database.metadata?.runtime;
    return runtime && typeof runtime === 'object' ? runtime : null;
}
function getRuntimeProvider(database) {
    const provider = getRuntimeMetadata(database)?.provider;
    return typeof provider === 'string' ? provider : '';
}
function getRuntimeConnectionUrl(database) {
    const runtime = getRuntimeMetadata(database);
    const candidates = [runtime?.connectionUrl, runtime?.internalUrl, runtime?.backendUrl, runtime?.publicUrl, database.url];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate;
        }
    }
    return '';
}
function resolveEffectiveDatabaseType(database) {
    const runtimeProvider = getRuntimeProvider(database);
    const runtimeUrl = getRuntimeConnectionUrl(database);
    if (runtimeProvider === 'docker-libsql' && isRemoteDatabaseUrl(runtimeUrl)) {
        return 'libsql';
    }
    if (database.type === 'remote' && isRemoteDatabaseUrl(database.url)) {
        return 'remote';
    }
    if (database.type === 'libsql' && isRemoteDatabaseUrl(database.url)) {
        return 'libsql';
    }
    return 'sqlite';
}
function shouldReconcileLegacyLocalDatabase(database) {
    return database.type !== 'sqlite' && resolveEffectiveDatabaseType(database) === 'sqlite';
}
function normalizeLegacyLocalDatabase(database) {
    const nextUrl = database.url || '';
    const nextStatus = database.status === 'provisioning' && getRuntimeProvider(database) !== 'docker-libsql'
        ? 'active'
        : database.status;
    return {
        ...database,
        type: 'sqlite',
        status: nextStatus,
        metadata: {
            ...(database.metadata ?? {}),
            runtime: {
                provider: 'local-file',
                databasePath: nextUrl || null,
                connectionUrl: nextUrl || null,
                internalUrl: nextUrl || null,
                publicUrl: nextUrl || null,
            },
        },
    };
}
