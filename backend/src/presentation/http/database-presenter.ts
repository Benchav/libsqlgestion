import { buildDatabaseConnectionUrls } from '../../application/databases/connection-url';
import { getRuntimeProvider, resolveEffectiveDatabaseType } from '../../application/databases/database-runtime';

type DatabaseLike = {
  id: string;
  name: string;
  type: string;
  status?: string;
  url?: string | null;
  subdomain?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function presentDatabase<T extends DatabaseLike>(database: T) {
  const urls = buildDatabaseConnectionUrls(database);
  const runtimeProvider = getRuntimeProvider(database);
  const effectiveType = resolveEffectiveDatabaseType(database);
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
    runtimeHealth: (database as any).metadata?.runtime?.routeHealth,
  };
}
