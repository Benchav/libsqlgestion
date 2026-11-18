import fs from 'fs';
import path from 'path';

type LocalDatabaseInput = {
  id: string;
  type?: string;
  url?: string | null;
  project?: { id?: string } | null;
};

export type ResolveLocalDatabasePathOptions = {
  storageRoot?: string;
  createIfMissing?: boolean;
};

/**
 * Resolves the on-disk path of a LOCAL-FILE SQLite database.
 *
 * The resolver intentionally mirrors the historical ConnectionPool behaviour,
 * but can be used in read-only mode (createIfMissing=false) by snapshots and
 * other maintenance tasks so they never create empty database files.
 */
export function resolveLocalDatabasePath(
  database: LocalDatabaseInput,
  options: ResolveLocalDatabasePathOptions = {},
): string | null {
  const storageRoot = options.storageRoot || process.env.SQLITE_STORAGE_ROOT || path.join(process.cwd(), 'data', 'sqlite');
  const createIfMissing = options.createIfMissing === true;
  let filePath = database.url || '';

  // 1. Direct path exists.
  if (!filePath || !fs.existsSync(filePath)) {
    // 2. If database.url contains 'projects/...', re-base onto current storageRoot.
    if (filePath && filePath.includes('projects')) {
      const relativeSub = filePath.substring(filePath.indexOf('projects'));
      const candidate = path.join(storageRoot, relativeSub);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
      }
    }
  }

  // 3. Try standard managed paths if project id is available.
  if (!filePath || !fs.existsSync(filePath)) {
    if (database.project?.id) {
      const flatDb = path.join(storageRoot, 'projects', database.project.id, 'databases', `${database.id}.db`);
      const nestedData = path.join(storageRoot, 'projects', database.project.id, 'databases', database.id, 'dbs', 'default', 'data');
      if (fs.existsSync(flatDb)) {
        filePath = flatDb;
      } else if (fs.existsSync(nestedData)) {
        filePath = nestedData;
      }
    }
  }

  // 4. Scan projects directory in storageRoot for any matching database id file.
  if (!filePath || !fs.existsSync(filePath)) {
    try {
      const projectsDir = path.join(storageRoot, 'projects');
      if (fs.existsSync(projectsDir)) {
        for (const projectDir of fs.readdirSync(projectsDir)) {
          const flatCandidate = path.join(projectsDir, projectDir, 'databases', `${database.id}.db`);
          const nestedCandidate = path.join(projectsDir, projectDir, 'databases', database.id, 'dbs', 'default', 'data');
          if (fs.existsSync(flatCandidate)) {
            filePath = flatCandidate;
            break;
          }
          if (fs.existsSync(nestedCandidate)) {
            filePath = nestedCandidate;
            break;
          }
        }
      }
    } catch {
      // Ignore scanning errors; the caller decides what to do with a missing file.
    }
  }

  if (filePath && fs.existsSync(filePath)) {
    return filePath;
  }

  if (!createIfMissing) {
    return null;
  }

  // 5. Legacy behaviour: initialize an empty SQLite database if the record exists.
  const projectId = database.project?.id || 'default';
  filePath = path.join(storageRoot, 'projects', projectId, 'databases', `${database.id}.db`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, Buffer.from(''));
  }
  return filePath;
}
