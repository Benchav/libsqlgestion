import { AppDataSource } from '../../infrastructure/db/data-source';
import { QueryMetric } from '../../domain/entities/QueryMetric';
import { TrafficMetric } from '../../domain/entities/TrafficMetric';
import { StorageSample } from '../../domain/entities/StorageSample';
import { getAnalyticsConfig } from './analytics-config';
import { detectOperation, fingerprintSql, normalizeSql } from './sql-normalizer';

type QueryMetricInput = {
  databaseId: string;
  projectId?: string;
  source?: string;
  sql: string;
  durationMs: number;
  rowsRead?: number;
  rowsWritten?: number;
  success?: boolean;
  errorCode?: string;
};

type TrafficMetricInput = {
  databaseId?: string;
  method: string;
  path: string;
  requestBytes?: number;
  responseBytes?: number;
  statusCode?: number;
  durationMs?: number;
};

type StorageMetricInput = {
  databaseId: string;
  projectId?: string;
  sizeBytes: number;
};

const INSERT_CHUNK_SIZE = 500;

function chunkRows<T>(rows: T[], size = INSERT_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

export class AnalyticsCollector {
  private static instance: AnalyticsCollector | null = null;
  private queryQueue: QueryMetricInput[] = [];
  private trafficQueue: TrafficMetricInput[] = [];
  private storageQueue: StorageMetricInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private lastPruneAt = 0;

  static getInstance() {
    if (!AnalyticsCollector.instance) {
      AnalyticsCollector.instance = new AnalyticsCollector();
    }
    return AnalyticsCollector.instance;
  }

  start() {
    const config = getAnalyticsConfig();
    if (!config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, config.flushIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  recordQuery(input: QueryMetricInput) {
    const config = getAnalyticsConfig();
    if (!config.enabled) return;

    this.queryQueue.push(input);
    if (this.queryQueue.length > config.maxQueue) {
      this.queryQueue.splice(0, this.queryQueue.length - config.maxQueue);
    }
  }

  recordTraffic(input: TrafficMetricInput) {
    const config = getAnalyticsConfig();
    if (!config.enabled || !config.trafficEnabled) return;

    this.trafficQueue.push(input);
    if (this.trafficQueue.length > config.maxQueue) {
      this.trafficQueue.splice(0, this.trafficQueue.length - config.maxQueue);
    }
  }

  recordStorage(input: StorageMetricInput) {
    const config = getAnalyticsConfig();
    if (!config.enabled) return;

    this.storageQueue.push(input);
    if (this.storageQueue.length > config.maxQueue) {
      this.storageQueue.splice(0, this.storageQueue.length - config.maxQueue);
    }
  }

  get queueSize() {
    return this.queryQueue.length + this.trafficQueue.length + this.storageQueue.length;
  }

  async flush() {
    if (this.flushing || !AppDataSource.isInitialized) return;
    if (this.queryQueue.length === 0 && this.trafficQueue.length === 0 && this.storageQueue.length === 0) {
      return;
    }

    this.flushing = true;
    const queryRows = this.queryQueue.splice(0, this.queryQueue.length);
    const trafficRows = this.trafficQueue.splice(0, this.trafficQueue.length);
    const storageRows = this.storageQueue.splice(0, this.storageQueue.length);

    try {
      if (queryRows.length > 0) {
        const repo = AppDataSource.getRepository(QueryMetric);
        for (const chunk of chunkRows(queryRows)) {
          await repo.insert(chunk.map((row) => ({
            databaseId: row.databaseId,
            projectId: row.projectId,
            source: row.source || 'api',
            operation: detectOperation(row.sql),
            sqlFingerprint: fingerprintSql(row.sql),
            sqlPreview: normalizeSql(row.sql),
            durationMs: Math.max(0, Math.round(row.durationMs)),
            rowsRead: Math.max(0, Math.round(row.rowsRead || 0)),
            rowsWritten: Math.max(0, Math.round(row.rowsWritten || 0)),
            success: row.success !== false,
            errorCode: row.errorCode,
          })));
        }
      }

      if (trafficRows.length > 0) {
        const repo = AppDataSource.getRepository(TrafficMetric);
        for (const chunk of chunkRows(trafficRows)) {
          await repo.insert(chunk.map((row) => ({
            databaseId: row.databaseId,
            method: row.method,
            path: row.path,
            requestBytes: Math.max(0, Math.round(row.requestBytes || 0)),
            responseBytes: Math.max(0, Math.round(row.responseBytes || 0)),
            statusCode: row.statusCode || 0,
            durationMs: Math.max(0, Math.round(row.durationMs || 0)),
          })));
        }
      }

      if (storageRows.length > 0) {
        const repo = AppDataSource.getRepository(StorageSample);
        const sampledAt = new Date();
        for (const chunk of chunkRows(storageRows)) {
          await repo.insert(chunk.map((row) => ({
            databaseId: row.databaseId,
            projectId: row.projectId,
            sizeBytes: Math.max(0, Math.round(row.sizeBytes)),
            sampledAt,
          })));
        }
      }

      await this.pruneIfNeeded();
    } catch (error: any) {
      console.warn('[analytics] flush failed:', error?.message || error);
    } finally {
      this.flushing = false;
    }
  }

  private async pruneIfNeeded() {
    const now = Date.now();
    if (now - this.lastPruneAt < 60 * 60 * 1000) return;
    this.lastPruneAt = now;
    const config = getAnalyticsConfig();

    try {
      await AppDataSource.getRepository(QueryMetric)
        .createQueryBuilder()
        .delete()
        .where('createdAt < :cutoff', { cutoff: new Date(now - config.rawRetentionDays * 86_400_000) })
        .execute();
      await AppDataSource.getRepository(TrafficMetric)
        .createQueryBuilder()
        .delete()
        .where('createdAt < :cutoff', { cutoff: new Date(now - config.rawRetentionDays * 86_400_000) })
        .execute();
      await AppDataSource.getRepository(StorageSample)
        .createQueryBuilder()
        .delete()
        .where('sampledAt < :cutoff', { cutoff: new Date(now - config.storageRetentionDays * 86_400_000) })
        .execute();
    } catch (error: any) {
      console.warn('[analytics] retention cleanup failed:', error?.message || error);
    }
  }
}

export const analyticsCollector = AnalyticsCollector.getInstance();
