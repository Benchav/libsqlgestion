import fs from 'fs';
import path from 'path';
import { Database } from '../../domain/entities/Database';
import { SqliteClient } from '../sqlite/SqliteClient';
import { createLibsqlClient } from '../libsql/LibsqlClient';
import { decrypt } from '../crypto';
import { getRuntimeConnectionUrl, resolveEffectiveDatabaseType } from '../../application/databases/database-runtime';

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
    const storageRoot = process.env.SQLITE_STORAGE_ROOT || path.join(process.cwd(), 'data', 'sqlite');
    let filePath = database.url || '';

    // 1. Direct path exists
    if (!filePath || !fs.existsSync(filePath)) {
      // 2. If database.url contains 'projects/...', re-base onto current storageRoot
      if (filePath && filePath.includes('projects')) {
        const relativeSub = filePath.substring(filePath.indexOf('projects'));
        const candidate = path.join(storageRoot, relativeSub);
        if (fs.existsSync(candidate)) {
          filePath = candidate;
        }
      }
    }

    // 3. Try standard managed paths if project id is available
    if (!filePath || !fs.existsSync(filePath)) {
      if (database.project?.id) {
        const flatDb = path.join(storageRoot, 'projects', database.project.id, 'databases', `${database.id}.db`);
        const nestedData = path.join(storageRoot, 'projects', database.project.id, 'databases', database.id, 'dbs', 'default', 'data');
        if (fs.existsSync(flatDb)) {
          filePath = flatDb;
        } else if (fs.existsSync(nestedData)) {
          filePath = nestedData;
        }
      }
    }

    // 4. Scan projects directory in storageRoot for any matching database id file
    if (!filePath || !fs.existsSync(filePath)) {
      try {
        const projectsDir = path.join(storageRoot, 'projects');
        if (fs.existsSync(projectsDir)) {
          for (const pDir of fs.readdirSync(projectsDir)) {
            const flatCandidate = path.join(projectsDir, pDir, 'databases', `${database.id}.db`);
            const nestedCandidate = path.join(projectsDir, pDir, 'databases', database.id, 'dbs', 'default', 'data');
            if (fs.existsSync(flatCandidate)) {
              filePath = flatCandidate;
              break;
            } else if (fs.existsSync(nestedCandidate)) {
              filePath = nestedCandidate;
              break;
            }
          }
        }
      } catch {
        // Ignore scanning error
      }
    }

    // 5. If still missing on disk but database record exists, initialize an empty SQLite database with WAL mode
    if (!filePath || !fs.existsSync(filePath)) {
      const projectId = database.project?.id || 'default';
      filePath = path.join(storageRoot, 'projects', projectId, 'databases', `${database.id}.db`);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, Buffer.from(''));
        }
      } catch (err: any) {
        throw new Error(`Database ${database.id} file is missing and could not be initialized at ${filePath}: ${err?.message || err}`);
      }
    }

    return filePath;
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
