import { Database } from '../../domain/entities/Database';

type RuntimeMetadata = {
  provider?: unknown;
  connectionUrl?: unknown;
  internalUrl?: unknown;
  backendUrl?: unknown;
  publicUrl?: unknown;
  databasePath?: unknown;
};

type DatabaseLike = {
  type: string;
  url?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
};

export type EffectiveDatabaseType = 'sqlite' | 'libsql' | 'remote';

export function isRemoteDatabaseUrl(url?: string | null) {
  return Boolean(url && /^(https?|libsql):\/\//.test(url));
}

export function getRuntimeMetadata(database: Pick<DatabaseLike, 'metadata'>): RuntimeMetadata | null {
  const runtime = database.metadata?.runtime as RuntimeMetadata | undefined;
  return runtime && typeof runtime === 'object' ? runtime : null;
}

export function getRuntimeProvider(database: Pick<DatabaseLike, 'metadata'>) {
  const provider = getRuntimeMetadata(database)?.provider;
  return typeof provider === 'string' ? provider : '';
}

export function getRuntimeConnectionUrl(database: Pick<DatabaseLike, 'metadata' | 'url'>) {
  const runtime = getRuntimeMetadata(database);
  const candidates = [runtime?.connectionUrl, runtime?.internalUrl, runtime?.backendUrl, runtime?.publicUrl, database.url];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return '';
}

export function resolveEffectiveDatabaseType(database: DatabaseLike): EffectiveDatabaseType {
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

export function shouldReconcileLegacyLocalDatabase(database: DatabaseLike) {
  return database.type !== 'sqlite' && resolveEffectiveDatabaseType(database) === 'sqlite';
}

export function normalizeLegacyLocalDatabase(database: DatabaseLike) {
  const nextUrl = database.url || '';
  const nextStatus = database.status === 'provisioning' && getRuntimeProvider(database) !== 'docker-libsql'
    ? 'active'
    : database.status;

  return {
    ...database,
    type: 'sqlite' as const,
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
