import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { getRuntimeProvider, resolveEffectiveDatabaseType } from '../databases/database-runtime';
import { isUuidLike } from '../shared/identifiers';

export type AnalyticsRange = 'today' | '7d' | '30d' | 'month';
export type AnalyticsBucket = 'hour' | 'day';
type QueryRank = 'duration' | 'rowsRead' | 'rowsWritten' | 'queries';

export type AnalyticsInput = {
  range?: AnalyticsRange;
  from?: string;
  to?: string;
  databaseId?: string;
};

type AnalyticsWindow = {
  from: Date;
  to: Date;
  bucket: AnalyticsBucket;
};

type BucketPlan = {
  labels: string[];
  fromMs: number;
  stepMs: number;
};

type DatabaseUsageRow = {
  id: string;
  name: string;
  displayName: string;
  needsRename: boolean;
  subdomain: string | null;
  projectId: string | null;
  projectName: string | null;
  type: string;
  status: string;
  runtimeProvider: string;
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  readQueries: number;
  writeQueries: number;
  otherQueries: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  lastSeenAt: string | null;
  lastSource: string | null;
  hasActivity: boolean;
  httpRequests: number;
  lastRequestAt: string | null;
  lastRequestPath: string | null;
  hasHttpActivity: boolean;
  storageBytes: number;
};

export type TrafficPathUsage = {
  path: string;
  requests: number;
  bytes: number;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 90 * DAY_MS;

const READ_OPERATION_SQL = "q.operation = 'select'";
const WRITE_OPERATION_SQL = "q.operation IN ('insert', 'update', 'delete', 'replace')";

function sqlDate(value: Date) {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function resolveWindow(range: AnalyticsRange = '30d', fromInput?: string, toInput?: string): AnalyticsWindow {
  const now = new Date();
  const to = toInput ? new Date(toInput) : now;
  if (!Number.isFinite(to.getTime())) throw new Error('invalid analytics to date');

  let from: Date;
  if (fromInput) {
    from = new Date(fromInput);
    if (!Number.isFinite(from.getTime())) throw new Error('invalid analytics from date');
  } else if (range === 'today') {
    from = startOfUtcDay(now);
  } else if (range === '7d') {
    from = new Date(now.getTime() - 7 * DAY_MS);
  } else if (range === 'month') {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else {
    from = new Date(now.getTime() - 30 * DAY_MS);
  }

  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    from = new Date(to.getTime() - MAX_RANGE_MS);
  }
  if (from.getTime() > to.getTime()) {
    from = startOfUtcDay(to);
  }

  return {
    from,
    to,
    bucket: to.getTime() - from.getTime() <= 48 * HOUR_MS ? 'hour' : 'day',
  };
}

function buildBucketPlan(window: AnalyticsWindow): BucketPlan {
  const stepMs = window.bucket === 'hour' ? HOUR_MS : DAY_MS;
  const fromMs = Math.floor(window.from.getTime() / 1000) * 1000;
  const toMs = window.to.getTime();
  const count = Math.max(1, Math.floor((toMs - fromMs) / stepMs) + 1);
  const labels = Array.from({ length: count }, (_, index) => new Date(fromMs + index * stepMs).toISOString());
  return { labels, fromMs, stepMs };
}

function bucketExpression(alias = 'q.createdAt') {
  return `CAST((CAST(strftime('%s', ${alias}) AS INTEGER) * 1000 - ?) / ? AS INTEGER)`;
}

function bucketSeries(
  labels: string[],
  rows: any[],
  value: (row: any) => number,
  fallback: number | null,
): Array<number | null> {
  const values: Array<number | null> = labels.map(() => fallback);
  for (const row of rows) {
    const index = Number(row.bucket);
    if (Number.isInteger(index) && index >= 0 && index < values.length) {
      values[index] = value(row);
    }
  }
  return values;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampToEpoch(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(normalized);
  const parsed = Date.parse(hasZone ? normalized : `${normalized}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampToIso(value: unknown): string | null {
  const epoch = timestampToEpoch(value);
  return epoch === null ? null : new Date(epoch).toISOString();
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function buildStorageSeries(labels: string[], fromMs: number, stepMs: number, baseline: any[], samples: any[]) {
  const latestByDatabase = new Map<string, number>();
  let total = 0;

  for (const row of baseline) {
    if (!row.databaseId) continue;
    const size = numberValue(row.sizeBytes);
    total += size;
    latestByDatabase.set(row.databaseId, size);
  }

  const points = samples
    .map((row) => ({
      databaseId: String(row.databaseId || ''),
      epoch: timestampToEpoch(row.sampledAt),
      sizeBytes: numberValue(row.sizeBytes),
    }))
    .filter((row) => row.databaseId && row.epoch !== null)
    .sort((left, right) => (left.epoch as number) - (right.epoch as number));

  const values: number[] = [];
  let pointIndex = 0;

  for (let index = 0; index < labels.length; index += 1) {
    const bucketEnd = fromMs + (index + 1) * stepMs;
    while (pointIndex < points.length && (points[pointIndex].epoch as number) <= bucketEnd) {
      const point = points[pointIndex];
      const previous = latestByDatabase.get(point.databaseId) ?? 0;
      total += point.sizeBytes - previous;
      latestByDatabase.set(point.databaseId, point.sizeBytes);
      pointIndex += 1;
    }
    values.push(Math.max(0, total));
  }

  return values;
}

export class AnalyticsService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async getOverview(input: AnalyticsInput = {}) {
    const window = resolveWindow(input.range, input.from, input.to);
    const plan = buildBucketPlan(window);
    const databaseId = input.databaseId?.trim() || undefined;
    const [
      summary,
      series,
      sources,
      statusCodes,
      operations,
      databaseUsage,
      topProjects,
      topQueries,
      topQueriesByRowsRead,
      topQueriesByRowsWritten,
      topQueriesByFrequency,
      topErrors,
      selectedDatabase,
      trafficPaths,
    ] = await Promise.all([
      this.getSummary(window, databaseId),
      this.getSeries(window, plan, databaseId),
      this.getSources(window, databaseId),
      this.getStatusCodes(window, databaseId),
      this.getOperations(window, databaseId),
      this.getDatabaseUsage(window),
      this.getTopProjects(window, databaseId),
      this.getTopQueries(window, 'duration', databaseId),
      this.getTopQueries(window, 'rowsRead', databaseId),
      this.getTopQueries(window, 'rowsWritten', databaseId),
      this.getTopQueries(window, 'queries', databaseId),
      this.getTopErrors(window, databaseId),
      this.getSelectedDatabase(databaseId),
      this.getTrafficPaths(window, databaseId),
    ]);

    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      bucket: window.bucket,
      databaseId: databaseId || null,
      database: selectedDatabase,
      summary,
      series,
      sources,
      statusCodes,
      operations,
      databaseUsage,
      trafficPaths,
      // Kept for backwards compatibility; the UI uses the full inventory.
      topDatabases: databaseUsage
        .filter((database) => database.queries > 0 && (!databaseId || database.id === databaseId))
        .slice(0, 10),
      topProjects,
      topQueries,
      topQueriesByRowsRead,
      topQueriesByRowsWritten,
      topQueriesByFrequency,
      topErrors,
    };
  }

  /**
   * Compact payload for the dashboard. It intentionally omits the expensive
   * top-query and error breakdowns that only the full Analytics page needs.
   */
  async getDashboard(input: AnalyticsInput = {}) {
    const window = resolveWindow(input.range, input.from, input.to);
    const plan = buildBucketPlan(window);
    const databaseId = input.databaseId?.trim() || undefined;
    const [summary, series, operations, databaseUsage, selectedDatabase] = await Promise.all([
      this.getSummary(window, databaseId),
      this.getSeries(window, plan, databaseId),
      this.getOperations(window, databaseId),
      this.getDatabaseUsage(window),
      this.getSelectedDatabase(databaseId),
    ]);

    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      bucket: window.bucket,
      databaseId: databaseId || null,
      database: selectedDatabase,
      summary,
      series,
      operations,
      databaseUsage,
      topDatabases: databaseUsage
        .filter((database) => database.queries > 0 && (!databaseId || database.id === databaseId))
        .slice(0, 5),
    };
  }

  private async getSummary(window: AnalyticsWindow, databaseId?: string) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);
    const databaseFilter = databaseId ? ' AND q.databaseId = ?' : '';
    const queryParams = databaseId ? [from, to, databaseId] : [from, to];
    const trafficFilter = databaseId
      ? ' AND t.databaseId = ?'
      : " AND (t.databaseId IS NULL OR t.databaseId = '' OR d.id IS NOT NULL)";
    const trafficParams = databaseId ? [from, to, databaseId] : [from, to];
    const storageFilter = databaseId ? ' AND s.databaseId = ?' : '';
    const storageParams = databaseId ? [databaseId] : [];

    const [queryRows, trafficRows, storageRows, totalDatabases] = await Promise.all([
      AppDataSource.query(
        `SELECT COUNT(*) AS queries,
                COALESCE(SUM(q.rowsRead), 0) AS rowsRead,
                COALESCE(SUM(q.rowsWritten), 0) AS rowsWritten,
                COALESCE(SUM(CASE WHEN q.success = 0 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(CASE WHEN ${READ_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS readQueries,
                COALESCE(SUM(CASE WHEN ${WRITE_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS writeQueries,
                COALESCE(AVG(q.durationMs), 0) AS avgDuration,
                COALESCE(MAX(q.durationMs), 0) AS maxDuration,
                COUNT(DISTINCT q.databaseId) AS activeDatabases
         FROM query_metrics q
         JOIN databases d ON d.id = q.databaseId
         WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseFilter}`,
        queryParams,
      ),
      AppDataSource.query(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(t.requestBytes), 0) AS inbound,
                COALESCE(SUM(t.responseBytes), 0) AS outbound
         FROM traffic_metrics t
         LEFT JOIN databases d ON d.id = t.databaseId
         WHERE t.createdAt >= ? AND t.createdAt <= ?${trafficFilter}`,
        trafficParams,
      ),
      AppDataSource.query(
        `SELECT COALESCE(SUM(s.sizeBytes), 0) AS storage
         FROM storage_samples s
         JOIN databases d ON d.id = s.databaseId
         WHERE s.sampledAt = (
           SELECT MAX(s2.sampledAt) FROM storage_samples s2 WHERE s2.databaseId = s.databaseId
         )${storageFilter}`,
        storageParams,
      ),
      databaseId
        ? this.databaseRepo.count({ where: { id: databaseId } })
        : this.databaseRepo.count(),
    ]);

    const row = queryRows[0] || {};
    const queries = numberValue(row.queries);
    const errors = numberValue(row.errors);
    const rowsRead = numberValue(row.rowsRead);
    const rowsWritten = numberValue(row.rowsWritten);
    const readQueries = numberValue(row.readQueries);
    const writeQueries = numberValue(row.writeQueries);
    let p95DurationMs = 0;

    if (queries > 0) {
      const offset = Math.min(queries - 1, Math.max(0, Math.floor(queries * 0.95)));
      const percentile = await AppDataSource.query(
        `SELECT q.durationMs
         FROM query_metrics q
         JOIN databases d ON d.id = q.databaseId
         WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseFilter}
         ORDER BY q.durationMs ASC LIMIT 1 OFFSET ?`,
        [...queryParams, offset],
      );
      p95DurationMs = numberValue(percentile[0]?.durationMs);
    }

    const traffic = trafficRows[0] || {};
    const windowHours = Math.max(1, (window.to.getTime() - window.from.getTime()) / HOUR_MS);

    return {
      rowsRead,
      rowsWritten,
      queries,
      errors,
      errorRate: queries > 0 ? errors / queries : 0,
      readQueries,
      writeQueries,
      otherQueries: Math.max(0, queries - readQueries - writeQueries),
      readWriteRatio: writeQueries > 0 ? readQueries / writeQueries : null,
      rowsReadPerQuery: readQueries > 0 ? rowsRead / readQueries : 0,
      rowsWrittenPerWrite: writeQueries > 0 ? rowsWritten / writeQueries : 0,
      queriesPerHour: queries / windowHours,
      avgDurationMs: Math.round(numberValue(row.avgDuration)),
      p95DurationMs,
      maxDurationMs: numberValue(row.maxDuration),
      storageBytes: numberValue(storageRows[0]?.storage),
      trafficInBytes: numberValue(traffic.inbound),
      trafficOutBytes: numberValue(traffic.outbound),
      requests: numberValue(traffic.requests),
      activeDatabases: numberValue(row.activeDatabases),
      totalDatabases,
      syncs: null,
    };
  }

  private async getSeries(window: AnalyticsWindow, plan: BucketPlan, databaseId?: string) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);
    const queryBucketSql = bucketExpression('q.createdAt');
    const trafficBucketSql = bucketExpression('t.createdAt');
    const databaseFilter = databaseId ? ' AND q.databaseId = ?' : '';
    const trafficFilter = databaseId
      ? ' AND t.databaseId = ?'
      : " AND (t.databaseId IS NULL OR t.databaseId = '' OR d.id IS NOT NULL)";
    const bucketParams = [
      plan.fromMs,
      plan.stepMs,
      from,
      to,
      ...(databaseId ? [databaseId] : []),
    ];

    const [queryRows, p95Rows, trafficRows, baselineStorage, windowStorage] = await Promise.all([
      AppDataSource.query(
        `SELECT ${queryBucketSql} AS bucket,
                COUNT(*) AS queries,
                COALESCE(SUM(CASE WHEN q.success = 0 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(CASE WHEN ${READ_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS readQueries,
                COALESCE(SUM(CASE WHEN ${WRITE_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS writeQueries,
                COALESCE(SUM(q.rowsRead), 0) AS rowsRead,
                COALESCE(SUM(q.rowsWritten), 0) AS rowsWritten,
                COALESCE(AVG(q.durationMs), 0) AS avgDuration,
                COALESCE(MAX(q.durationMs), 0) AS maxDuration
         FROM query_metrics q
         JOIN databases d ON d.id = q.databaseId
         WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseFilter}
         GROUP BY bucket ORDER BY bucket ASC`,
        bucketParams,
      ),
      AppDataSource.query(
        `WITH filtered AS (
           SELECT ${queryBucketSql} AS bucket, q.durationMs
           FROM query_metrics q
           JOIN databases d ON d.id = q.databaseId
           WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseFilter}
         ),
         ranked AS (
           SELECT bucket,
                  durationMs,
                  ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY durationMs ASC) AS rn,
                  COUNT(*) OVER (PARTITION BY bucket) AS cnt
           FROM filtered
         )
         SELECT bucket, durationMs AS p95
         FROM ranked
         WHERE rn = CAST((cnt * 95 + 99) / 100 AS INTEGER)`,
        bucketParams,
      ),
      AppDataSource.query(
        `SELECT ${trafficBucketSql} AS bucket,
                COUNT(*) AS requests,
                COALESCE(SUM(t.requestBytes), 0) AS inbound,
                COALESCE(SUM(t.responseBytes), 0) AS outbound
         FROM traffic_metrics t
         LEFT JOIN databases d ON d.id = t.databaseId
         WHERE t.createdAt >= ? AND t.createdAt <= ?${trafficFilter}
         GROUP BY bucket ORDER BY bucket ASC`,
        bucketParams,
      ),
      AppDataSource.query(
        `SELECT s.databaseId, s.sizeBytes
         FROM storage_samples s
         JOIN databases d ON d.id = s.databaseId
         JOIN (
           SELECT databaseId, MAX(sampledAt) AS sampledAt
           FROM storage_samples
           WHERE sampledAt <= ?
           GROUP BY databaseId
         ) latest
           ON latest.databaseId = s.databaseId AND latest.sampledAt = s.sampledAt
         ${databaseId ? 'WHERE s.databaseId = ?' : ''}
         GROUP BY s.databaseId`,
        [from, ...(databaseId ? [databaseId] : [])],
      ),
      AppDataSource.query(
        `SELECT s.databaseId, s.sampledAt, s.sizeBytes
         FROM storage_samples s
         JOIN databases d ON d.id = s.databaseId
         WHERE s.sampledAt > ? AND s.sampledAt <= ?${databaseId ? ' AND s.databaseId = ?' : ''}
         ORDER BY s.sampledAt ASC`,
        [from, to, ...(databaseId ? [databaseId] : [])],
      ),
    ]);

    const labels = plan.labels;
    const queryMap = new Map<number, any>(queryRows.map((row: any) => [Number(row.bucket), row]));
    const p95Map = new Map<number, any>(p95Rows.map((row: any) => [Number(row.bucket), row]));
    const trafficMap = new Map<number, any>(trafficRows.map((row: any) => [Number(row.bucket), row]));

    return {
      labels,
      queries: bucketSeries(labels, queryRows, (row) => numberValue(row.queries), 0),
      errors: bucketSeries(labels, queryRows, (row) => numberValue(row.errors), 0),
      readQueries: bucketSeries(labels, queryRows, (row) => numberValue(row.readQueries), 0),
      writeQueries: bucketSeries(labels, queryRows, (row) => numberValue(row.writeQueries), 0),
      rowsRead: bucketSeries(labels, queryRows, (row) => numberValue(row.rowsRead), 0),
      rowsWritten: bucketSeries(labels, queryRows, (row) => numberValue(row.rowsWritten), 0),
      latencyAvg: labels.map((_, index) => {
        const row = queryMap.get(index);
        return row ? Math.round(numberValue(row.avgDuration)) : null;
      }),
      latencyP95: labels.map((_, index) => {
        const row = p95Map.get(index);
        return row ? Math.round(numberValue(row.p95)) : null;
      }),
      latencyMax: bucketSeries(labels, queryRows, (row) => numberValue(row.maxDuration), null),
      trafficIn: bucketSeries(labels, trafficRows, (row) => numberValue(row.inbound), 0),
      trafficOut: bucketSeries(labels, trafficRows, (row) => numberValue(row.outbound), 0),
      requests: labels.map((_, index) => {
        const row = trafficMap.get(index);
        return row ? numberValue(row.requests) : 0;
      }),
      storage: buildStorageSeries(labels, plan.fromMs, plan.stepMs, baselineStorage, windowStorage),
    };
  }

  private async getSources(window: AnalyticsWindow, databaseId?: string) {
    const rows = await AppDataSource.query(
      `SELECT q.source,
              COUNT(*) AS queries,
              COALESCE(SUM(CASE WHEN q.success = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(AVG(q.durationMs), 0) AS avgDuration
       FROM query_metrics q
       JOIN databases d ON d.id = q.databaseId
       WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseId ? ' AND q.databaseId = ?' : ''}
       GROUP BY q.source
       ORDER BY queries DESC`,
      [sqlDate(window.from), sqlDate(window.to), ...(databaseId ? [databaseId] : [])],
    );

    return rows.map((row: any) => ({
      source: String(row.source || 'unknown'),
      queries: numberValue(row.queries),
      errors: numberValue(row.errors),
      avgDurationMs: Math.round(numberValue(row.avgDuration)),
    }));
  }

  private async getStatusCodes(window: AnalyticsWindow, databaseId?: string) {
    const rows = await AppDataSource.query(
      `SELECT t.statusCode,
              COUNT(*) AS requests,
              COALESCE(SUM(t.responseBytes), 0) AS responseBytes
       FROM traffic_metrics t
       LEFT JOIN databases d ON d.id = t.databaseId
       WHERE t.createdAt >= ? AND t.createdAt <= ?
         AND t.statusCode > 0
         ${databaseId
           ? 'AND t.databaseId = ?'
           : "AND (t.databaseId IS NULL OR t.databaseId = '' OR d.id IS NOT NULL)"}
       GROUP BY t.statusCode
       ORDER BY requests DESC
       LIMIT 10`,
      [sqlDate(window.from), sqlDate(window.to), ...(databaseId ? [databaseId] : [])],
    );

    return rows.map((row: any) => ({
      statusCode: numberValue(row.statusCode),
      requests: numberValue(row.requests),
      responseBytes: numberValue(row.responseBytes),
    }));
  }

  private async getOperations(window: AnalyticsWindow, databaseId?: string) {
    const rows = await AppDataSource.query(
      `SELECT q.operation,
              COUNT(*) AS queries,
              COALESCE(SUM(q.rowsRead), 0) AS rowsRead,
              COALESCE(SUM(q.rowsWritten), 0) AS rowsWritten,
              COALESCE(SUM(CASE WHEN q.success = 0 THEN 1 ELSE 0 END), 0) AS errors
       FROM query_metrics q
       JOIN databases d ON d.id = q.databaseId
       WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseId ? ' AND q.databaseId = ?' : ''}
       GROUP BY q.operation
       ORDER BY queries DESC`,
      [sqlDate(window.from), sqlDate(window.to), ...(databaseId ? [databaseId] : [])],
    );

    return rows.map((row: any) => ({
      operation: String(row.operation || 'other'),
      queries: numberValue(row.queries),
      rowsRead: numberValue(row.rowsRead),
      rowsWritten: numberValue(row.rowsWritten),
      errors: numberValue(row.errors),
    }));
  }

  private async getTrafficPaths(window: AnalyticsWindow, databaseId?: string): Promise<TrafficPathUsage[]> {
    if (!databaseId) return [];

    const rows = await AppDataSource.query(
      `SELECT t.path,
              COUNT(*) AS requests,
              COALESCE(SUM(t.requestBytes + t.responseBytes), 0) AS bytes
       FROM traffic_metrics t
       JOIN databases d ON d.id = t.databaseId
       WHERE t.createdAt >= ? AND t.createdAt <= ? AND t.databaseId = ?
       GROUP BY t.path
       ORDER BY requests DESC
       LIMIT 10`,
      [sqlDate(window.from), sqlDate(window.to), databaseId],
    );

    return rows.map((row: any) => ({
      path: String(row.path || '/'),
      requests: numberValue(row.requests),
      bytes: numberValue(row.bytes),
    }));
  }

  /**
   * Full inventory of existing databases. Unlike a top-N query, it starts from
   * `databases` and LEFT JOINs metrics, so a real database with zero captured
   * traffic still appears with zeros. Deleted databases are naturally absent.
   */
  private async getDatabaseUsage(window: AnalyticsWindow): Promise<DatabaseUsageRow[]> {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);
    const rows = await AppDataSource.query(
      `SELECT d.id AS databaseId,
              d.name AS databaseName,
              d.subdomain,
              d.type,
              d.status,
              d.metadata,
              d.projectId,
              p.name AS projectName,
              COUNT(q.id) AS queries,
              COALESCE(SUM(CASE WHEN ${READ_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS readQueries,
              COALESCE(SUM(CASE WHEN ${WRITE_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS writeQueries,
              COALESCE(SUM(q.rowsRead), 0) AS rowsRead,
              COALESCE(SUM(q.rowsWritten), 0) AS rowsWritten,
              COALESCE(SUM(CASE WHEN q.success = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(AVG(q.durationMs), 0) AS avgDuration,
              COALESCE(MAX(q.durationMs), 0) AS maxDuration,
              MAX(q.createdAt) AS lastSeenAt
       FROM databases d
       LEFT JOIN query_metrics q
         ON q.databaseId = d.id
        AND q.createdAt >= ? AND q.createdAt <= ?
       LEFT JOIN projects p ON p.id = d.projectId
       GROUP BY d.id
       ORDER BY (COALESCE(SUM(q.rowsRead), 0) + COALESCE(SUM(q.rowsWritten), 0)) DESC,
                COUNT(q.id) DESC,
                d.name ASC`,
      [from, to],
    );

    const ids: string[] = (rows as any[])
      .map((row: any) => String(row.databaseId || ''))
      .filter((id: string) => Boolean(id));
    if (ids.length === 0) return [];

    const activeIds = (rows as any[])
      .filter((row: any) => numberValue(row.queries) > 0)
      .map((row: any) => String(row.databaseId));
    const placeholders = ids.map(() => '?').join(',');
    const activePlaceholders = activeIds.map(() => '?').join(',');

    const [p95Rows, storage, lastSourceRows, httpRows] = await Promise.all([
      activeIds.length > 0
        ? AppDataSource.query(
          `WITH ranked AS (
             SELECT q.databaseId,
                    q.durationMs,
                    ROW_NUMBER() OVER (PARTITION BY q.databaseId ORDER BY q.durationMs ASC) AS rn,
                    COUNT(*) OVER (PARTITION BY q.databaseId) AS cnt
             FROM query_metrics q
             WHERE q.createdAt >= ? AND q.createdAt <= ?
               AND q.databaseId IN (${activePlaceholders})
           )
           SELECT databaseId, durationMs AS p95
           FROM ranked
           WHERE rn = CAST((cnt * 95 + 99) / 100 AS INTEGER)`,
          [from, to, ...activeIds],
        )
        : Promise.resolve([]),
      AppDataSource.query(
        `SELECT s.databaseId, s.sizeBytes
         FROM storage_samples s
         WHERE s.sampledAt = (
           SELECT MAX(s2.sampledAt) FROM storage_samples s2 WHERE s2.databaseId = s.databaseId
         )
         AND s.databaseId IN (${placeholders})`,
        ids,
      ),
      activeIds.length > 0
        ? AppDataSource.query(
          `WITH ranked AS (
             SELECT q.databaseId,
                    q.source,
                    ROW_NUMBER() OVER (PARTITION BY q.databaseId ORDER BY q.createdAt DESC) AS rn
             FROM query_metrics q
             WHERE q.createdAt >= ? AND q.createdAt <= ?
               AND q.databaseId IN (${activePlaceholders})
           )
           SELECT databaseId, source
           FROM ranked
           WHERE rn = 1`,
          [from, to, ...activeIds],
        )
        : Promise.resolve([]),
      AppDataSource.query(
        `SELECT t.databaseId,
                COUNT(*) AS requests,
                MAX(t.createdAt) AS lastRequestAt,
                (SELECT t2.path
                 FROM traffic_metrics t2
                 WHERE t2.databaseId = t.databaseId
                   AND t2.createdAt >= ? AND t2.createdAt <= ?
                 ORDER BY t2.createdAt DESC
                 LIMIT 1) AS lastRequestPath
         FROM traffic_metrics t
         WHERE t.createdAt >= ? AND t.createdAt <= ?
           AND t.databaseId IN (${placeholders})
         GROUP BY t.databaseId`,
        [from, to, from, to, ...ids],
      ),
    ]);

    const p95Map = new Map<string, number>(
      p95Rows.map((row: any) => [String(row.databaseId), numberValue(row.p95)]),
    );
    const storageMap = new Map<string, number>(
      storage.map((row: any) => [String(row.databaseId), numberValue(row.sizeBytes)]),
    );
    const lastSourceMap = new Map<string, string>(
      lastSourceRows.map((row: any) => [String(row.databaseId), String(row.source || '')]),
    );
    const httpMap = new Map<string, any>(
      httpRows.map((row: any) => [String(row.databaseId), row]),
    );

    return rows.map((row: any) => {
      const id = String(row.databaseId);
      const storedName = String(row.databaseName || '').trim();
      const subdomain = String(row.subdomain || '').trim();
      const storedNameIsUuid = isUuidLike(storedName);
      const displayName = storedName && !storedNameIsUuid
        ? storedName
        : (subdomain || 'Unnamed database');
      const queries = numberValue(row.queries);
      const errors = numberValue(row.errors);
      const readQueries = numberValue(row.readQueries);
      const writeQueries = numberValue(row.writeQueries);
      const metadata = parseMetadata(row.metadata);
      const runtimeProvider = metadata
        ? getRuntimeProvider({ metadata })
        : '';

      return {
        id,
        name: displayName,
        displayName,
        needsRename: !storedName || storedNameIsUuid,
        subdomain: subdomain || null,
        projectId: row.projectId ? String(row.projectId) : null,
        projectName: row.projectName ? String(row.projectName) : null,
        type: String(row.type || ''),
        status: String(row.status || ''),
        runtimeProvider,
        rowsRead: numberValue(row.rowsRead),
        rowsWritten: numberValue(row.rowsWritten),
        queries,
        readQueries,
        writeQueries,
        otherQueries: Math.max(0, queries - readQueries - writeQueries),
        errors,
        errorRate: queries > 0 ? errors / queries : 0,
        avgDurationMs: Math.round(numberValue(row.avgDuration)),
        p95DurationMs: Math.round(p95Map.get(id) || 0),
        maxDurationMs: numberValue(row.maxDuration),
        lastSeenAt: timestampToIso(row.lastSeenAt),
        lastSource: lastSourceMap.get(id) || null,
        hasActivity: queries > 0,
        httpRequests: numberValue(httpMap.get(id)?.requests),
        lastRequestAt: timestampToIso(httpMap.get(id)?.lastRequestAt),
        lastRequestPath: httpMap.get(id)?.lastRequestPath
          ? String(httpMap.get(id).lastRequestPath)
          : null,
        hasHttpActivity: numberValue(httpMap.get(id)?.requests) > 0,
        storageBytes: storageMap.get(id) || 0,
      };
    });
  }

  private async getSelectedDatabase(databaseId?: string) {
    if (!databaseId) return null;

    const database = await this.databaseRepo.findOne({
      where: { id: databaseId },
      relations: ['project'],
    });
    if (!database) throw new Error('database not found');

    const storedName = database.name?.trim() || '';
    const subdomain = database.subdomain?.trim() || '';
    const storedNameIsUuid = isUuidLike(storedName);
    const displayName = storedName && !storedNameIsUuid
      ? storedName
      : (subdomain || 'Unnamed database');
    const runtimeProvider = getRuntimeProvider(database)
      || (resolveEffectiveDatabaseType(database) === 'sqlite' ? 'local-file' : '');

    return {
      id: database.id,
      name: displayName,
      displayName,
      needsRename: !storedName || storedNameIsUuid,
      projectId: database.project?.id || null,
      projectName: database.project?.name || null,
      status: database.status,
      type: database.type,
      runtimeProvider,
    };
  }

  private async getTopProjects(window: AnalyticsWindow, databaseId?: string) {
    const rows = await AppDataSource.query(
      `SELECT d.projectId AS projectId,
              p.name AS projectName,
              COALESCE(SUM(q.rowsRead), 0) AS rowsRead,
              COALESCE(SUM(q.rowsWritten), 0) AS rowsWritten,
              COUNT(*) AS queries,
              COALESCE(SUM(CASE WHEN ${READ_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS readQueries,
              COALESCE(SUM(CASE WHEN ${WRITE_OPERATION_SQL} THEN 1 ELSE 0 END), 0) AS writeQueries,
              COALESCE(SUM(CASE WHEN q.success = 0 THEN 1 ELSE 0 END), 0) AS errors
       FROM query_metrics q
       JOIN databases d ON d.id = q.databaseId
       JOIN projects p ON p.id = d.projectId
       WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseId ? ' AND q.databaseId = ?' : ''}
       GROUP BY d.projectId
       ORDER BY (SUM(q.rowsRead) + SUM(q.rowsWritten)) DESC
       LIMIT 10`,
      [sqlDate(window.from), sqlDate(window.to), ...(databaseId ? [databaseId] : [])],
    );

    return rows.map((row: any) => {
      const queries = numberValue(row.queries);
      const errors = numberValue(row.errors);
      return {
        id: String(row.projectId),
        name: String(row.projectName || row.projectId),
        rowsRead: numberValue(row.rowsRead),
        rowsWritten: numberValue(row.rowsWritten),
        queries,
        readQueries: numberValue(row.readQueries),
        writeQueries: numberValue(row.writeQueries),
        errors,
        errorRate: queries > 0 ? errors / queries : 0,
      };
    });
  }

  private async getTopQueries(window: AnalyticsWindow, rank: QueryRank = 'duration', databaseId?: string) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);
    const orderBy = rank === 'rowsRead'
      ? 'rowsRead DESC'
      : rank === 'rowsWritten'
        ? 'rowsWritten DESC'
        : rank === 'queries'
          ? 'queries DESC'
          : 'avgDuration DESC';

    const rows = await AppDataSource.query(
      `SELECT q.sqlFingerprint,
              MAX(q.sqlPreview) AS sqlPreview,
              MAX(q.operation) AS operation,
              COUNT(*) AS queries,
              COALESCE(SUM(q.rowsRead), 0) AS rowsRead,
              COALESCE(SUM(q.rowsWritten), 0) AS rowsWritten,
              COALESCE(AVG(q.durationMs), 0) AS avgDuration,
              COALESCE(MAX(q.durationMs), 0) AS maxDuration
       FROM query_metrics q
       JOIN databases d ON d.id = q.databaseId
       WHERE q.createdAt >= ? AND q.createdAt <= ?${databaseId ? ' AND q.databaseId = ?' : ''}
         AND q.success = 1
       GROUP BY q.sqlFingerprint
       ORDER BY ${orderBy}
       LIMIT 10`,
      [from, to, ...(databaseId ? [databaseId] : [])],
    );

    return rows.map((row: any) => ({
      fingerprint: row.sqlFingerprint,
      sqlPreview: row.sqlPreview,
      operation: String(row.operation || 'other'),
      queries: numberValue(row.queries),
      rowsRead: numberValue(row.rowsRead),
      rowsWritten: numberValue(row.rowsWritten),
      avgDurationMs: Math.round(numberValue(row.avgDuration)),
      maxDurationMs: numberValue(row.maxDuration),
    }));
  }

  private async getTopErrors(window: AnalyticsWindow, databaseId?: string) {
    const rows = await AppDataSource.query(
      `SELECT COALESCE(q.errorCode, 'UNKNOWN') AS errorCode,
              COUNT(*) AS queries,
              MAX(q.sqlPreview) AS sqlPreview,
              MAX(q.createdAt) AS lastSeenAt
       FROM query_metrics q
       JOIN databases d ON d.id = q.databaseId
       WHERE q.success = 0 AND q.createdAt >= ? AND q.createdAt <= ?${databaseId ? ' AND q.databaseId = ?' : ''}
       GROUP BY COALESCE(q.errorCode, 'UNKNOWN')
       ORDER BY queries DESC
       LIMIT 5`,
      [sqlDate(window.from), sqlDate(window.to), ...(databaseId ? [databaseId] : [])],
    );

    return rows.map((row: any) => ({
      errorCode: String(row.errorCode || 'UNKNOWN'),
      queries: numberValue(row.queries),
      lastSeenAt: timestampToIso(row.lastSeenAt),
      sqlPreview: String(row.sqlPreview || ''),
    }));
  }
}
