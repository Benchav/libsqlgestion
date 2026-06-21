import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../sqlite/SqliteClient';
import { createLibsqlClient } from '../libsql/LibsqlClient';
import { decrypt } from '../crypto';

type PooledClient = {
  client: SqliteClient | ReturnType<typeof createLibsqlClient>;
  type: 'sqlite' | 'libsql';
  lastUsed: number;
};

function isRemoteUrl(url: string) {
  return /^(https?|libsql):\/\//.test(url);
}

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

  private createClient(database: Database): PooledClient {
    const effectiveType = this.resolveEffectiveType(database);

    if (effectiveType === 'sqlite') {
      const filePath = database.url || '';
      if (!filePath) {
        throw new Error(`Database ${database.id} has no file path configured`);
      }
      const client = new SqliteClient(filePath);
      return { client, type: 'sqlite', lastUsed: Date.now() };
    }

    if (!database.url || !database.encryptedToken) {
      throw new Error(`Database ${database.id} is missing url or token for libsql connection`);
    }

    const token = decrypt(database.encryptedToken);
    const client = createLibsqlClient(database.url, token);
    return { client, type: 'libsql', lastUsed: Date.now() };
  }

  private resolveEffectiveType(database: Database): 'sqlite' | 'libsql' {
    if (database.type !== 'sqlite' && database.type !== 'libsql') {
      return database.type as any;
    }

    if (database.type === 'sqlite') {
      return 'sqlite';
    }

    const url = database.url || '';
    if (!isRemoteUrl(url)) {
      return 'sqlite';
    }

    const runtime = database.metadata?.runtime as { provider?: unknown } | undefined;
    if (runtime?.provider !== 'docker-libsql') {
      return 'sqlite';
    }

    return 'libsql';
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
