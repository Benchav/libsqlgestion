import crypto from 'crypto';
import fs from 'fs';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { DatabaseMigration } from '../../domain/entities/DatabaseMigration';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';
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
    const statements = this.normalizeStatements(input);
    if (!statements.length) throw new Error('No SQL statements provided');

    const checksum = this.calculateChecksum(databaseId, input.name, statements);
    const existing = await this.migrationRepo.findOneBy({ checksum });
    if (existing) return existing;

    const migration = this.migrationRepo.create({
      database,
      name: input.name,
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
      throw error;
    }
  }

  private normalizeStatements(input: { sql?: string; statements?: string[] }) {
    if (input.statements?.length) return input.statements.filter(Boolean).map((statement) => statement.trim()).filter(Boolean);
    if (input.sql) {
      return input.sql
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => `${statement};`);
    }
    return [];
  }

  private calculateChecksum(databaseId: string, name: string, statements: string[]) {
    return crypto.createHash('sha256').update([databaseId, name, ...statements].join('\n')).digest('hex');
  }

  private async applyToSqlite(database: Database, statements: string[]) {
    const client = new SqliteClient(database.url || '');
    try {
      for (const statement of statements) {
        await client.run(statement);
      }
    } finally {
      client.close();
    }
  }

  private async applyToLibsql(database: Database, statements: string[]) {
    if (!database.url || !database.encryptedToken) throw new Error('missing url or token');
    const client = createLibsqlClient(database.url, decrypt(database.encryptedToken));
    try {
      for (const statement of statements) {
        await client.execute(statement);
      }
    } finally {
      client.close();
    }
  }
}
