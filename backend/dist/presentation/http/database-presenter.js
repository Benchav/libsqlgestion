"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.presentDatabase = presentDatabase;
const connection_url_1 = require("../../application/databases/connection-url");
const database_runtime_1 = require("../../application/databases/database-runtime");
function presentDatabase(database) {
    const urls = (0, connection_url_1.buildDatabaseConnectionUrls)(database);
    const runtimeProvider = (0, database_runtime_1.getRuntimeProvider)(database);
    const effectiveType = (0, database_runtime_1.resolveEffectiveDatabaseType)(database);
    const runtimeStatus = typeof database.status === 'string' ? database.status : 'inactive';
    return {
        ...database,
        effectiveType,
        runtimeProvider: runtimeProvider || (effectiveType === 'sqlite' ? 'local-file' : ''),
        preferredLocalConnectionUrl: urls.internalUrl || urls.backendUrl || database.url || '',
        preferredRemoteConnectionUrl: urls.publicLibsqlUrl || urls.publicHttpsUrl || '',
        connectionUrl: urls.publicLibsqlUrl || urls.publicHttpsUrl || urls.backendUrl,
        publicConnectionUrl: urls.publicHttpsUrl,
        publicHttpsUrl: urls.publicHttpsUrl,
        publicLibsqlUrl: urls.publicLibsqlUrl,
        internalConnectionUrl: urls.internalUrl,
        internalLibsqlUrl: urls.internalUrl,
        backendConnectionUrl: urls.backendUrl,
        backendReachableUrl: urls.backendUrl,
        runtimeStatus,
        exposureMode: effectiveType === 'libsql' ? 'public-runtime' : 'local-file',
        runtimeHealth: database.metadata?.runtime?.routeHealth,
    };
}
