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

  snapshotRootDirectory() {
    return process.env.SNAPSHOT_STORAGE_ROOT || path.join(this.storageRoot, 'snapshots');
  }

  snapshotDirectory(projectId: string, databaseId: string) {
    return path.join(this.snapshotRootDirectory(), projectId, databaseId);
  }

  snapshotFilePath(projectId: string, databaseId: string, fileName: string) {
    return path.join(this.snapshotDirectory(projectId, databaseId), fileName);
  }

  async restoreSnapshotFile(sourcePath: string, projectId: string, databaseId: string) {
    const targetPath = this.managedDatabasePath(projectId, databaseId, 'sqlite');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const tempTargetPath = `${targetPath}.restore-${Date.now()}.tmp`;
    await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);

    try {
      await fsp.copyFile(sourcePath, tempTargetPath);
      const handle = await fsp.open(tempTargetPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rm(targetPath, { force: true }).catch(() => undefined);
      await fsp.rename(tempTargetPath, targetPath);
      return targetPath;
    } catch (error) {
      await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);
      throw error;
    }
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

  async importDatabaseFile(
    sourcePath: string,
    projectId: string,
    databaseId: string,
    type?: string,
    options: { consistentSnapshot?: boolean; moveSource?: boolean } = {},
  ) {
    const targetPath = this.managedDatabasePath(projectId, databaseId, type);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    await this.copySqliteFile(sourcePath, targetPath, options);
    if (type === 'libsql') {
      this.applySqldOwnership(path.dirname(targetPath), targetPath);
    }

    return targetPath;
  }

  async importToNamespace(
    sourcePath: string,
    namespace: string,
    options: { consistentSnapshot?: boolean; moveSource?: boolean } = {},
  ) {
    const targetPath = this.namespaceDatabasePath(namespace);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    await this.copySqliteFile(sourcePath, targetPath, options);
    this.applySqldOwnership(path.dirname(targetPath), targetPath);

    return targetPath;
  }

  private async copySqliteFile(
    sourcePath: string,
    targetPath: string,
    options: { consistentSnapshot?: boolean; moveSource?: boolean },
  ) {
    const tempTargetPath = `${targetPath}.import-${Date.now()}.tmp`;
    await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);
    this.assertSqliteHeader(sourcePath);

    try {
      if (options.moveSource) {
        // Uploaded files live in a staging directory on the same data volume.
        // Rename avoids copying the file a second time. Fall back to copy when
        // staging is configured on another filesystem.
        try {
          await fsp.rename(sourcePath, tempTargetPath);
        } catch (error: any) {
          if (error?.code !== 'EXDEV') throw error;
          await fsp.copyFile(sourcePath, tempTargetPath);
        }
      } else if (options.consistentSnapshot === false) {
        // Uploaded files are already a closed snapshot in a staging directory.
        await fsp.copyFile(sourcePath, tempTargetPath);
      } else {
        // Server paths may belong to a live ERP database. VACUUM INTO captures
        // committed WAL contents without blocking the source for long.
        const client = new SqliteClient(sourcePath);
        try {
          await client.exec(`VACUUM INTO '${escapeSqliteString(tempTargetPath)}';`);
        } finally {
          await client.close();
        }
      }

      await fsp.rm(targetPath, { force: true }).catch(() => undefined);
      await fsp.rename(tempTargetPath, targetPath);
    } catch (error) {
      await fsp.rm(tempTargetPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private assertSqliteHeader(filePath: string) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      const magic = header.toString('ascii', 0, 15);
      if (bytesRead < 16 || magic !== 'SQLite format 3') {
        const error: any = new Error(
          'The selected file is not a valid SQLite database (missing SQLite header).',
        );
        error.statusCode = 422;
        throw error;
      }
    } catch (error: any) {
      if (error?.statusCode) throw error;
      const wrapped: any = new Error(`Unable to read the SQLite file: ${error?.message || error}`);
      wrapped.statusCode = 422;
      throw wrapped;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best effort.
        }
      }
    }
  }

  async adoptExistingFile(sourcePath: string, projectId: string, databaseId: string, type?: string) {
    return this.importDatabaseFile(sourcePath, projectId, databaseId, type);
  }

  isManagedPath(filePath: string) {
    const normalizedRoot = path.normalize(this.storageRoot) + path.sep;
    const normalizedPath = path.normalize(filePath);
    return normalizedPath.startsWith(normalizedRoot);
  }

  private applySqldOwnership(directory: string, file: string) {
    if (process.platform === 'win32') {
      return;
    }

    const uid = Number(process.env.SQLD_UID || 666);
    const gid = Number(process.env.SQLD_GID || 666);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
      return;
    }

    try {
      fs.chownSync(directory, uid, gid);
      fs.chownSync(file, uid, gid);
    } catch (error: any) {
      console.warn(`[SqliteStorageService] Could not set sqld ownership on ${file}: ${error?.message || error}`);
    }
  }
}
