import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';

type SqlitePerformanceProfile = 'safe' | 'balanced' | 'performance';

type SqlitePerformanceConfig = {
  busyTimeoutMs: number;
  synchronous: 'FULL' | 'NORMAL';
  cacheSize: number;
  tempStore: 'MEMORY' | 'DEFAULT';
  mmapSize: number;
};

function getSqlitePerformanceProfile(): SqlitePerformanceProfile {
  const profile = String(process.env.SQLITE_PERFORMANCE_PROFILE || 'performance').toLowerCase();
  if (profile === 'safe' || profile === 'performance') return profile;
  return 'balanced';
}

function getSqlitePerformanceConfig(): SqlitePerformanceConfig {
  const profile = getSqlitePerformanceProfile();
  const baseConfig: Record<SqlitePerformanceProfile, SqlitePerformanceConfig> = {
    safe: {
      busyTimeoutMs: 15000,
      synchronous: 'FULL',
      cacheSize: -10000,
      tempStore: 'DEFAULT',
      mmapSize: 134217728,
    },
    balanced: {
      busyTimeoutMs: 10000,
      synchronous: 'NORMAL',
      cacheSize: -20000,
      tempStore: 'MEMORY',
      mmapSize: 268435456,
    },
    performance: {
      busyTimeoutMs: 2500,
      synchronous: 'NORMAL',
      cacheSize: -80000,
      tempStore: 'MEMORY',
      mmapSize: 1073741824,
    },
  };

  const selected = baseConfig[profile];

  return {
    busyTimeoutMs: Number(process.env.SQLITE_BUSY_TIMEOUT_MS || selected.busyTimeoutMs),
    synchronous: String(process.env.SQLITE_SYNCHRONOUS || selected.synchronous).toUpperCase() === 'FULL' ? 'FULL' : 'NORMAL',
    cacheSize: Number(process.env.SQLITE_CACHE_SIZE || selected.cacheSize),
    tempStore: String(process.env.SQLITE_TEMP_STORE || selected.tempStore).toUpperCase() === 'DEFAULT' ? 'DEFAULT' : 'MEMORY',
    mmapSize: Number(process.env.SQLITE_MMAP_SIZE || selected.mmapSize),
  };
}

/**
 * Classifies SQLite error codes into user-friendly categories.
 */
function classifyError(error: any): { code: string; message: string; recoverable: boolean } {
  const msg = String(error?.message || error || '').toLowerCase();
  const code = error?.code || error?.errno || '';

  if (msg.includes('not a database') || msg.includes('sqlite_notadb')) {
    return { code: 'SQLITE_NOTADB', message: 'The file is not a valid SQLite database. It may be corrupted or not a database file.', recoverable: false };
  }
  if (msg.includes('database disk image is malformed') || msg.includes('sqlite_corrupt')) {
    return { code: 'SQLITE_CORRUPT', message: 'The database file is corrupted. Consider restoring from a backup.', recoverable: false };
  }
  if (msg.includes('unable to open') || msg.includes('sqlite_cantopen')) {
    return { code: 'SQLITE_CANTOPEN', message: 'Unable to open the database file. Check that the path exists and has the correct permissions.', recoverable: false };
  }
  if (msg.includes('locked') || msg.includes('sqlite_busy') || msg.includes('sqlite_locked')) {
    return { code: 'SQLITE_BUSY', message: 'The database is currently locked by another process. Try again in a moment.', recoverable: true };
  }
  if (msg.includes('readonly') || msg.includes('sqlite_readonly')) {
    return { code: 'SQLITE_READONLY', message: 'The database is in read-only mode. Check file permissions.', recoverable: false };
  }
  if (msg.includes('constraint') || msg.includes('sqlite_constraint')) {
    return { code: 'SQLITE_CONSTRAINT', message: `Constraint violation: ${error?.message || 'a database constraint was violated.'}`, recoverable: true };
  }
  if (msg.includes('syntax error') || msg.includes('near "')) {
    return { code: 'SQLITE_SYNTAX', message: `SQL syntax error: ${error?.message || 'check your query syntax.'}`, recoverable: true };
  }
  if (msg.includes('no such table')) {
    return { code: 'SQLITE_NO_TABLE', message: error?.message || 'The specified table does not exist.', recoverable: true };
  }
  if (msg.includes('no such column')) {
    return { code: 'SQLITE_NO_COLUMN', message: error?.message || 'The specified column does not exist.', recoverable: true };
  }
  if (msg.includes('misuse')) {
    return { code: 'SQLITE_MISUSE', message: 'SQLite reported an invalid API usage while executing the script. Try running the script in smaller batches.', recoverable: true };
  }

  return { code: 'SQLITE_ERROR', message: error?.message || 'An unknown database error occurred.', recoverable: false };
}

export class DatabaseError extends Error {
  public readonly code: string;
  public readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable: boolean) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.recoverable = recoverable;
  }

  static from(error: any): DatabaseError {
    const classified = classifyError(error);
    return new DatabaseError(classified.code, classified.message, classified.recoverable);
  }
}

export class SqliteClient {
  private db: sqlite3.Database;
  public all: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  public get: (sql: string, params?: unknown[]) => Promise<unknown>;
  public run: (sql: string, params?: unknown[]) => Promise<{ changes: number; lastID: number }>;
  public exec: (sql: string) => Promise<void>;
  public execAtomic: (sql: string) => Promise<void>;

  constructor(filePath: string) {
    // Pre-validate the file path before opening
    if (!filePath) {
      throw new DatabaseError('SQLITE_CANTOPEN', 'No database file path provided.', false);
    }

    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      throw new DatabaseError('SQLITE_CANTOPEN', `Path is a directory, not a database file: ${filePath}`, false);
    }



    this.db = new sqlite3.Database(filePath);
    const config = getSqlitePerformanceConfig();
    // Apply SQLite performance and concurrency tuning immediately after opening
    this.db.serialize(() => {
      this.db.run('PRAGMA journal_mode = WAL;');
      this.db.run(`PRAGMA busy_timeout = ${Math.max(0, config.busyTimeoutMs)};`);
      this.db.run(`PRAGMA synchronous = ${config.synchronous};`);
      this.db.run(`PRAGMA cache_size = ${config.cacheSize};`);
      this.db.run(`PRAGMA temp_store = ${config.tempStore};`);
      this.db.run(`PRAGMA mmap_size = ${Math.max(0, config.mmapSize)};`);
    });
    this.all = (sql: string, params: unknown[] = []) =>
      new Promise((resolve, reject) => {
        this.db.all(sql, params, (error: Error | null, rows: unknown[]) => {
          if (error) return reject(DatabaseError.from(error));
          resolve(rows);
        });
      });
    this.get = (sql: string, params: unknown[] = []) =>
      new Promise((resolve, reject) => {
        this.db.get(sql, params, (error: Error | null, row: unknown) => {
          if (error) return reject(DatabaseError.from(error));
          resolve(row);
        });
      });
    this.run = (sql: string, params: unknown[] = []) =>
      new Promise((resolve, reject) => {
        this.db.run(sql, params, function (this: sqlite3.RunResult, error: Error | null) {
          if (error) return reject(DatabaseError.from(error));
          resolve({ changes: this.changes ?? 0, lastID: this.lastID ?? 0 });
        });
      });
    this.exec = (sql: string) =>
      new Promise((resolve, reject) => {
        this.db.exec(sql, (error: Error | null) => {
          if (error) return reject(DatabaseError.from(error));
          resolve();
        });
      });
    this.execAtomic = async (sql: string) => {
      const normalized = sql.trim().toUpperCase();
      const hasExplicitTransaction = /^BEGIN\b/.test(normalized) || /^START\s+TRANSACTION\b/.test(normalized);

      if (hasExplicitTransaction) {
        await this.exec(sql);
        return;
      }

      try {
        await this.exec(`BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`);
      } catch (error) {
        try {
          await this.exec('ROLLBACK;');
        } catch {
          // Best-effort rollback if the transaction did not start cleanly.
        }
        throw error;
      }
    };
  }

  /**
   * Validates that the database file is not corrupted.
   * Includes a header check (moved from constructor to avoid blocking I/O on every query)
   * and a PRAGMA integrity_check.
   */
  async checkIntegrity(): Promise<{ ok: boolean; details: string }> {
    try {
      // Quick header validation (was previously in constructor, blocking every request)
      const filePath = (this.db as any).filename;
      if (filePath && typeof filePath === 'string') {
        try {
          const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
          if (stat && stat.size > 0) {
            const fd = fs.openSync(filePath, 'r');
            const header = Buffer.alloc(16);
            fs.readSync(fd, header, 0, 16, 0);
            fs.closeSync(fd);
            const magic = header.toString('ascii', 0, 15);
            if (magic !== 'SQLite format 3') {
              return { ok: false, details: `The file is not a valid SQLite database: ${filePath}` };
            }
          }
        } catch {
          // If we can't read the header, fall through to integrity_check
        }
      }

      const result = await this.all('PRAGMA integrity_check(1)');
      const firstRow = result[0] as { integrity_check?: string } | undefined;
      const status = firstRow?.integrity_check || 'unknown';
      return { ok: status === 'ok', details: status };
    } catch (error: any) {
      return { ok: false, details: DatabaseError.from(error).message };
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.db.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
