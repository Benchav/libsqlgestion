import { In } from 'typeorm';
import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';
import { Project } from '../../domain/entities/Project';

export type AnalyticsRange = 'today' | '7d' | '30d' | 'month';
export type AnalyticsBucket = 'hour' | 'day';
type QueryRank = 'duration' | 'rowsRead' | 'rowsWritten' | 'queries';

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

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 90 * DAY_MS;

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

function bucketExpression(alias = 'createdAt') {
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
  private projectRepo = AppDataSource.getRepository(Project);

  async getOverview(input: { range?: AnalyticsRange; from?: string; to?: string } = {}) {
    const window = resolveWindow(input.range, input.from, input.to);
    const plan = buildBucketPlan(window);
    const [
      summary,
      series,
      sources,
      statusCodes,
      topDatabases,
      topProjects,
      topQueries,
      topQueriesByRowsRead,
      topQueriesByRowsWritten,
      topQueriesByFrequency,
      topErrors,
    ] = await Promise.all([
      this.getSummary(window),
      this.getSeries(window, plan),
      this.getSources(window),
      this.getStatusCodes(window),
      this.getTopDatabases(window),
      this.getTopProjects(window),
      this.getTopQueries(window, 'duration'),
      this.getTopQueries(window, 'rowsRead'),
      this.getTopQueries(window, 'rowsWritten'),
      this.getTopQueries(window, 'queries'),
      this.getTopErrors(window),
    ]);

    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      bucket: window.bucket,
      summary,
      series,
      sources,
      statusCodes,
      topDatabases,
      topProjects,
      topQueries,
      topQueriesByRowsRead,
      topQueriesByRowsWritten,
      topQueriesByFrequency,
      topErrors,
    };
  }

  private async getSummary(window: AnalyticsWindow) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);

    const [queryRows, trafficRows, storageRows] = await Promise.all([
      AppDataSource.query(
        `SELECT COUNT(*) AS queries,
                COALESCE(SUM(rowsRead), 0) AS rowsRead,
                COALESCE(SUM(rowsWritten), 0) AS rowsWritten,
                COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(AVG(durationMs), 0) AS avgDuration,
                COALESCE(MAX(durationMs), 0) AS maxDuration
         FROM query_metrics
         WHERE createdAt >= ? AND createdAt <= ?`,
        [from, to],
      ),
      AppDataSource.query(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(requestBytes), 0) AS inbound,
                COALESCE(SUM(responseBytes), 0) AS outbound
         FROM traffic_metrics
         WHERE createdAt >= ? AND createdAt <= ?`,
        [from, to],
      ),
      AppDataSource.query(
        `SELECT COALESCE(SUM(sizeBytes), 0) AS storage
         FROM storage_samples s
         WHERE s.sampledAt = (
           SELECT MAX(s2.sampledAt) FROM storage_samples s2 WHERE s2.databaseId = s.databaseId
         )`,
      ),
    ]);

    const row = queryRows[0] || {};
    const queries = numberValue(row.queries);
    const errors = numberValue(row.errors);
    let p95DurationMs = 0;

    if (queries > 0) {
      const offset = Math.min(queries - 1, Math.max(0, Math.floor(queries * 0.95)));
      const percentile = await AppDataSource.query(
        `SELECT durationMs FROM query_metrics
         WHERE createdAt >= ? AND createdAt <= ?
         ORDER BY durationMs ASC LIMIT 1 OFFSET ?`,
        [from, to, offset],
      );
      p95DurationMs = numberValue(percentile[0]?.durationMs);
    }

    const traffic = trafficRows[0] || {};

    return {
      rowsRead: numberValue(row.rowsRead),
      rowsWritten: numberValue(row.rowsWritten),
      queries,
      errors,
      errorRate: queries > 0 ? errors / queries : 0,
      avgDurationMs: Math.round(numberValue(row.avgDuration)),
      p95DurationMs,
      maxDurationMs: numberValue(row.maxDuration),
      storageBytes: numberValue(storageRows[0]?.storage),
      trafficInBytes: numberValue(traffic.inbound),
      trafficOutBytes: numberValue(traffic.outbound),
      requests: numberValue(traffic.requests),
      syncs: null,
    };
  }

  private async getSeries(window: AnalyticsWindow, plan: BucketPlan) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);
    const bucketSql = bucketExpression();
    const bucketParams = [plan.fromMs, plan.stepMs, from, to];

    const [queryRows, p95Rows, trafficRows, baselineStorage, windowStorage] = await Promise.all([
      AppDataSource.query(
        `SELECT ${bucketSql} AS bucket,
                COUNT(*) AS queries,
                COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(rowsRead), 0) AS rowsRead,
                COALESCE(SUM(rowsWritten), 0) AS rowsWritten,
                COALESCE(AVG(durationMs), 0) AS avgDuration,
                COALESCE(MAX(durationMs), 0) AS maxDuration
         FROM query_metrics
         WHERE createdAt >= ? AND createdAt <= ?
         GROUP BY bucket ORDER BY bucket ASC`,
        bucketParams,
      ),
      AppDataSource.query(
        `WITH filtered AS (
           SELECT ${bucketSql} AS bucket, durationMs
           FROM query_metrics
           WHERE createdAt >= ? AND createdAt <= ?
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
        `SELECT ${bucketSql} AS bucket,
                COUNT(*) AS requests,
                COALESCE(SUM(requestBytes), 0) AS inbound,
                COALESCE(SUM(responseBytes), 0) AS outbound
         FROM traffic_metrics
         WHERE createdAt >= ? AND createdAt <= ?
         GROUP BY bucket ORDER BY bucket ASC`,
        bucketParams,
      ),
      AppDataSource.query(
        `SELECT s.databaseId, s.sizeBytes
         FROM storage_samples s
         JOIN (
           SELECT databaseId, MAX(sampledAt) AS sampledAt
           FROM storage_samples
           WHERE sampledAt <= ?
           GROUP BY databaseId
         ) latest
           ON latest.databaseId = s.databaseId AND latest.sampledAt = s.sampledAt
         GROUP BY s.databaseId`,
        [from],
      ),
      AppDataSource.query(
        `SELECT databaseId, sampledAt, sizeBytes
         FROM storage_samples
         WHERE sampledAt > ? AND sampledAt <= ?
         ORDER BY sampledAt ASC`,
        [from, to],
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

  private async getSources(window: AnalyticsWindow) {
    const rows = await AppDataSource.query(
      `SELECT source,
              COUNT(*) AS queries,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(AVG(durationMs), 0) AS avgDuration
       FROM query_metrics
       WHERE createdAt >= ? AND createdAt <= ?
       GROUP BY source
       ORDER BY queries DESC`,
      [sqlDate(window.from), sqlDate(window.to)],
    );

    return rows.map((row: any) => ({
      source: String(row.source || 'unknown'),
      queries: numberValue(row.queries),
      errors: numberValue(row.errors),
      avgDurationMs: Math.round(numberValue(row.avgDuration)),
    }));
  }

  private async getStatusCodes(window: AnalyticsWindow) {
    const rows = await AppDataSource.query(
      `SELECT statusCode,
              COUNT(*) AS requests,
              COALESCE(SUM(responseBytes), 0) AS responseBytes
       FROM traffic_metrics
       WHERE createdAt >= ? AND createdAt <= ? AND statusCode > 0
       GROUP BY statusCode
       ORDER BY requests DESC
       LIMIT 10`,
      [sqlDate(window.from), sqlDate(window.to)],
    );

    return rows.map((row: any) => ({
      statusCode: numberValue(row.statusCode),
      requests: numberValue(row.requests),
      responseBytes: numberValue(row.responseBytes),
    }));
  }

  private async getTopDatabases(window: AnalyticsWindow) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);
    const rows = await AppDataSource.query(
      `SELECT databaseId,
              COALESCE(SUM(rowsRead), 0) AS rowsRead,
              COALESCE(SUM(rowsWritten), 0) AS rowsWritten,
              COUNT(*) AS queries
       FROM query_metrics
       WHERE createdAt >= ? AND createdAt <= ?
       GROUP BY databaseId
       ORDER BY rowsRead DESC
       LIMIT 10`,
      [from, to],
    );

    const ids = rows.map((row: any) => row.databaseId).filter(Boolean);
    const databases = ids.length > 0
      ? await this.databaseRepo.find({ where: { id: In(ids) } })
      : [];
    const nameMap = new Map(databases.map((database) => [database.id, database.name]));

    const storage = ids.length > 0
      ? await AppDataSource.query(
        `SELECT databaseId, sizeBytes
         FROM storage_samples s
         WHERE s.sampledAt = (
           SELECT MAX(s2.sampledAt) FROM storage_samples s2 WHERE s2.databaseId = s.databaseId
         )
         AND databaseId IN (${ids.map(() => '?').join(',')})`,
        ids,
      )
      : [];
    const storageMap = new Map(storage.map((row: any) => [row.databaseId, numberValue(row.sizeBytes)]));

    return rows.map((row: any) => ({
      id: row.databaseId,
      name: nameMap.get(row.databaseId) || row.databaseId,
      rowsRead: numberValue(row.rowsRead),
      rowsWritten: numberValue(row.rowsWritten),
      queries: numberValue(row.queries),
      storageBytes: storageMap.get(row.databaseId) || 0,
    }));
  }

  private async getTopProjects(window: AnalyticsWindow) {
    const rows = await AppDataSource.query(
      `SELECT projectId,
              COALESCE(SUM(rowsRead), 0) AS rowsRead,
              COALESCE(SUM(rowsWritten), 0) AS rowsWritten,
              COUNT(*) AS queries
       FROM query_metrics
       WHERE createdAt >= ? AND createdAt <= ? AND projectId IS NOT NULL
       GROUP BY projectId
       ORDER BY rowsRead DESC
       LIMIT 5`,
      [sqlDate(window.from), sqlDate(window.to)],
    );

    const ids = rows.map((row: any) => row.projectId).filter(Boolean);
    const projects = ids.length > 0
      ? await this.projectRepo.find({ where: { id: In(ids) } })
      : [];
    const nameMap = new Map(projects.map((project) => [project.id, project.name]));

    return rows.map((row: any) => ({
      id: row.projectId,
      name: nameMap.get(row.projectId) || row.projectId,
      rowsRead: numberValue(row.rowsRead),
      rowsWritten: numberValue(row.rowsWritten),
      queries: numberValue(row.queries),
    }));
  }

  private async getTopQueries(window: AnalyticsWindow, rank: QueryRank = 'duration') {
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
      `SELECT sqlFingerprint,
              MAX(sqlPreview) AS sqlPreview,
              COUNT(*) AS queries,
              COALESCE(SUM(rowsRead), 0) AS rowsRead,
              COALESCE(SUM(rowsWritten), 0) AS rowsWritten,
              COALESCE(AVG(durationMs), 0) AS avgDuration,
              COALESCE(MAX(durationMs), 0) AS maxDuration
       FROM query_metrics
       WHERE createdAt >= ? AND createdAt <= ? AND success = 1
       GROUP BY sqlFingerprint
       ORDER BY ${orderBy}
       LIMIT 10`,
      [from, to],
    );

    return rows.map((row: any) => ({
      fingerprint: row.sqlFingerprint,
      sqlPreview: row.sqlPreview,
      queries: numberValue(row.queries),
      rowsRead: numberValue(row.rowsRead),
      rowsWritten: numberValue(row.rowsWritten),
      avgDurationMs: Math.round(numberValue(row.avgDuration)),
      maxDurationMs: numberValue(row.maxDuration),
    }));
  }

  private async getTopErrors(window: AnalyticsWindow) {
    const rows = await AppDataSource.query(
      `SELECT COALESCE(errorCode, 'UNKNOWN') AS errorCode,
              COUNT(*) AS queries,
              MAX(sqlPreview) AS sqlPreview,
              MAX(createdAt) AS lastSeenAt
       FROM query_metrics
       WHERE success = 0 AND createdAt >= ? AND createdAt <= ?
       GROUP BY COALESCE(errorCode, 'UNKNOWN')
       ORDER BY queries DESC
       LIMIT 5`,
      [sqlDate(window.from), sqlDate(window.to)],
    );

    return rows.map((row: any) => ({
      errorCode: String(row.errorCode || 'UNKNOWN'),
      queries: numberValue(row.queries),
      sqlPreview: String(row.sqlPreview || ''),
      lastSeenAt: timestampToIso(row.lastSeenAt),
    }));
  }
}
