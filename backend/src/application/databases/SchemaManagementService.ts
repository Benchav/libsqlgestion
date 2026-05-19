import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { AuditService } from '../audit/AuditService';
import { SqliteClient, DatabaseError } from '../../infrastructure/sqlite/SqliteClient';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { decrypt } from '../../infrastructure/crypto';

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function validateTableName(name: string) {
  if (!name || typeof name !== 'string') {
    throw new DatabaseError('SQLITE_SCHEMA_INVALID', 'Table name is required.', false);
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new DatabaseError('SQLITE_SCHEMA_INVALID', 'Invalid table name.', false);
  }

  return name;
}

export class SchemaManagementService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private auditService = new AuditService();

  async deleteTable(databaseId: string, tableName: string, actorId?: string) {
    const database = await this.databaseRepo.findOneByOrFail({ id: databaseId });
    const safeTableName = validateTableName(tableName);

    if (database.type !== 'sqlite') {
      if (!database.url || !database.encryptedToken) {
        throw new DatabaseError('SQLITE_SCHEMA_INVALID', 'Database connection is not configured.', false);
      }

      const client = createLibsqlClient(database.url, decrypt(database.encryptedToken));
      try {
        await client.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(safeTableName)}`);
      } catch (error: any) {
        throw new DatabaseError('LIBSQL_ERROR', error.message || 'Failed to drop table', true);
      } finally {
        client.close();
      }
    } else {
      const client = new SqliteClient(database.url || '');
      try {
        await client.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(safeTableName)};`);
      } catch (error: any) {
        throw error instanceof DatabaseError ? error : DatabaseError.from(error);
      } finally {
        client.close();
      }
    }

    await this.auditService.record({
      action: 'schema.table.delete',
      resourceType: 'table',
      resourceId: safeTableName,
      actorId,
      metadata: { databaseId, tableName: safeTableName },
    });

    return { ok: true, table: safeTableName };
  }
}
