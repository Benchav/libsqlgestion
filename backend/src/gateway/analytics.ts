import http from 'http';
import https from 'https';
import { URL } from 'url';
import { normalizeSql } from '../application/analytics/sql-normalizer';

export type GatewayQueryMetric = {
  databaseId: string;
  sql: string;
  durationMs: number;
  rowsRead?: number;
  rowsWritten?: number;
  success?: boolean;
  errorCode?: string;
};

export type GatewayTrafficMetric = {
  databaseId?: string;
  method: string;
  path: string;
  requestBytes?: number;
  responseBytes?: number;
  statusCode?: number;
  durationMs?: number;
};

type GatewayAnalyticsConfig = {
  enabled: boolean;
  url: string;
  token: string;
  flushIntervalMs: number;
  maxQueue: number;
  batchSize: number;
  timeoutMs: number;
};

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function booleanValue(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function backendBaseUrl() {
  return (process.env.GATEWAY_BACKEND_INTERNAL_URL || 'http://backend:5000').replace(/\/+$/, '');
}

export function getGatewayAnalyticsConfig(): GatewayAnalyticsConfig {
  return {
    enabled: booleanValue(process.env.GATEWAY_ANALYTICS_ENABLED, true),
    url: process.env.GATEWAY_ANALYTICS_URL?.trim()
      || `${backendBaseUrl()}/api/v1/internal/gateway/analytics`,
    token: process.env.GATEWAY_INTERNAL_TOKEN?.trim() || '',
    flushIntervalMs: positiveInt(process.env.GATEWAY_ANALYTICS_FLUSH_MS, 1_000),
    maxQueue: positiveInt(process.env.GATEWAY_ANALYTICS_MAX_QUEUE, 5_000),
    // The ingest schema accepts at most 500 rows per array.
    batchSize: Math.min(500, positiveInt(process.env.GATEWAY_ANALYTICS_BATCH_SIZE, 500)),
    timeoutMs: positiveInt(process.env.GATEWAY_ANALYTICS_TIMEOUT_MS, 5_000),
  };
}

function postJson(url: string, token: string, payload: unknown, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload));
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-gateway-token': token,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          resolve();
          return;
        }
        reject(new Error(
          `analytics backend returned ${status}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`,
        ));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`analytics request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Best-effort metrics buffer for the policy gateway. It never blocks SQL
 * execution: if the backend is down or slow, metrics are retried and eventually
 * dropped while database traffic continues normally.
 */
export class GatewayAnalyticsClient {
  private queryQueue: GatewayQueryMetric[] = [];
  private trafficQueue: GatewayTrafficMetric[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushingPromise: Promise<void> | null = null;
  private lastWarningAt = 0;

  constructor(private readonly config: GatewayAnalyticsConfig = getGatewayAnalyticsConfig()) {}

  get enabled() {
    return this.config.enabled && Boolean(this.config.token);
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  recordQuery(metric: GatewayQueryMetric) {
    if (!this.enabled) return;
    // Redact literals before the metric leaves the gateway process. The
    // backend stores this preview and never needs the original parameter values.
    const sql = normalizeSql(metric.sql).slice(0, 2_000);
    this.queryQueue.push({ ...metric, sql: sql || '(unavailable SQL preview)' });
    this.trimQueues();
  }

  recordTraffic(metric: GatewayTrafficMetric) {
    if (!this.enabled) return;
    this.trafficQueue.push(metric);
    this.trimQueues();
  }

  async flush() {
    if (!this.enabled) return;
    if (this.flushingPromise) return this.flushingPromise;
    if (this.queryQueue.length === 0 && this.trafficQueue.length === 0) return;

    this.flushingPromise = this.doFlush().finally(() => {
      this.flushingPromise = null;
    });
    return this.flushingPromise;
  }

  private async doFlush() {
    const queries = this.queryQueue.splice(0, this.config.batchSize);
    const traffic = this.trafficQueue.splice(0, this.config.batchSize);

    try {
      await postJson(this.config.url, this.config.token, { queries, traffic }, this.config.timeoutMs);
    } catch (error: any) {
      // Preserve the batch for the next attempt, but keep the queue bounded.
      this.queryQueue.unshift(...queries);
      this.trafficQueue.unshift(...traffic);
      this.trimQueues();

      const now = Date.now();
      if (now - this.lastWarningAt > 60_000) {
        this.lastWarningAt = now;
        console.warn(`[gateway] analytics flush failed: ${error?.message || error}`);
      }
    }
  }

  private trimQueues() {
    if (this.queryQueue.length > this.config.maxQueue) {
      this.queryQueue.splice(0, this.queryQueue.length - this.config.maxQueue);
    }
    if (this.trafficQueue.length > this.config.maxQueue) {
      this.trafficQueue.splice(0, this.trafficQueue.length - this.config.maxQueue);
    }
  }
}
