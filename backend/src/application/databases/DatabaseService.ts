import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { Project } from '../../domain/entities/Project';
import { encrypt, decrypt } from '../../infrastructure/crypto';
import { randomToken } from '../../infrastructure/security/tokens';
import { AuditService } from '../audit/AuditService';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { SqliteClient } from '../../infrastructure/sqlite/SqliteClient';
import { assertValidSubdomainLabel, ensureSubdomain } from '../../infrastructure/security/slug';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';
import { LibsqlRuntimeService } from '../../infrastructure/docker/LibsqlRuntimeService';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';
import { getRuntimeConnectionUrl, normalizeLegacyLocalDatabase, resolveEffectiveDatabaseType, shouldReconcileLegacyLocalDatabase } from './database-runtime';

export class DatabaseService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private projectRepo = AppDataSource.getRepository(Project);
  private auditService = new AuditService();
  private storageService = new SqliteStorageService();
  private runtimeService = new LibsqlRuntimeService();

  async createDatabase(projectId: string, input: { name: string; type: 'sqlite' | 'libsql' | 'remote'; url?: string; token?: string; subdomain?: string; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    const subdomain = input.subdomain ? assertValidSubdomainLabel(input.subdomain) : ensureSubdomain(input.name, randomToken());
    const willProvisionRuntime = this.isManagedRuntimeRequest(input) && this.runtimeService.isEnabled();

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: input.type,
      status: willProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: input.metadata,
      project,
    }));

    let managedPath: string | undefined;

    try {
      const token = input.token ?? randomToken();

      if (input.type === 'sqlite' || willProvisionRuntime) {
        const storageType = willProvisionRuntime ? 'libsql' : input.type;
        managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id, storageType);

        if (input.type === 'sqlite' && !willProvisionRuntime) {
          const initClient = new SqliteClient(managedPath);
          try {
            await initClient.run('PRAGMA journal_mode = WAL;');
          } finally {
            await initClient.close();
          }
        }
      }

      database.url = managedPath || input.url || undefined;
      database.status = database.type === 'remote' && !managedPath ? (input.url ? 'active' : 'inactive') : willProvisionRuntime ? 'provisioning' : 'active';
      database.encryptedToken = encrypt(token);
      database.metadata = mergeRuntimeMetadata(database.metadata, {
        provider: 'local-file',
        databasePath: managedPath || null,
        connectionUrl: managedPath || null,
        internalUrl: managedPath || null,
        publicUrl: managedPath || null,
      });
      await this.databaseRepo.save(database);

      await this.auditService.record({
        action: 'database.create',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { projectId, type: input.type, subdomain: input.subdomain, runtime: 'local-file' },
      });

      if (willProvisionRuntime && managedPath) {
        this.attemptRuntimeProvisioning(database.id, managedPath, 'database.create', {
          projectId, type: input.type, subdomain: input.subdomain,
        }).catch((error) => {
          console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
        });
      }

      return { database, token };
    } catch (error) {
      await this.cleanupCreatedDatabase(database.id, managedPath ? [managedPath] : []);
      throw error;
    }
  }

  async importExistingSqlite(projectId: string, input: { name?: string; sourceName?: string; sourcePath: string; subdomain?: string; token?: string; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    if (!fs.existsSync(input.sourcePath)) {
      throw new Error('sourcePath does not exist');
    }
    const databaseName = deriveDatabaseName(input.name, input.sourceName, input.sourcePath);
    const subdomain = input.subdomain ? assertValidSubdomainLabel(input.subdomain) : ensureSubdomain(databaseName, randomToken());
    const willProvisionRuntime = this.runtimeService.isEnabled();
    const storageType = willProvisionRuntime ? 'libsql' : 'sqlite';

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: databaseName,
      type: 'sqlite',
      status: willProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: { ...(input.metadata ?? {}), imported: true, sourcePath: input.sourcePath },
      project,
    }));

    const managedPath = await this.storageService.importDatabaseFile(input.sourcePath, project.id, database.id, storageType);

    try {
      const token = input.token ?? randomToken();

      database.url = managedPath;
      database.status = willProvisionRuntime ? 'provisioning' : 'active';
      database.encryptedToken = encrypt(token);
      database.metadata = mergeRuntimeMetadata(database.metadata, {
        provider: 'local-file',
        databasePath: managedPath,
        connectionUrl: managedPath,
        internalUrl: managedPath,
        publicUrl: managedPath,
      });
      await this.databaseRepo.save(database);

      await this.auditService.record({
        action: 'database.import',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain, runtime: 'local-file' },
      });

      if (willProvisionRuntime) {
        this.attemptRuntimeProvisioning(database.id, managedPath, 'database.import', {
          projectId, sourcePath: input.sourcePath, subdomain: input.subdomain,
        }).catch((error) => {
          console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
        });
      }

      return { database, token };
    } catch (error) {
      await this.cleanupCreatedDatabase(database.id, [managedPath]);
      throw error;
    }
  }

  async listDatabases(projectId?: string) {
    if (!projectId) return this.databaseRepo.find({ relations: ['project', 'project.owner'] });
    return this.databaseRepo.find({ where: { project: { id: projectId } }, relations: ['project', 'project.owner'] });
  }

  async getDatabase(id: string) {
    return this.databaseRepo.findOne({ where: { id }, relations: ['project', 'project.owner'] });
  }

  async reconcileLegacyDatabases() {
    const databases = await this.databaseRepo.find();
    let reconciled = 0;

    for (const database of databases) {
      if (!shouldReconcileLegacyLocalDatabase(database)) {
        continue;
      }

      const normalized = normalizeLegacyLocalDatabase(database);
      database.type = normalized.type;
      database.status = normalized.status as any;
      database.metadata = normalized.metadata;
      await this.databaseRepo.save(database);
      reconciled += 1;
    }

    return { reconciled };
  }

  async rotateToken(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');

    ConnectionPool.getInstance().evict(id);

    if (this.isManagedRuntimeEntry(database)) {
      const runtime = await this.runtimeService.rotateDatabase(database);
      if (!runtime) {
        throw new Error('database runtime is missing');
      }

      database.encryptedToken = encrypt(runtime.token);
      database.metadata = mergeRuntimeMetadata(database.metadata, runtime.metadata);
      await this.databaseRepo.save(database);
      await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
      return { database, token: runtime.token };
    }

    const newToken = randomToken();
    database.encryptedToken = encrypt(newToken);
    await this.databaseRepo.save(database);
    await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
    return { database, token: newToken };
  }

  async testConnection(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');
    const runtimeUrl = getManagedRuntimeUrl(database);

    if (runtimeUrl && database.encryptedToken) {
      const token = decrypt(database.encryptedToken);
      const libClient = createLibsqlClient(runtimeUrl, token);
      try {
        await libClient.execute('SELECT 1');
        return { ok: true, details: 'connection ok' };
      } catch (error: any) {
        return { ok: false, details: error.message };
      } finally {
        libClient.close();
      }
    }

    if (resolveEffectiveDatabaseType(database) === 'sqlite') {
      const url = database.url || this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
      if (!fs.existsSync(url)) {
        return { ok: false, details: 'sqlite file missing', code: 'SQLITE_CANTOPEN' };
      }

      let client: SqliteClient;
      try {
        client = new SqliteClient(url);
      } catch (error: any) {
        return { ok: false, details: error.message || 'failed to open database', code: error.code || 'SQLITE_CANTOPEN' };
      }

      try {
        const integrity = await client.checkIntegrity();
        if (!integrity.ok) {
          return { ok: false, details: `Integrity check failed: ${integrity.details}`, code: 'SQLITE_CORRUPT' };
        }
        return { ok: true, details: 'sqlite connection ok - integrity check passed' };
      } catch (error: any) {
        return { ok: false, details: error.message || 'failed to verify database', code: error.code || 'SQLITE_ERROR' };
      } finally {
        client.close();
      }
    }

    if (!database.url || !database.encryptedToken) return { ok: false, details: 'missing url or token' };
    const token = decrypt(database.encryptedToken);
    const libClient = createLibsqlClient(database.url, token);
    try {
      await libClient.execute('SELECT 1');
      return { ok: true, details: 'connection ok' };
    } catch (error: any) {
      return { ok: false, details: error.message };
    } finally {
      libClient.close();
    }
  }

  async deleteDatabase(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');

    ConnectionPool.getInstance().evict(id);

    await this.runtimeService.removeDatabase(database);
    await this.databaseRepo.remove(database);

    await this.auditService.record({
      action: 'database.delete',
      resourceType: 'database',
      resourceId: id,
      metadata: { name: database.name, type: database.type },
    });

    return { ok: true };
  }

  async updateDatabase(id: string, input: { name?: string; status?: string }) {
    const database = await this.databaseRepo.findOneByOrFail({ id });
    if (input.name) database.name = input.name;
    if (input.status) database.status = input.status as any;
    await this.databaseRepo.save(database);
    await this.auditService.record({
      action: 'database.update',
      resourceType: 'database',
      resourceId: id,
      metadata: input,
    });
    return database;
  }

  async backupDatabase(sourceId: string, input: { name: string }) {
    const sourceDatabase = await this.databaseRepo.findOne({ where: { id: sourceId }, relations: ['project'] });
    if (!sourceDatabase) throw new Error('source database not found');

    const project = sourceDatabase.project;

    const sourcePath = sourceDatabase.url || this.storageService.managedDatabasePath(project.id, sourceDatabase.id, sourceDatabase.type);
    if (!fs.existsSync(sourcePath)) {
      throw new Error('source database file not found on disk');
    }

    const subdomain = ensureSubdomain(input.name, randomToken());
    const willProvisionRuntime = this.runtimeService.isEnabled();
    const storageType = willProvisionRuntime ? 'libsql' : sourceDatabase.type as 'sqlite' | 'libsql' | 'remote';

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: sourceDatabase.type as 'sqlite' | 'libsql' | 'remote',
      status: willProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: {
        backup: true,
        sourceId: sourceDatabase.id,
        sourceName: sourceDatabase.name,
        backupTimestamp: new Date().toISOString(),
      },
      project,
    }));

    const managedPath = await this.storageService.importDatabaseFile(sourcePath, project.id, database.id, storageType);

    try {
      const token = randomToken();
      database.url = managedPath;
      database.status = willProvisionRuntime ? 'provisioning' : 'active';
      database.encryptedToken = encrypt(token);
      database.metadata = mergeRuntimeMetadata(database.metadata, {
        provider: 'local-file',
        databasePath: managedPath,
        connectionUrl: managedPath,
        internalUrl: managedPath,
        publicUrl: managedPath,
      });
      await this.databaseRepo.save(database);

      await this.auditService.record({
        action: 'database.backup',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id, runtime: 'local-file' },
      });

      if (willProvisionRuntime) {
        this.attemptRuntimeProvisioning(database.id, managedPath, 'database.backup', {
          sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id,
        }).catch((error) => {
          console.error(`[DatabaseService] Background provisioning failed for ${database.id}:`, error?.message || error);
        });
      }

      return { database, token };
    } catch (error) {
      await this.cleanupCreatedDatabase(database.id, [managedPath]);
      throw error;
    }
  }

  async getDatabaseFilePath(id: string): Promise<string> {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');
    return database.url || this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
  }

  private isManagedRuntimeRequest(input: { type: 'sqlite' | 'libsql' | 'remote'; url?: string }) {
    return isManagedRuntimeType(input);
  }

  private isManagedRuntimeEntry(database: { metadata?: Record<string, unknown>; type: string; url?: string | null }) {
    return getManagedRuntimeUrl(database) !== null;
  }

  private async attemptRuntimeProvisioning(
    databaseId: string,
    managedPath: string,
    auditAction: string,
    auditMetadata: Record<string, unknown>,
  ) {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (!database) return;

    try {
      const managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
      database.type = 'libsql';
      database.url = managedPath;
      database.status = 'active';
      database.encryptedToken = encrypt(managedRuntime.token);
      database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
      await this.databaseRepo.save(database);
      await this.auditService.record({
        action: auditAction,
        resourceType: 'database',
        resourceId: database.id,
        metadata: { ...auditMetadata, runtime: managedRuntime.metadata.provider, asyncProvisioned: true },
      });
    } catch (error) {
      database.status = 'error';
      database.metadata = {
        ...(database.metadata ?? {}),
        runtimeError: this.runtimeService.getRuntimeErrorMessage(error),
        lastProvisioningAttemptAt: new Date().toISOString(),
      };
      await this.databaseRepo.save(database);
    }
  }

  private async cleanupCreatedDatabase(databaseId: string, extraPaths: string[] = [], runtimeMetadata?: Record<string, unknown>) {
    const database = await this.databaseRepo.findOne({ where: { id: databaseId }, relations: ['project'] });
    if (database) {
      try {
        await this.runtimeService.removeDatabase({
          ...database,
          metadata: runtimeMetadata ? { ...(database.metadata ?? {}), runtime: runtimeMetadata } : database.metadata,
        });
      } catch {
      }

      await this.databaseRepo.remove(database);
    }

    for (const filePath of extraPaths) {
      try {
        await fs.promises.rm(filePath, { force: true });
      } catch {
      }
    }
  }
}

function deriveDatabaseName(name?: string, sourceName?: string, sourcePath?: string) {
  const explicitName = name?.trim();
  if (explicitName) return explicitName;

  const candidate = sourceName || (sourcePath ? path.basename(sourcePath) : '');
  return candidate.replace(/\.[^.]+$/, '').trim() || 'imported-database';
}

function mergeRuntimeMetadata(existing: Record<string, unknown> | undefined, runtime: Record<string, unknown>) {
  return {
    ...(existing ?? {}),
    runtimeError: undefined,
    lastHealthyAt: new Date().toISOString(),
    runtime,
  };
}

function getManagedRuntimeUrl(database: { metadata?: Record<string, unknown>; type: string; url?: string | null }) {
  const runtimeUrl = getRuntimeConnectionUrl(database);
  if (resolveEffectiveDatabaseType(database) !== 'libsql') {
    return null;
  }

  return runtimeUrl || null;
}

function isManagedRuntimeType(input: { type: 'sqlite' | 'libsql' | 'remote'; url?: string }) {
  if (input.type === 'sqlite') return true;
  if (input.type === 'libsql' && !input.url) return true;
  return false;
}
