import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { SqliteStorageService } from '../../infrastructure/storage/SqliteStorageService';
import { resolveLocalDatabasePath } from '../databases/local-database-path';
import { analyticsCollector } from './AnalyticsCollector';
import { getAnalyticsConfig } from './analytics-config';

function fileSizeWithSidecars(filePath: string) {
  let total = 0;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try {
      if (fs.existsSync(candidate)) {
        total += fs.statSync(candidate).size;
      }
    } catch {
      // Ignore individual file stat failures.
    }
  }
  return total;
}

export class StorageSampler {
  private databaseRepo = AppDataSource.getRepository(Database);
  private storageService = new SqliteStorageService();
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;

  start() {
    const config = getAnalyticsConfig();
    if (!config.enabled || this.timer) return;

    const tick = () => {
      void this.sample();
    };
    this.initialTimer = setTimeout(tick, 60_000);
    this.initialTimer.unref?.();
    this.timer = setInterval(tick, config.storageSampleMinutes * 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sample() {
    const databases = await this.databaseRepo.find({ relations: ['project'] });
    for (const database of databases) {
      const runtimePath = (database.metadata?.runtime as any)?.databasePath;
      const candidates = new Set<string>();

      if (typeof runtimePath === 'string') candidates.add(runtimePath);
      if (database.url && !/^(https?|libsql|ws):\/\//i.test(database.url)) candidates.add(database.url);

      const resolved = resolveLocalDatabasePath(database, { createIfMissing: false });
      if (resolved) candidates.add(resolved);

      if (database.project?.id) {
        const managed = this.storageService.managedDatabasePath(database.project.id, database.id, database.type);
        candidates.add(managed);
      }

      let sizeBytes = 0;
      for (const candidate of candidates) {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
          sizeBytes = Math.max(sizeBytes, fileSizeWithSidecars(candidate));
        }
      }

      analyticsCollector.recordStorage({
        databaseId: database.id,
        projectId: database.project?.id,
        sizeBytes,
      });
    }
  }
}
