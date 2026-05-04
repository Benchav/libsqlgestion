import fs from 'fs';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { Project } from '../../domain/entities/Project';
import { encrypt, decrypt } from '../../infrastructure/crypto';
import { randomToken } from '../../infrastructure/security/tokens';
import { AuditService } from '../audit/AuditService';
import { createLibsqlClient } from '../../infrastructure/libsql/LibsqlClient';
import { ensureSubdomain } from '../../infrastructure/security/slug';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';

export class DatabaseService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private projectRepo = AppDataSource.getRepository(Project);
  private auditService = new AuditService();
  private storageService = new SqliteStorageService();

  async createDatabase(projectId: string, input: { name: string; type: 'sqlite' | 'libsql' | 'remote'; url?: string; token?: string; subdomain?: string; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    const token = input.token ?? randomToken();
    const encryptedToken = encrypt(token);
    const subdomain = input.subdomain ?? ensureSubdomain(input.name, randomToken());

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: input.type,
      url: input.url,
      encryptedToken,
      subdomain,
      status: 'inactive',
      metadata: input.metadata,
      project,
    }));

    if (input.type === 'sqlite') {
      const filePath = await this.storageService.ensureManagedDatabaseFile(project.id, database.id);
      database.url = filePath;
      database.status = 'active';
      await this.databaseRepo.save(database);
    } else if (input.url) {
      database.status = 'active';
      await this.databaseRepo.save(database);
    }

    await this.auditService.record({
      action: 'database.create',
      resourceType: 'database',
      resourceId: database.id,
      metadata: { projectId, type: input.type, subdomain: input.subdomain },
    });

    return { database, token };
  }

  async importExistingSqlite(projectId: string, input: { name: string; sourcePath: string; subdomain?: string; token?: string; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    if (!fs.existsSync(input.sourcePath)) {
      throw new Error('sourcePath does not exist');
    }
    const subdomain = input.subdomain ?? ensureSubdomain(input.name, randomToken());

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: 'sqlite',
      status: 'inactive',
      subdomain,
      metadata: { ...(input.metadata ?? {}), imported: true, sourcePath: input.sourcePath },
      project,
    }));

    const managedPath = await this.storageService.importDatabaseFile(input.sourcePath, project.id, database.id);

    database.url = managedPath;
    database.status = 'active';
    database.encryptedToken = encrypt(input.token ?? randomToken());
    await this.databaseRepo.save(database);

    await this.auditService.record({
      action: 'database.import',
      resourceType: 'database',
      resourceId: database.id,
      metadata: { projectId, sourcePath: input.sourcePath, subdomain: input.subdomain },
    });

    return { database };
  }

  async listDatabases(projectId?: string) {
    if (!projectId) return this.databaseRepo.find({ relations: ['project', 'project.owner'] });
    return this.databaseRepo.find({ where: { project: { id: projectId } }, relations: ['project', 'project.owner'] });
  }

  async getDatabase(id: string) {
    return this.databaseRepo.findOne({ where: { id }, relations: ['project', 'project.owner'] });
  }

  async rotateToken(id: string) {
    const database = await this.databaseRepo.findOneByOrFail({ id });
    const newToken = randomToken();
    database.encryptedToken = encrypt(newToken);
    await this.databaseRepo.save(database);
    await this.auditService.record({ action: 'database.rotate-token', resourceType: 'database', resourceId: database.id });
    return { database, token: newToken };
  }

  async testConnection(id: string) {
    const database = await this.databaseRepo.findOne({ where: { id }, relations: ['project'] });
    if (!database) throw new Error('database not found');
    if (database.type === 'sqlite') {
      const url = database.url || this.storageService.managedDatabasePath(database.project.id, database.id);
      const ok = fs.existsSync(url);
      return { ok, details: ok ? 'sqlite file exists' : 'sqlite file missing' };
    }

    if (!database.url || !database.encryptedToken) return { ok: false, details: 'missing url or token' };
    const token = decrypt(database.encryptedToken);
    const client = createLibsqlClient(database.url, token);
    try {
      await client.execute('SELECT 1');
      return { ok: true, details: 'connection ok' };
    } catch (error: any) {
      return { ok: false, details: error.message };
    } finally {
      client.close();
    }
  }

}
