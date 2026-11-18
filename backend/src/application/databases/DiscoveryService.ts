import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { Project } from '../../domain/entities/Project';
import { encrypt } from '../../infrastructure/crypto';
import { randomToken } from '../../infrastructure/security/tokens';
import { ensureSubdomain } from '../../infrastructure/security/slug';
import { AuditService } from '../audit/AuditService';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';

export class DiscoveryService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private projectRepo = AppDataSource.getRepository(Project);
  private auditService = new AuditService();
  private storageService = new SqliteStorageService();

  async scanMountedDirectory(projectId: string, rootPath?: string, adopt = false) {
    const baseDir = rootPath || process.env.SQLITE_DISCOVERY_PATH;
    if (!baseDir) {
      throw new Error('SQLITE_DISCOVERY_PATH not configured');
    }

    const requirePrimary = parseEnvBoolean(process.env.LIBSQL_REQUIRE_PRIMARY, false);
    const allowLocal = parseEnvBoolean(process.env.LIBSQL_ALLOW_LOCAL_FILE, !requirePrimary);
    if (requirePrimary && !allowLocal) {
      // Discovery registers files as LOCAL-FILE records. Under the libSQL-first
      // policy those would be new legacy databases, so skip instead of creating
      // records that violate the policy.
      return {
        discovered: [],
        count: 0,
        baseDir,
        skipped: true,
        reason: 'LOCAL-FILE discovery is disabled. Import the files with storageMode=auto instead.',
      };
    }

    const project = await this.projectRepo.findOneByOrFail({ id: projectId });
    const files = this.collectSqliteFiles(baseDir);
    const discovered: Database[] = [];

    for (const filePath of files) {
      const existing = await this.databaseRepo.findOne({ where: { url: filePath }, relations: ['project'] });
      if (existing) {
        discovered.push(existing);
        continue;
      }

      const fileName = path.basename(filePath, path.extname(filePath));
      const database = await this.databaseRepo.save(this.databaseRepo.create({
        name: fileName,
        type: 'sqlite',
        url: filePath,
        encryptedToken: encrypt(randomToken()),
        subdomain: ensureSubdomain(fileName, path.parse(filePath).name),
        status: 'active',
        metadata: { sourcePath: filePath, discovered: true, mountedDirectory: baseDir, adopted: adopt },
        project,
      }));

      if (adopt) {
        const managedPath = await this.storageService.adoptExistingFile(filePath, project.id, database.id);
        database.url = managedPath;
        database.metadata = { ...(database.metadata ?? {}), managedPath, adopted: true };
        await this.databaseRepo.save(database);
      }

      discovered.push(database);
      await this.auditService.record({
        action: 'database.discovered',
        resourceType: 'database',
        resourceId: database.id,
        metadata: { filePath, baseDir, adopted: adopt },
      });
    }

    return { discovered, count: discovered.length, baseDir };
  }

  private collectSqliteFiles(rootPath: string) {
    const results: string[] = [];
    const ignoredDirectories = new Set(['projects', 'snapshots']);
    const visit = (currentPath: string) => {
      if (!fs.existsSync(currentPath)) return;
      const stat = fs.statSync(currentPath);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(currentPath)) {
          if (ignoredDirectories.has(entry)) continue;
          visit(path.join(currentPath, entry));
        }
        return;
      }

      if (path.basename(currentPath).startsWith('.tmp-')) return;
      if (/\.db$/i.test(currentPath)) {
        results.push(currentPath);
      }
    };

    visit(rootPath);
    return results;
  }
}

function parseEnvBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}
