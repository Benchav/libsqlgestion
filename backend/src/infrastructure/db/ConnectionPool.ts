import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../sqlite/SqliteClient';
import { createLibsqlClient } from '../libsql/LibsqlClient';
import { decrypt } from '../crypto';
import { getRuntimeConnectionUrl, resolveEffectiveDatabaseType } from '../../application/databases/database-runtime';
import { resolveLocalDatabasePath } from '../../application/databases/local-database-path';

type PooledClient = {
  client: SqliteClient | ReturnType<typeof createLibsqlClient>;
  type: 'sqlite' | 'libsql';
  lastUsed: number;
};

export class ConnectionPool {
  private static instance: ConnectionPool;
  private readonly pool = new Map<string, PooledClient>();
  private readonly maxSize = Math.max(1, Number(process.env.DB_CONNECTION_POOL_MAX_SIZE || 256));
  private readonly idleTtlMs = Math.max(1000, Number(process.env.DB_CONNECTION_POOL_IDLE_TTL_MS || 30 * 60 * 1000));
  private lastSweepAt = 0;

  private constructor() {}

  static getInstance(): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool();
    }
    return ConnectionPool.instance;
  }

  getClient(database: Database): SqliteClient | ReturnType<typeof createLibsqlClient> {
    this.sweepIdleConnections();

    const existing = this.pool.get(database.id);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    this.ensureCapacity();
    const entry = this.createClient(database);
    this.pool.set(database.id, entry);
    return entry.client;
  }

  getSqliteClient(database: Database): SqliteClient {
    const client = this.getClient(database);
    if (!(client instanceof SqliteClient)) {
      throw new Error(`Database ${database.id} is not a local SQLite database`);
    }
    return client;
  }

  evict(databaseId: string): void {
    const entry = this.pool.get(databaseId);
    if (!entry) return;

    this.pool.delete(databaseId);
    void this.closeClient(entry);
  }

  evictOnError(databaseId: string, error: unknown): void {
    if (!this.isFatalError(error)) return;
    this.evict(databaseId);
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.pool.entries());
    this.pool.clear();

    for (const [, entry] of entries) {
      await this.closeClient(entry);
    }
  }

  get size(): number {
    return this.pool.size;
  }

  get stats() {
    return {
      size: this.pool.size,
      maxSize: this.maxSize,
      idleTtlMs: this.idleTtlMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  createDedicatedSqliteClient(database: Database): SqliteClient {
    return new SqliteClient(this.resolveSqliteFilePath(database));
  }

  private createClient(database: Database): PooledClient {
    const effectiveType = resolveEffectiveDatabaseType(database);

    if (effectiveType === 'sqlite') {
      const client = new SqliteClient(this.resolveSqliteFilePath(database));
      return { client, type: 'sqlite', lastUsed: Date.now() };
    }

    if (!database.url || !database.encryptedToken) {
      throw new Error(`Database ${database.id} is missing url or token for libsql connection`);
    }

    const connectionUrl = getRuntimeConnectionUrl(database);
    if (!connectionUrl) {
      throw new Error(`Database ${database.id} is missing runtime connection url for libsql connection`);
    }

    let token = '';
    try {
      token = decrypt(database.encryptedToken);
    } catch (err: any) {
      throw new Error(`Failed to decrypt database token: ${err?.message || err}. Check MASTER_KEY.`);
    }

    const client = createLibsqlClient(connectionUrl, token);
    return { client, type: 'libsql', lastUsed: Date.now() };
  }

  private resolveSqliteFilePath(database: Database): string {
    try {
      const filePath = resolveLocalDatabasePath(database, { createIfMissing: true });
      if (!filePath) {
        throw new Error('path could not be resolved');
      }
      return filePath;
    } catch (err: any) {
      throw new Error(`Database ${database.id} file is missing and could not be initialized: ${err?.message || err}`);
    }
  }

  private async closeClient(entry: PooledClient): Promise<void> {
    try {
      if (entry.type === 'sqlite') {
        await (entry.client as SqliteClient).close();
      } else {
        (entry.client as ReturnType<typeof createLibsqlClient>).close();
      }
    } catch {
    }
  }

  private isFatalError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return (
      msg.includes('sqlite_notadb') ||
      msg.includes('sqlite_corrupt') ||
      msg.includes('sqlite_cantopen') ||
      msg.includes('not a database') ||
      msg.includes('database disk image is malformed')
    );
  }

  private sweepIdleConnections() {
    const now = Date.now();
    if (now - this.lastSweepAt < 30_000) {
      return;
    }

    this.lastSweepAt = now;
    for (const [databaseId, entry] of this.pool.entries()) {
      if (now - entry.lastUsed <= this.idleTtlMs) {
        continue;
      }

      this.pool.delete(databaseId);
      void this.closeClient(entry);
    }
  }

  private ensureCapacity() {
    if (this.pool.size < this.maxSize) {
      return;
    }

    const oldest = Array.from(this.pool.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!oldest) {
      return;
    }

    this.pool.delete(oldest[0]);
    void this.closeClient(oldest[1]);
  }
}
