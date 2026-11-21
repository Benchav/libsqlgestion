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

/**
 * Removes credential material from a project relation before it is serialized
 * into a database or project response. The frontend only needs the owner email.
 */
function gatewayPathPrefix() {
  const raw = (process.env.DATABASE_GATEWAY_PATH || '/gateway/').trim();
  if (!raw) return '/gateway/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export function presentSafeProject(project: any) {
  if (!project || typeof project !== 'object') return project;
  const safeUser = (user: any) => user && typeof user === 'object'
    ? {
      id: user.id,
      email: user.email,
      active: user.active,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }
    : user;
  const owner = safeUser(project.owner);
  const members = Array.isArray(project.members)
    ? project.members.map((member: any) => (
      member && typeof member === 'object'
        ? { ...member, user: safeUser(member.user) }
        : member
    ))
    : project.members;
  return { ...project, owner, members };
}

export function presentDatabase<T extends DatabaseLike>(database: T) {
  const urls = buildDatabaseConnectionUrls(database);
  const runtimeProvider = getRuntimeProvider(database);
  const effectiveType = resolveEffectiveDatabaseType(database);
  const runtimeStatus = typeof database.status === 'string' ? database.status : 'inactive';
  const embeddedReplicaSupported = runtimeProvider === 'docker-libsql' || runtimeProvider === 'sqld-namespace';
  const gatewayEnabledForProvider = ['true', '1', 'yes', 'on'].includes(
    String(process.env.DATABASE_GATEWAY_ENABLED || '').trim().toLowerCase(),
  )
    && Boolean(process.env.GATEWAY_INTERNAL_TOKEN?.trim())
    && effectiveType === 'libsql'
    && (runtimeProvider === 'docker-libsql' || runtimeProvider === 'sqld-namespace');
  const gatewayPath = gatewayPathPrefix();
  const gatewayRootHost = (() => {
    const raw = (process.env.DATABASE_GATEWAY_ROOT_HOST || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
        .toLowerCase()
        .replace(/\.$/, '');
    } catch {
      return raw.toLowerCase().replace(/\.$/, '');
    }
  })();
  const publicHostnames = (() => {
    const hosts: string[] = [];
    for (const value of [urls.publicHttpsUrl, urls.publicLibsqlUrl]) {
      if (!value) continue;
      try {
        hosts.push(new URL(value).hostname.toLowerCase().replace(/\.$/, ''));
      } catch {
        // Ignore malformed legacy URLs; the path gateway can still be used.
      }
    }
    return hosts;
  })();
  const publicUrlIsRoot = (() => {
    for (const value of [urls.publicHttpsUrl, urls.publicLibsqlUrl]) {
      if (!value) continue;
      try {
        const pathname = new URL(value).pathname;
        return pathname === '' || pathname === '/';
      } catch {
        // Ignore malformed legacy URLs.
      }
    }
    return false;
  })();
  const rootGateway = gatewayEnabledForProvider
    && ['true', '1', 'yes', 'on'].includes(
      String(process.env.GATEWAY_ALLOW_ROOT || '').trim().toLowerCase(),
    )
    && Boolean(gatewayRootHost)
    && publicHostnames.length > 0
    && publicHostnames.every((host) => host === gatewayRootHost)
    && publicUrlIsRoot;
  const gatewayHttpsUrl = gatewayEnabledForProvider
    ? (rootGateway
      ? urls.publicHttpsUrl
      : (urls.publicHttpsUrl
        ? `${urls.publicHttpsUrl.replace(/\/+$/, '')}${gatewayPath}`
        : ''))
    : '';
  const gatewayLibsqlUrl = gatewayEnabledForProvider
    ? (rootGateway
      ? urls.publicLibsqlUrl
      : (urls.publicLibsqlUrl
        ? `${urls.publicLibsqlUrl.replace(/\/+$/, '')}${gatewayPath}`
        : ''))
    : '';
  const gatewayMode = rootGateway ? 'root' : (gatewayHttpsUrl || gatewayLibsqlUrl ? 'path' : 'none');

  // Never expose the encrypted credential through the API. The plaintext token
  // is only returned by the explicit reveal/rotate/invalidate endpoints.
  const safeDatabase = { ...database } as Record<string, unknown>;
  delete safeDatabase.encryptedToken;
  if (safeDatabase.project) {
    safeDatabase.project = presentSafeProject(safeDatabase.project);
  }

  return {
    ...safeDatabase,
    effectiveType,
    runtimeProvider: runtimeProvider || (effectiveType === 'sqlite' ? 'local-file' : ''),
    connectionUrl: urls.publicHttpsUrl || urls.publicLibsqlUrl || urls.backendUrl,
    publicConnectionUrl: urls.publicHttpsUrl,
    publicHttpsUrl: urls.publicHttpsUrl,
    publicLibsqlUrl: urls.publicLibsqlUrl,
    // `TURSO_SYNC_URL` for an embedded replica. Empty for LOCAL-FILE because
    // that mode only implements the HTTP pipeline, not libSQL replication.
    syncUrl: embeddedReplicaSupported ? (urls.syncUrl || urls.publicHttpsUrl || urls.publicLibsqlUrl || '') : '',
    embeddedReplicaSupported,
    internalConnectionUrl: urls.internalUrl,
    internalLibsqlUrl: urls.internalUrl,
    backendConnectionUrl: urls.backendUrl,
    backendReachableUrl: urls.backendUrl,
    gatewayEnabled: Boolean(gatewayHttpsUrl || gatewayLibsqlUrl),
    gatewayMode,
    gatewayHttpsUrl,
    gatewayLibsqlUrl,
    runtimeStatus,
    exposureMode: effectiveType === 'libsql' ? 'public-runtime' : 'local-file',
    runtimeHealth: (database as any).metadata?.runtime?.routeHealth,
  };
}
