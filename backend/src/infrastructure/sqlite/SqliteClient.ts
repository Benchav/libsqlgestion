import sqlite3 from 'sqlite3';
import fs from 'fs';
import { promisify } from 'util';

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

  constructor(filePath: string) {
    // Pre-validate the file path before opening
    if (!filePath) {
      throw new DatabaseError('SQLITE_CANTOPEN', 'No database file path provided.', false);
    }

    const directory = require('path').dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      throw new DatabaseError('SQLITE_CANTOPEN', `Path is a directory, not a database file: ${filePath}`, false);
    }

    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

    // Validate that the file starts with a valid SQLite header (first 16 bytes)
    if (stat && stat.size > 0) {
      const fd = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      const magic = header.toString('ascii', 0, 15);
      if (magic !== 'SQLite format 3') {
        throw new DatabaseError('SQLITE_NOTADB', `The file is not a valid SQLite database: ${filePath}`, false);
      }
    }

    this.db = new sqlite3.Database(filePath);
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
  }

  /**
   * Validates that the database file is not corrupted by running PRAGMA integrity_check.
   */
  async checkIntegrity(): Promise<{ ok: boolean; details: string }> {
    try {
      const result = await this.all('PRAGMA integrity_check(1)');
      const firstRow = result[0] as { integrity_check?: string } | undefined;
      const status = firstRow?.integrity_check || 'unknown';
      return { ok: status === 'ok', details: status };
    } catch (error: any) {
      return { ok: false, details: DatabaseError.from(error).message };
    }
  }

  close() {
    this.db.close();
  }
}
