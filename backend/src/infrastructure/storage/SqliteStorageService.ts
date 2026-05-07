import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';

export class SqliteStorageService {
  private readonly storageRoot: string;

  constructor(storageRoot?: string) {
    this.storageRoot = storageRoot || process.env.SQLITE_STORAGE_ROOT || path.join(process.cwd(), 'data', 'sqlite');
  }

  managedDatabasePath(projectId: string, databaseId: string) {
    return path.join(this.storageRoot, 'projects', projectId, 'databases', `${databaseId}.db`);
  }

  managedProjectDirectory(projectId: string) {
    return path.join(this.storageRoot, 'projects', projectId, 'databases');
  }

  async ensureManagedDatabaseFile(projectId: string, databaseId: string) {
    const filePath = this.managedDatabasePath(projectId, databaseId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Do NOT create an empty file — sqld will create a valid SQLite database
    // on first start if the file doesn't exist. A 0-byte file would be treated
    // as corrupt and cause the container to crash.
    return filePath;
  }

  async importDatabaseFile(sourcePath: string, projectId: string, databaseId: string) {
    const targetPath = this.managedDatabasePath(projectId, databaseId);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
    return targetPath;
  }

  async adoptExistingFile(sourcePath: string, projectId: string, databaseId: string) {
    return this.importDatabaseFile(sourcePath, projectId, databaseId);
  }

  isManagedPath(filePath: string) {
    const normalizedRoot = path.normalize(this.storageRoot) + path.sep;
    const normalizedPath = path.normalize(filePath);
    return normalizedPath.startsWith(normalizedRoot);
  }
}
