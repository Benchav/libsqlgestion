import { Database } from '../../domain/entities/Database';
import { getRuntimeProvider, resolveEffectiveDatabaseType } from './database-runtime';
import { classifySqlStatement } from './sql-guard';
import { splitSqlStatements } from './sqlScript';

export type DatabaseProtectionFlags = {
  blockReads?: boolean;
  blockWrites?: boolean;
  deleteProtection?: boolean;
};

export type TokenInvalidationScope = 'all' | 'panel-only' | 'unsupported';

export class DatabaseProtectionError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'DatabaseProtectionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function databaseRuntimeProvider(
  database: Pick<Database, 'type' | 'url' | 'metadata'>,
) {
  const provider = getRuntimeProvider(database);
  if (provider) return provider;
  const effectiveType = resolveEffectiveDatabaseType(database);
  return effectiveType === 'sqlite' ? 'local-file' : effectiveType;
}

export function tokenInvalidationScope(
  database: Pick<Database, 'type' | 'url' | 'metadata'>,
): TokenInvalidationScope {
  const provider = databaseRuntimeProvider(database);
  if (provider === 'sqld-namespace') return 'panel-only';
  if (provider === 'local-file' || provider === 'docker-libsql') return 'all';
  return 'unsupported';
}

export function assertDatabaseReadsAllowed(database: Pick<Database, 'blockReads'>) {
  if (!database.blockReads) return;
  throw new DatabaseProtectionError(
    403,
    'DATABASE_READS_BLOCKED',
    'Read operations are blocked for this database. Disable Block Reads before retrying.',
  );
}

export function assertDatabaseWritesAllowed(database: Pick<Database, 'blockWrites'>) {
  if (!database.blockWrites) return;
  throw new DatabaseProtectionError(
    403,
    'DATABASE_WRITES_BLOCKED',
    'Write operations are blocked for this database. Disable Block Writes before retrying.',
  );
}

export function assertDatabaseDeleteAllowed(database: Pick<Database, 'deleteProtection'>) {
  if (!database.deleteProtection) return;
  throw new DatabaseProtectionError(
    409,
    'DATABASE_DELETE_PROTECTED',
    'Delete Protection is enabled for this database. Disable it before deleting.',
  );
}

/**
 * Validates every statement before the caller starts executing. This is
 * deliberately all-or-nothing: a batch containing one forbidden statement must
 * not leave earlier statements committed.
 */
export function assertDatabaseSqlAllowed(
  database: Pick<Database, 'blockReads' | 'blockWrites'>,
  sql: string,
) {
  if (!database.blockReads && !database.blockWrites) return;

  for (const statement of splitSqlStatements(sql)) {
    const classification = classifySqlStatement(statement);

    if (classification.operation === 'neutral') continue;

    if (
      database.blockWrites
      && (classification.operation === 'write' || classification.operation === 'unknown')
    ) {
      throw new DatabaseProtectionError(
        403,
        'DATABASE_WRITES_BLOCKED',
        'Write operations are blocked for this database. Disable Block Writes before retrying.',
      );
    }

    if (
      database.blockReads
      && (
        classification.operation === 'read'
        || classification.returnsRows
        || classification.operation === 'unknown'
      )
    ) {
      throw new DatabaseProtectionError(
        403,
        'DATABASE_READS_BLOCKED',
        'Read operations are blocked for this database. Disable Block Reads before retrying.',
      );
    }
  }
}
