import fs from 'fs';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { LibsqlRuntimeService } from '../../infrastructure/docker/LibsqlRuntimeService';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';

export type DatabaseMetric = {
  id: string;
  name: string;
  type: string;
  diskBytes: number;
  ramBytes: number;
  isRamEstimated: boolean;
};

export type SystemMetrics = {
  totalDiskBytes: number;
  totalRamBytes: number;
  databases: DatabaseMetric[];
};

export class SystemMetricsService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private runtimeService = new LibsqlRuntimeService();

  async getMetrics(): Promise<SystemMetrics> {
    const databases = await this.databaseRepo.find();
    const pool = ConnectionPool.getInstance();

    let totalDiskBytes = 0;
    // Node.js base memory usage (RSS)
    let totalRamBytes = process.memoryUsage().rss;

    const metrics: DatabaseMetric[] = [];

    for (const db of databases) {
      let diskBytes = 0;
      let ramBytes = 0;
      let isRamEstimated = false;

      // 1. Calculate Disk Usage
      const fileCandidates = new Set<string>();
      if (db.type === 'sqlite' && db.url) {
        fileCandidates.add(db.url);
      }
      
      const runtimeMetadata: any = db.metadata?.runtime;
      if (runtimeMetadata?.provider === 'docker-libsql' && runtimeMetadata.databasePath) {
        fileCandidates.add(runtimeMetadata.databasePath);
      }

      for (const filePath of fileCandidates) {
        diskBytes += this.getFileSizeSafe(filePath);
        diskBytes += this.getFileSizeSafe(`${filePath}-wal`);
        diskBytes += this.getFileSizeSafe(`${filePath}-shm`);
      }

      // 2. Calculate RAM Usage
      if (db.type === 'sqlite') {
        isRamEstimated = true;
        // If it's active in the pool, we estimate ~20MB for the PRAGMA cache + SQLite structures
        // If not, we estimate 0MB. The memory is shared in the Node process anyway.
        if ((pool as any).pool.has(db.id)) {
          ramBytes = 25 * 1024 * 1024; // 25MB estimate
        } else {
          ramBytes = 0;
        }
      } else {
        // LibSQL Docker container
        isRamEstimated = false;
        if (runtimeMetadata?.containerId) {
          const stats = await this.runtimeService.getContainerStats(runtimeMetadata.containerId);
          ramBytes = stats.memoryBytes;
          totalRamBytes += ramBytes; // Add container memory to total server memory
        }
      }

      totalDiskBytes += diskBytes;

      metrics.push({
        id: db.id,
        name: db.name,
        type: db.type,
        diskBytes,
        ramBytes,
        isRamEstimated,
      });
    }

    // Sort by largest disk/ram
    metrics.sort((a, b) => b.ramBytes - a.ramBytes || b.diskBytes - a.diskBytes);

    return {
      totalDiskBytes,
      totalRamBytes,
      databases: metrics,
    };
  }

  private getFileSizeSafe(filePath: string): number {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        return stat.size;
      }
    } catch {
      // Ignore
    }
    return 0;
  }
}
