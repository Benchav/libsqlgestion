import sqlite3 from 'sqlite3';
import { promisify } from 'util';

export class SqliteClient {
  private db: sqlite3.Database;
  public all: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  public get: (sql: string, params?: unknown[]) => Promise<unknown>;
  public run: (sql: string, params?: unknown[]) => Promise<{ changes: number; lastID: number }>;

  constructor(filePath: string) {
    this.db = new sqlite3.Database(filePath);
    this.all = promisify(this.db.all.bind(this.db));
    this.get = promisify(this.db.get.bind(this.db));
    this.run = (sql: string, params: unknown[] = []) =>
      new Promise((resolve, reject) => {
        this.db.run(sql, params, function (this: sqlite3.RunResult, error: Error | null) {
          if (error) return reject(error);
          resolve({ changes: this.changes ?? 0, lastID: this.lastID ?? 0 });
        });
      });
  }

  close() {
    this.db.close();
  }
}
