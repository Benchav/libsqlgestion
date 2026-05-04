import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { Project } from '../../domain/entities/Project';
import { encrypt, decrypt } from '../../infrastructure/crypto';
import { randomToken } from '../../infrastructure/security/tokens';
import { AuditService } from '../audit/AuditService';

export class DatabaseService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private projectRepo = AppDataSource.getRepository(Project);
  private auditService = new AuditService();

  async createDatabase(projectId: string, input: { name: string; type: 'sqlite' | 'libsql' | 'remote'; url?: string; token?: string; subdomain?: string; metadata?: Record<string, unknown> }) {
    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    const token = input.token ?? randomToken();
    const encryptedToken = encrypt(token);

    const database = await this.databaseRepo.save(this.databaseRepo.create({
      name: input.name,
      type: input.type,
      url: input.url,
      encryptedToken,
      subdomain: input.subdomain,
      status: 'inactive',
      metadata: input.metadata,
      project,
    }));

    if (input.type === 'sqlite') {
      const filePath = this.resolveSqlitePath(database.id);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, Buffer.from(''));
      database.url = filePath;
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
    const database = await this.databaseRepo.findOneByOrFail({ id });
    if (database.type === 'sqlite') {
      const url = database.url || this.resolveSqlitePath(database.id);
      const ok = fs.existsSync(url);
      return { ok, details: ok ? 'sqlite file exists' : 'sqlite file missing' };
    }

    if (!database.encryptedToken) return { ok: false, details: 'missing token' };
    const token = decrypt(database.encryptedToken);
    return { ok: Boolean(database.url && token.length > 0), details: 'remote/libsql validation deferred to integration layer' };
  }

  private resolveSqlitePath(databaseId: string) {
    return path.join(process.cwd(), 'data', 'sqlite', `${databaseId}.db`);
  }
}
