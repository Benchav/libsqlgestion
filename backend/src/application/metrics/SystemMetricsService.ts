import fs from 'fs';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { LibsqlRuntimeService } from '../../infrastructure/docker/LibsqlRuntimeService';
import { ConnectionPool } from '../../infrastructure/db/ConnectionPool';
import { resolveEffectiveDatabaseType } from '../databases/database-runtime';

import os from 'os';

export type DatabaseMetric = {
  id: string;
  name: string;
  type: string;
  effectiveType: string;
  status: string;
  diskBytes: number;
  ramBytes: number;
  isRamEstimated: boolean;
  runtimeProvider?: string;
  runtimeHealth?: {
    internalOk: boolean;
    backendOk: boolean;
    publicOk: boolean;
    publicChecked: boolean;
  } | null;
};

export type SystemMetrics = {
  totalDiskBytes: number;
  totalRamBytes: number;
  maxRamBytes: number;
  cpuUsagePercent: number;
  runtimeSummary: {
    publicRuntimeCount: number;
    healthyPublicRuntimeCount: number;
    unhealthyPublicRuntimeCount: number;
    provisioningCount: number;
    errorCount: number;
  };
  pool: {
    size: number;
    maxSize: number;
    idleTtlMs: number;
  };
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
    let publicRuntimeCount = 0;
    let healthyPublicRuntimeCount = 0;
    let unhealthyPublicRuntimeCount = 0;
    let provisioningCount = 0;
    let errorCount = 0;

    for (const db of databases) {
      let diskBytes = 0;
      let ramBytes = 0;
      let isRamEstimated = false;
      const effectiveType = resolveEffectiveDatabaseType(db);

      // 1. Calculate Disk Usage
      const fileCandidates = new Set<string>();
      if (effectiveType === 'sqlite' && db.url) {
        fileCandidates.add(db.url);
      }
      
      const runtimeMetadata: any = db.metadata?.runtime;
      const runtimeHealth = runtimeMetadata?.routeHealth && typeof runtimeMetadata.routeHealth === 'object'
        ? {
            internalOk: Boolean(runtimeMetadata.routeHealth.internalOk),
            backendOk: Boolean(runtimeMetadata.routeHealth.backendOk),
            publicOk: Boolean(runtimeMetadata.routeHealth.publicOk),
            publicChecked: Boolean(runtimeMetadata.routeHealth.publicChecked),
          }
        : null;

      if (db.status === 'provisioning') provisioningCount += 1;
      if (db.status === 'error') errorCount += 1;
      if (runtimeMetadata?.provider === 'docker-libsql') {
        publicRuntimeCount += 1;
        if (runtimeHealth?.internalOk && runtimeHealth?.backendOk && (!runtimeHealth.publicChecked || runtimeHealth.publicOk)) {
          healthyPublicRuntimeCount += 1;
        } else {
          unhealthyPublicRuntimeCount += 1;
        }
      }

      if (runtimeMetadata?.provider === 'docker-libsql' && runtimeMetadata.databasePath) {
        fileCandidates.add(runtimeMetadata.databasePath);
      }

      for (const filePath of fileCandidates) {
        diskBytes += this.getFileSizeSafe(filePath);
        diskBytes += this.getFileSizeSafe(`${filePath}-wal`);
        diskBytes += this.getFileSizeSafe(`${filePath}-shm`);
      }

      // 2. Calculate RAM Usage
      if (effectiveType === 'sqlite') {
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
        effectiveType,
        status: db.status,
        diskBytes,
        ramBytes,
        isRamEstimated,
        runtimeProvider: typeof runtimeMetadata?.provider === 'string' ? runtimeMetadata.provider : undefined,
        runtimeHealth,
      });
    }

    // Sort by largest disk/ram
    metrics.sort((a, b) => b.ramBytes - a.ramBytes || b.diskBytes - a.diskBytes);

    const maxRamBytes = os.totalmem();
    // Rough estimate of CPU load % over the last 1 minute on the server
    const cpus = os.cpus().length;
    const cpuUsagePercent = Math.min(100, Math.max(0, (os.loadavg()[0] / cpus) * 100));

    return {
      totalDiskBytes,
      totalRamBytes,
      maxRamBytes,
      cpuUsagePercent,
      runtimeSummary: {
        publicRuntimeCount,
        healthyPublicRuntimeCount,
        unhealthyPublicRuntimeCount,
        provisioningCount,
        errorCount,
      },
      pool: pool.stats,
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
