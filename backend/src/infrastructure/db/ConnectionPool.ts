import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../sqlite/SqliteClient';
import { createLibsqlClient } from '../libsql/LibsqlClient';
import { decrypt } from '../crypto';

type PooledClient = {
  client: SqliteClient | ReturnType<typeof createLibsqlClient>;
  type: 'sqlite' | 'libsql';
  lastUsed: number;
};

/**
 * Singleton connection pool that keeps database clients alive across requests.
 *
 * Instead of opening and closing a connection on every single query
 * (which caused the 8-10 second latency), the pool caches clients by
 * database ID and reuses them.
 *
 * Safety:
 * - `evict(id)` MUST be called before deleting a database or rotating its token.
 * - `shutdown()` closes everything cleanly on process exit.
 * - Corrupted connections are automatically evicted on critical errors.
 */
export class ConnectionPool {
  private static instance: ConnectionPool;
  private readonly pool = new Map<string, PooledClient>();
  private readonly maxSize = Math.max(1, Number(process.env.DB_CONNECTION_POOL_MAX_SIZE || 128));
  private readonly idleTtlMs = Math.max(1000, Number(process.env.DB_CONNECTION_POOL_IDLE_TTL_MS || 15 * 60 * 1000));
  private lastSweepAt = 0;

  private constructor() {}

  static getInstance(): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool();
    }
    return ConnectionPool.instance;
  }

  /**
   * Returns a cached client for the given database, or creates one if it
   * doesn't exist yet. The client is kept alive for future requests.
   */
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

  /**
   * Returns a typed SQLite client from the pool.
   * Use this when you need SqliteClient-specific methods (all, get, run, exec).
   */
  getSqliteClient(database: Database): SqliteClient {
    const client = this.getClient(database);
    if (!(client instanceof SqliteClient)) {
      throw new Error(`Database ${database.id} is not a local SQLite database`);
    }
    return client;
  }

  /**
   * Closes and removes a specific database connection from the pool.
   * MUST be called before deleting a database or rotating its token.
   */
  evict(databaseId: string): void {
    const entry = this.pool.get(databaseId);
    if (!entry) return;

    this.pool.delete(databaseId);
    void this.closeClient(entry);
  }

  /**
   * Evict a connection only if it's been corrupted or errored fatally.
   * Called automatically by services when they catch non-recoverable errors.
   */
  evictOnError(databaseId: string, error: unknown): void {
    if (!this.isFatalError(error)) return;
    this.evict(databaseId);
  }

  /**
   * Closes all pooled connections. Called on SIGTERM/SIGINT for clean shutdown.
   */
  async shutdown(): Promise<void> {
    const entries = Array.from(this.pool.entries());
    this.pool.clear();

    for (const [, entry] of entries) {
      await this.closeClient(entry);
    }
  }

  /**
   * Returns the number of active connections (useful for monitoring).
   */
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

  private createClient(database: Database): PooledClient {
    if (database.type === 'sqlite') {
      const filePath = database.url || '';
      const client = new SqliteClient(filePath);
      return { client, type: 'sqlite', lastUsed: Date.now() };
    }

    // libsql / remote
    if (!database.url || !database.encryptedToken) {
      throw new Error(`Database ${database.id} is missing url or token for libsql connection`);
    }

    const token = decrypt(database.encryptedToken);
    const client = createLibsqlClient(database.url, token);
    return { client, type: 'libsql', lastUsed: Date.now() };
  }

  private async closeClient(entry: PooledClient): Promise<void> {
    try {
      if (entry.type === 'sqlite') {
        await (entry.client as SqliteClient).close();
      } else {
        (entry.client as ReturnType<typeof createLibsqlClient>).close();
      }
    } catch {
      // Best-effort close — connection may already be broken.
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
