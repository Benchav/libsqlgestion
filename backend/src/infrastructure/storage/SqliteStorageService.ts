import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';
import { SqliteClient } from '../sqlite/SqliteClient';

function escapeSqliteString(value: string) {
  return value.replace(/'/g, "''");
}

export class SqliteStorageService {
  private readonly storageRoot: string;

  constructor(storageRoot?: string) {
    this.storageRoot = storageRoot || process.env.SQLITE_STORAGE_ROOT || path.join(process.cwd(), 'data', 'sqlite');
  }

  managedDatabasePath(projectId: string, databaseId: string, type?: string) {
    if (type === 'libsql') {
      return path.join(this.storageRoot, 'projects', projectId, 'databases', databaseId, 'dbs', 'default', 'data');
    }
    return path.join(this.storageRoot, 'projects', projectId, 'databases', `${databaseId}.db`);
  }

  namespaceDatabasePath(namespace: string) {
    const sqldRoot = process.env.SQLD_DATA_DIR || path.join(process.cwd(), 'data', 'sqld');
    return path.join(sqldRoot, 'data', 'dbs', namespace, 'data');
  }

  managedDatabaseDirectory(projectId: string, databaseId: string) {
    return path.join(this.storageRoot, 'projects', projectId, 'databases', databaseId);
  }

  managedProjectDirectory(projectId: string) {
    return path.join(this.storageRoot, 'projects', projectId, 'databases');
  }

  async ensureManagedDatabaseFile(projectId: string, databaseId: string, type?: string) {
    const filePath = this.managedDatabasePath(projectId, databaseId, type);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Handle legacy migration if a flat file exists at .../databases/<databaseId>/data
    if (type === 'libsql') {
      const legacyFlatPath = path.join(this.storageRoot, 'projects', projectId, 'databases', databaseId, 'data');
      if (fs.existsSync(legacyFlatPath) && fs.statSync(legacyFlatPath).isFile() && !fs.existsSync(filePath)) {
        fs.renameSync(legacyFlatPath, filePath);
      }
    }

    // Do NOT create an empty file for libsql — sqld will create a valid SQLite database
    // on first start if the file doesn't exist. A 0-byte file would be treated
    // as corrupt and cause the container to crash.
    if (type !== 'libsql' && !fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(''));
    }
    return filePath;
  }

  async importDatabaseFile(sourcePath: string, projectId: string, databaseId: string, type?: string) {
    const targetPath = this.managedDatabasePath(projectId, databaseId, type);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const tempTargetPath = `${targetPath}.import-${Date.now()}.tmp`;
    await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);

    try {
      // Create a consistent snapshot from the live SQLite database.
      // This captures committed WAL contents as seen by SQLite and avoids
      // importing a stale/blank main database file from ERP workloads.
      const client = new SqliteClient(sourcePath);
      try {
        await client.exec(`VACUUM INTO '${escapeSqliteString(tempTargetPath)}';`);
      } finally {
        await client.close();
      }

      await fsp.rm(targetPath, { force: true }).catch(() => undefined);
      await fsp.rename(tempTargetPath, targetPath);
    } catch (error) {
      await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return targetPath;
  }

  async importToNamespace(sourcePath: string, namespace: string) {
    const targetPath = this.namespaceDatabasePath(namespace);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const tempTargetPath = `${targetPath}.import-${Date.now()}.tmp`;
    await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);

    try {
      const client = new SqliteClient(sourcePath);
      try {
        await client.exec(`VACUUM INTO '${escapeSqliteString(tempTargetPath)}';`);
      } finally {
        await client.close();
      }

      await fsp.rm(targetPath, { force: true }).catch(() => undefined);
      await fsp.rename(tempTargetPath, targetPath);
    } catch (error) {
      await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return targetPath;
  }

  async adoptExistingFile(sourcePath: string, projectId: string, databaseId: string, type?: string) {
    return this.importDatabaseFile(sourcePath, projectId, databaseId, type);
  }

  isManagedPath(filePath: string) {
    const normalizedRoot = path.normalize(this.storageRoot) + path.sep;
    const normalizedPath = path.normalize(filePath);
    return normalizedPath.startsWith(normalizedRoot);
  }
}
