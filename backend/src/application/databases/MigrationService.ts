import crypto from 'crypto';
import fs from 'fs';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { DatabaseMigration } from '../../domain/entities/DatabaseMigration';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { decrypt } from '../../infrastructure/crypto';
import { AuditService } from '../audit/AuditService';

export class MigrationService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private migrationRepo = AppDataSource.getRepository(DatabaseMigration);
  private auditService = new AuditService();

  async list(databaseId: string) {
    return this.migrationRepo.find({ where: { database: { id: databaseId } }, order: { appliedAt: 'DESC' } });
  }

  async apply(databaseId: string, input: { name: string; sql?: string; statements?: string[]; source?: string }) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });

    // Validate migration name
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Migration name is required');
    }
    if (!/^[a-zA-Z0-9_\-. ]+$/.test(input.name.trim())) {
      throw new Error('Migration name can only contain letters, numbers, underscores, hyphens, dots, and spaces.');
    }

    const statements = this.normalizeStatements(input);
    if (!statements.length) throw new Error('No SQL statements provided');

    const checksum = this.calculateChecksum(databaseId, input.name, statements);

    // Check for exact duplicate (same name + same SQL)
    const existing = await this.migrationRepo.findOneBy({ checksum });
    if (existing) return existing;

    // Check for name collision with different SQL
    const existingByName = await this.migrationRepo.findOne({
      where: { database: { id: databaseId }, name: input.name.trim() },
    });
    if (existingByName && existingByName.checksum !== checksum) {
      throw new Error(`A migration named "${input.name}" already exists with different SQL. Use a unique name.`);
    }

    const migration = this.migrationRepo.create({
      database,
      name: input.name.trim(),
      checksum,
      statements,
      source: input.source ?? 'api',
      status: 'pending',
    });

    await this.migrationRepo.save(migration);

    try {
      if (database.type === 'sqlite') {
        await this.applyToSqlite(database, statements);
      } else {
        await this.applyToLibsql(database, statements);
      }

      migration.status = 'applied';
      await this.migrationRepo.save(migration);

      await this.auditService.record({
        action: 'database.migration.apply',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { name: input.name, checksum, statementCount: statements.length },
      });

      return migration;
    } catch (error: any) {
      migration.status = 'failed';
      migration.errorMessage = error.message;
      await this.migrationRepo.save(migration);

      await this.auditService.record({
        action: 'database.migration.failed',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { name: input.name, checksum, error: error.message },
      });

      throw error;
    }
  }

  /**
   * Improved SQL statement splitter that respects string literals.
   * Handles strings delimited by single quotes, and avoids splitting on `;` inside them.
   */
  private normalizeStatements(input: { sql?: string; statements?: string[] }) {
    if (input.statements?.length) {
      return input.statements
        .filter(Boolean)
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => (statement.endsWith(';') ? statement : `${statement};`));
    }
    if (input.sql) {
      return this.splitSql(input.sql);
    }
    return [];
  }

  /**
   * Splits SQL text into individual statements, respecting single-quoted strings.
   * `;` inside strings (e.g., INSERT INTO t VALUES('a;b')) will NOT cause a split.
   */
  private splitSql(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inString = false;
    let escape = false;

    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];

      if (escape) {
        current += ch;
        escape = false;
        continue;
      }

      if (ch === '\\') {
        current += ch;
        escape = true;
        continue;
      }

      if (ch === "'") {
        // Handle escaped quotes ('') inside SQLite strings
        if (inString && i + 1 < sql.length && sql[i + 1] === "'") {
          current += "''";
          i++;
          continue;
        }
        inString = !inString;
        current += ch;
        continue;
      }

      if (ch === ';' && !inString) {
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          statements.push(`${trimmed};`);
        }
        current = '';
        continue;
      }

      current += ch;
    }

    // Handle last statement without trailing ;
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      statements.push(trimmed.endsWith(';') ? trimmed : `${trimmed};`);
    }

    return statements;
  }

  private calculateChecksum(databaseId: string, name: string, statements: string[]) {
    return crypto.createHash('sha256').update([databaseId, name, ...statements].join('\n')).digest('hex');
  }

  /**
   * Applies migration statements to a SQLite database wrapped in a transaction.
   * If any statement fails, all changes are rolled back.
   */
  private async applyToSqlite(database: Database, statements: string[]) {
    let client: SqliteClient;
    try {
      client = new SqliteClient(database.url || '');
    } catch (error: any) {
      throw error instanceof DatabaseError ? error : DatabaseError.from(error);
    }

    try {
      await client.run('BEGIN TRANSACTION;');
      for (const statement of statements) {
        await client.run(statement);
      }
      await client.run('COMMIT;');
    } catch (error: any) {
      // Attempt rollback — if it fails, the original error is still thrown
      try { await client.run('ROLLBACK;'); } catch { /* ignore rollback errors */ }
      throw error instanceof DatabaseError ? error : DatabaseError.from(error);
    } finally {
      client.close();
    }
  }

  /**
   * Applies migration statements to a libSQL database.
   * Uses the batch API when available for transactional execution.
   */
  private async applyToLibsql(database: Database, statements: string[]) {
    if (!database.url || !database.encryptedToken) throw new Error('missing url or token');
    const client = createLibsqlClient(database.url, decrypt(database.encryptedToken));
    try {
      // Attempt batch execution for atomicity
      try {
        await (client as any).batch(statements.map((s: string) => ({ sql: s })), 'write');
      } catch {
        // Fallback: execute one by one (older libsql clients)
        for (const statement of statements) {
          await client.execute(statement);
        }
      }
    } catch (error: any) {
      throw new DatabaseError('LIBSQL_ERROR', error.message || 'Remote migration failed', true);
    } finally {
      client.close();
    }
  }
}
