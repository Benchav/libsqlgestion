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

type SqliteReadPool = {
  clients: SqliteClient[];
  next: number;
  lastUsed: number;
  // Serializes connection growth so two connections never switch an empty
  // database to WAL at the same time (which returns SQLITE_BUSY).
  creating: Promise<void>;
};

export class ConnectionPool {
  private static instance: ConnectionPool;
  private readonly pool = new Map<string, PooledClient>();
  // SQLite allows concurrent readers in WAL mode, but a single sqlite3
  // connection serializes every statement. Dedicated read connections let the
  // Studio and API serve independent queries in parallel without touching the
  // single-writer connection.
  private readonly readPool = new Map<string, SqliteReadPool>();
  private readonly maxSize = Math.max(1, Number(process.env.DB_CONNECTION_POOL_MAX_SIZE || 256));
  private readonly readPoolSize = Math.max(1, Number(process.env.SQLITE_READ_POOL_SIZE || 4));
  private readonly idleTtlMs = Math.max(1000, Number(process.env.DB_CONNECTION_POOL_IDLE_TTL_MS || 30 * 60 * 1000));
  private readonly pendingCloses = new Set<Promise<void>>();
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

  /**
   * Returns a connection suitable for read-only work. Remote libSQL clients
   * already multiplex over HTTP, so they keep using the shared client. Local
   * SQLite gets a bounded pool of WAL readers.
   */
  async getReadClient(
    database: Database,
    retry = 0,
  ): Promise<SqliteClient | ReturnType<typeof createLibsqlClient>> {
    if (resolveEffectiveDatabaseType(database) !== 'sqlite') {
      return this.getClient(database);
    }

    this.sweepIdleConnections();
    this.ensureCapacity();

    let pool = this.readPool.get(database.id);
    if (!pool) {
      pool = {
        clients: [],
        next: 0,
        lastUsed: Date.now(),
        creating: Promise.resolve(),
      };
      this.readPool.set(database.id, pool);
    }

    if (pool.clients.length < this.readPoolSize) {
      const activePool = pool;
      const creation = activePool.creating
        .catch(() => undefined)
        .then(async () => {
          if (activePool.clients.length >= this.readPoolSize) return;
          const client = new SqliteClient(this.resolveSqliteFilePath(database), {
            queryOnly: Boolean(database.blockWrites),
          });
          // This SELECT is queued after the constructor's PRAGMA sequence on
          // the same connection, so WAL/busy_timeout are applied before the
          // connection joins the pool.
          await client.all('SELECT 1');

          if (this.readPool.get(database.id) !== activePool) {
            // A rotation or conversion evicted the database while this
            // connection was opening. Do not leak it into an orphaned pool.
            await client.close().catch(() => undefined);
            return;
          }
          activePool.clients.push(client);
        });

      activePool.creating = creation;
      try {
        await creation;
      } catch (error) {
        if (activePool.creating === creation) {
          activePool.creating = Promise.resolve();
        }
        throw error;
      }
      if (activePool.creating === creation) {
        activePool.creating = Promise.resolve();
      }
    }

    const currentPool = this.readPool.get(database.id);
    if (!currentPool || currentPool.clients.length === 0) {
      if (retry >= 1) {
        throw new Error(`Database ${database.id} was evicted while opening a read connection`);
      }
      return this.getReadClient(database, retry + 1);
    }

    const client = currentPool.clients[currentPool.next % currentPool.clients.length];
    currentPool.next += 1;
    currentPool.lastUsed = Date.now();
    return client;
  }

  /**
   * Applies the write-block flag to connections that are already open.
   *
   * This is a defence-in-depth layer behind the SQL classifier. A statement
   * already executing may finish; every following statement on the connection
   * is rejected by SQLite itself.
   */
  async setQueryOnly(databaseId: string, enabled: boolean): Promise<void> {
    const work: Array<Promise<void>> = [];
    const entry = this.pool.get(databaseId);
    if (entry?.type === 'sqlite') {
      work.push((entry.client as SqliteClient).setQueryOnly(enabled));
    }

    const readPool = this.readPool.get(databaseId);
    if (readPool) {
      for (const client of readPool.clients) {
        work.push(client.setQueryOnly(enabled));
      }
    }

    if (work.length === 0) return;
    const results = await Promise.allSettled(work);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure && failure.status === 'rejected') {
      throw failure.reason;
    }
  }

  evict(databaseId: string): void {
    const entry = this.pool.get(databaseId);
    const readClients = this.readPool.get(databaseId);
    this.readPool.delete(databaseId);

    if (!entry && !readClients) return;
    if (entry) this.pool.delete(databaseId);
    if (entry) this.trackClose(this.closeClient(entry));
    if (readClients) this.trackClose(this.closeReadPool(readClients));
  }

  evictOnError(databaseId: string, error: unknown): void {
    if (!this.isFatalError(error)) return;
    this.evict(databaseId);
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.pool.entries());
    const readPools = Array.from(this.readPool.values());
    this.pool.clear();
    this.readPool.clear();

    for (const [, entry] of entries) {
      await this.closeClient(entry);
    }
    for (const pool of readPools) {
      await this.closeReadPool(pool);
    }

    // Evictions start background closes; graceful shutdown must wait for
    // those handles to be released too.
    if (this.pendingCloses.size > 0) {
      await Promise.allSettled(Array.from(this.pendingCloses));
    }
  }

  get size(): number {
    return this.pool.size;
  }

  get stats() {
    return {
      size: this.pool.size,
      readPoolSize: this.readPoolSize,
      maxSize: this.maxSize,
      idleTtlMs: this.idleTtlMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  createDedicatedSqliteClient(database: Database): SqliteClient {
    return new SqliteClient(this.resolveSqliteFilePath(database), {
      queryOnly: Boolean(database.blockWrites),
    });
  }

  private createClient(database: Database): PooledClient {
    const effectiveType = resolveEffectiveDatabaseType(database);

    if (effectiveType === 'sqlite') {
      const client = new SqliteClient(this.resolveSqliteFilePath(database), {
        queryOnly: Boolean(database.blockWrites),
      });
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

  private async closeReadPool(pool: SqliteReadPool): Promise<void> {
    for (const client of pool.clients) {
      await client.close().catch(() => undefined);
    }
    pool.clients.length = 0;
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
      this.trackClose(this.closeClient(entry));
    }

    for (const [databaseId, pool] of this.readPool.entries()) {
      if (now - pool.lastUsed <= this.idleTtlMs) {
        continue;
      }

      this.readPool.delete(databaseId);
      this.trackClose(this.closeReadPool(pool));
    }
  }

  private trackClose(work: Promise<void>) {
    this.pendingCloses.add(work);
    void work.finally(() => this.pendingCloses.delete(work)).catch(() => undefined);
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
    this.trackClose(this.closeClient(oldest[1]));

    const readPool = this.readPool.get(oldest[0]);
    if (readPool) {
      this.readPool.delete(oldest[0]);
      this.trackClose(this.closeReadPool(readPool));
    }
  }
}
