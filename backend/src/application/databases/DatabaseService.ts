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

export class DatabaseService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private projectRepo = AppDataSource.getRepository(Project);
  private auditService = new AuditService();
  private storageService = new SqliteStorageService();
  private runtimeService = new LibsqlRuntimeService();

  async createDatabase(projectId: string, input: { name: string; type: 'sqlite' | 'libsql' | 'remote'; url?: string; token?: string; subdomain?: string; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    const subdomain = input.subdomain ? assertValidSubdomainLabel(input.subdomain) : ensureSubdomain(input.name, randomToken());
    let managedPath: string | undefined;
    let managedRuntime: { token: string; metadata: Record<string, unknown> } | null = null;
    let managedRuntimeMetadata: Record<string, unknown> | undefined;
    const canProvisionRuntime = this.isManagedRuntimeRequest(input) && this.runtimeService.isEnabled();
    const provisionAsync = canProvisionRuntime && this.shouldProvisionAsync();

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: input.type,
      url: input.url,
      subdomain,
      status: canProvisionRuntime ? 'provisioning' : 'inactive',
      metadata: input.metadata,
      project,
    }));

    try {
      if (canProvisionRuntime) {
        managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id);
        if (provisionAsync) {
          this.scheduleManagedRuntimeProvisioning({
            databaseId: database.id,
            managedPath,
            auditAction: 'database.create',
            auditMetadata: { projectId, type: input.type, subdomain: input.subdomain },
          });
          return { database };
        }

        try {
          managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
          managedRuntimeMetadata = managedRuntime.metadata;

          database.url = managedPath;
          database.status = 'active';
          database.encryptedToken = encrypt(managedRuntime.token);
          database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
          await this.databaseRepo.save(database);

          await this.auditService.record({
            action: 'database.create',
            resourceType: 'database',
            resourceId: database.id,
            metadata: { projectId, type: input.type, subdomain: input.subdomain, runtime: managedRuntime.metadata.provider },
          });

          return { database, token: managedRuntime.token };
        } catch (error) {
          await this.markProvisioningError(database, error, managedPath);
          throw error;
        }
      }

      if (input.type === 'sqlite') {
        managedPath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id);
        await fs.promises.writeFile(managedPath, '');
        
        // Initialize the new SQLite file and set WAL mode persistently once
        const initClient = new SqliteClient(managedPath);
        try {
          await initClient.run('PRAGMA journal_mode = WAL;');
        } finally {
          await initClient.close();
        }

        const token = input.token ?? randomToken();
        database.url = managedPath;
        database.status = 'active';
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
          action: 'database.create',
          resourceType: 'database',
          resourceId: database.id,
          metadata: { projectId, type: input.type, subdomain: input.subdomain, runtime: 'local-file' },
        });

        return { database, token };
      }

      const token = input.token ?? randomToken();
      database.encryptedToken = encrypt(token);

      if (input.url) {
        database.status = 'active';
      }

      await this.databaseRepo.save(database);

      await this.auditService.record({
        action: 'database.create',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { projectId, type: input.type, subdomain: input.subdomain },
      });

      return { database, token };
    } catch (error) {
      if (database.status === 'error') {
        throw error;
      }
      await this.cleanupCreatedDatabase(database.id, managedPath ? [managedPath] : [], managedRuntimeMetadata);
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
    const canProvisionRuntime = this.runtimeService.isEnabled();

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: databaseName,
      type: 'sqlite',
      status: canProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: { ...(input.metadata ?? {}), imported: true, sourcePath: input.sourcePath },
      project,
    }));

    const managedPath = await this.storageService.importDatabaseFile(input.sourcePath, project.id, database.id);
    let managedRuntime: { token: string; metadata: Record<string, unknown> } | null = null;
    let managedRuntimeMetadata: Record<string, unknown> | undefined;

    try {
      if (canProvisionRuntime) {
        if (this.shouldProvisionAsync()) {
          this.scheduleManagedRuntimeProvisioning({
            databaseId: database.id,
            managedPath,
            auditAction: 'database.import',
            auditMetadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain },
          });
          return { database };
        }

        try {
          managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
          managedRuntimeMetadata = managedRuntime.metadata;

          database.url = managedPath;
          database.status = 'active';
          database.encryptedToken = encrypt(managedRuntime.token);
          database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
          await this.databaseRepo.save(database);

          await this.auditService.record({
            action: 'database.import',
            resourceType: 'database',
            resourceId: database.id,
            metadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain, runtime: managedRuntime.metadata.provider },
          });

          return { database, token: managedRuntime.token };
        } catch (error) {
          await this.markProvisioningError(database, error, managedPath);
          throw error;
        }
      }

      const token = input.token ?? randomToken();
      database.url = managedPath;
      database.status = 'active';
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

      return { database, token };
    } catch (error) {
      if (database.status === 'error') {
        throw error;
      }
      await this.cleanupCreatedDatabase(database.id, [managedPath], managedRuntimeMetadata);
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

  async rotateToken(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');

    // Evict old connection from pool before rotating credentials
    ConnectionPool.getInstance().evict(id);
    if (this.isManagedRuntime(database)) {
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

    if (database.type === 'sqlite') {
      const url = database.url || this.storageService.managedDatabasePath(database.project.id, database.id);
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

    // Evict connection from pool before removing the database
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

    // Resolve the source SQLite file path
    const sourcePath = sourceDatabase.url || this.storageService.managedDatabasePath(project.id, sourceDatabase.id);
    if (!fs.existsSync(sourcePath)) {
      throw new Error('source database file not found on disk');
    }

    const subdomain = ensureSubdomain(input.name, randomToken());
    const canProvisionRuntime = this.runtimeService.isEnabled();

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: sourceDatabase.type as 'sqlite' | 'libsql' | 'remote',
      status: canProvisionRuntime ? 'provisioning' : 'inactive',
      subdomain,
      metadata: {
        backup: true,
        sourceId: sourceDatabase.id,
        sourceName: sourceDatabase.name,
        backupTimestamp: new Date().toISOString(),
      },
      project,
    }));

    // Copy the SQLite file byte-by-byte to the new managed location
    const managedPath = await this.storageService.importDatabaseFile(sourcePath, project.id, database.id);
    let managedRuntime: { token: string; metadata: Record<string, unknown> } | null = null;
    let managedRuntimeMetadata: Record<string, unknown> | undefined;

    try {
      if (canProvisionRuntime) {
        if (this.shouldProvisionAsync()) {
          this.scheduleManagedRuntimeProvisioning({
            databaseId: database.id,
            managedPath,
            auditAction: 'database.backup',
            auditMetadata: { sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id },
          });
          return { database };
        }

        try {
          managedRuntime = await this.runtimeService.provisionDatabase(database, managedPath);
          managedRuntimeMetadata = managedRuntime.metadata;

          database.url = managedPath;
          database.status = 'active';
          database.encryptedToken = encrypt(managedRuntime.token);
          database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
          await this.databaseRepo.save(database);

          await this.auditService.record({
            action: 'database.backup',
            resourceType: 'database',
            resourceId: database.id,
            metadata: { sourceId: sourceDatabase.id, sourceName: sourceDatabase.name, projectId: project.id, runtime: managedRuntime.metadata.provider },
          });

          return { database, token: managedRuntime.token };
        } catch (error) {
          await this.markProvisioningError(database, error, managedPath);
          throw error;
        }
      }

      const token = randomToken();
      database.url = managedPath;
      database.status = 'active';
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

      return { database, token };
    } catch (error) {
      if (database.status === 'error') {
        throw error;
      }
      await this.cleanupCreatedDatabase(database.id, [managedPath], managedRuntimeMetadata);
      throw error;
    }
  }

  async getDatabaseFilePath(id: string): Promise<string> {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');
    return database.url || this.storageService.managedDatabasePath(database.project.id, database.id);
  }

  private isManagedRuntimeRequest(input: { type: 'sqlite' | 'libsql' | 'remote'; url?: string }) {
    return isManagedRuntimeType(input);
  }

  private isManagedRuntime(database: { metadata?: Record<string, unknown>; type: string; url?: string | null }) {
    return getManagedRuntimeUrl(database) !== null;
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
        // Best-effort cleanup after a failed create/import flow.
      }

      await this.databaseRepo.remove(database);
    }

    for (const filePath of extraPaths) {
      try {
        await fs.promises.rm(filePath, { force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  private async markProvisioningError(database: Database, error: unknown, managedPath?: string) {
    database.status = 'error';
    database.url = managedPath || database.url;
    database.metadata = {
      ...(database.metadata ?? {}),
      runtimeError: this.runtimeService.getRuntimeErrorMessage(error),
      lastProvisioningAttemptAt: new Date().toISOString(),
    };
    await this.databaseRepo.save(database);
  }

  private shouldProvisionAsync() {
    return String(process.env.LIBSQL_PROVISION_ASYNC || 'false').toLowerCase() === 'true';
  }

  private scheduleManagedRuntimeProvisioning(input: {
    databaseId: string;
    managedPath: string;
    auditAction: string;
    auditMetadata: Record<string, unknown>;
  }) {
    setImmediate(async () => {
      const database = await this.databaseRepo.findOne({ where: { id: input.databaseId }, relations: ['project'] }).catch(() => null);
      if (!database) {
        return;
      }

      try {
        const managedRuntime = await this.runtimeService.provisionDatabase(database, input.managedPath);
        database.url = input.managedPath;
        database.status = 'active';
        database.encryptedToken = encrypt(managedRuntime.token);
        database.metadata = mergeRuntimeMetadata(database.metadata, managedRuntime.metadata);
        await this.databaseRepo.save(database);
        await this.auditService.record({
          action: input.auditAction,
          resourceType: 'database',
          resourceId: database.id,
          metadata: { ...input.auditMetadata, runtime: managedRuntime.metadata.provider, asyncProvisioned: true },
        });
      } catch (error) {
        await this.markProvisioningError(database, error, input.managedPath);
      }
    });
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
  const runtime = database.metadata?.runtime as { provider?: unknown; connectionUrl?: unknown; internalUrl?: unknown; publicUrl?: unknown } | undefined;
  if (!runtime || runtime.provider !== 'docker-libsql') {
    return null;
  }

  if (typeof runtime.connectionUrl === 'string') {
    return runtime.connectionUrl;
  }

  if (typeof runtime.internalUrl === 'string') {
    return runtime.internalUrl;
  }

  if (typeof runtime.publicUrl === 'string') {
    return runtime.publicUrl;
  }

  if (database.type === 'sqlite' && database.url && database.url.startsWith('http')) {
    return database.url;
  }

  return null;
}

function isManagedRuntimeType(input: { type: 'sqlite' | 'libsql' | 'remote'; url?: string }) {
  if (input.type === 'sqlite') return true;
  if (input.type === 'libsql' && !input.url) return true;
  return false;
}
