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
  sampledAt: string;
  cacheTtlMs: number;
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

type MetricsCacheEntry = {
  at: number;
  value: SystemMetrics;
};

let metricsCache: MetricsCacheEntry | null = null;
let metricsInFlight: Promise<SystemMetrics> | null = null;

function metricsCacheTtlMs() {
  const parsed = Number(process.env.METRICS_CACHE_TTL_MS || 5000);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 5000;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));

  return results;
}

export class SystemMetricsService {
  private databaseRepo = AppDataSource.getRepository(Database);
  private runtimeService = new LibsqlRuntimeService();

  async getMetrics(force = false): Promise<SystemMetrics> {
    const ttl = metricsCacheTtlMs();
    if (!force && metricsCache && Date.now() - metricsCache.at < ttl) {
      return metricsCache.value;
    }
    if (metricsInFlight) {
      return metricsInFlight;
    }

    metricsInFlight = this.buildMetrics().then((value) => {
      metricsCache = { at: Date.now(), value };
      return value;
    }).finally(() => {
      metricsInFlight = null;
    });

    return metricsInFlight;
  }

  private async buildMetrics(): Promise<SystemMetrics> {
    const databases = await this.databaseRepo.find();
    const pool = ConnectionPool.getInstance();

    let totalDiskBytes = 0;
    // Node.js base memory usage (RSS)
    let totalRamBytes = process.memoryUsage().rss;

    const metrics: DatabaseMetric[] = [];
    const statsTargets: Array<{ metric: DatabaseMetric; containerId: string }> = [];
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
        // LibSQL Docker container stats are collected after the loop with a
        // concurrency limit so one slow container cannot serialize the page.
        isRamEstimated = false;
      }

      totalDiskBytes += diskBytes;

      const metric: DatabaseMetric = {
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
      };
      metrics.push(metric);

      if (effectiveType === 'libsql' && typeof runtimeMetadata?.containerId === 'string') {
        statsTargets.push({ metric, containerId: runtimeMetadata.containerId });
      }
    }

    await mapWithConcurrency(statsTargets, 4, async ({ metric, containerId }) => {
      const stats = await this.runtimeService.getContainerStats(containerId);
      metric.ramBytes = stats.memoryBytes;
      totalRamBytes += stats.memoryBytes;
      return null;
    });

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
      sampledAt: new Date().toISOString(),
      cacheTtlMs: metricsCacheTtlMs(),
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
