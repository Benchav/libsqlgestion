import { AppDataSource } from '../../infrastructure/db/data-source';
import { Database } from '../../domain/entities/Database';

export type AnalyticsRange = 'today' | '7d' | '30d' | 'month';
export type AnalyticsBucket = 'hour' | 'day';

type AnalyticsWindow = {
  from: Date;
  to: Date;
  bucket: AnalyticsBucket;
};

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
    from = new Date(now.getTime() - 7 * 86_400_000);
  } else if (range === 'month') {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else {
    from = new Date(now.getTime() - 30 * 86_400_000);
  }

  const maxMs = 90 * 86_400_000;
  if (to.getTime() - from.getTime() > maxMs) {
    from = new Date(to.getTime() - maxMs);
  }
  if (from.getTime() > to.getTime()) {
    from = startOfUtcDay(to);
  }

  return {
    from,
    to,
    bucket: to.getTime() - from.getTime() <= 3 * 86_400_000 ? 'hour' : 'day',
  };
}

function bucketExpression(bucket: AnalyticsBucket) {
  return bucket === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%dT00:00:00Z';
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class AnalyticsService {
  private databaseRepo = AppDataSource.getRepository(Database);

  async getOverview(input: { range?: AnalyticsRange; from?: string; to?: string } = {}) {
    const window = resolveWindow(input.range, input.from, input.to);
    const [summary, series, topDatabases, topQueries] = await Promise.all([
      this.getSummary(window),
      this.getSeries(window),
      this.getTopDatabases(window),
      this.getTopQueries(window),
    ]);

    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      bucket: window.bucket,
      summary,
      series,
      topDatabases,
      topQueries,
    };
  }

  private async getSummary(window: AnalyticsWindow) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);

    const queryRows = await AppDataSource.query(
      `SELECT COUNT(*) AS queries,
              COALESCE(SUM(rowsRead), 0) AS rowsRead,
              COALESCE(SUM(rowsWritten), 0) AS rowsWritten,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(AVG(durationMs), 0) AS avgDuration,
              COALESCE(MAX(durationMs), 0) AS maxDuration
       FROM query_metrics
       WHERE createdAt >= ? AND createdAt <= ?`,
      [from, to],
    );

    const row = queryRows[0] || {};
    const queries = numberValue(row.queries);
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

    const trafficRows = await AppDataSource.query(
      `SELECT COALESCE(SUM(requestBytes), 0) AS inbound,
              COALESCE(SUM(responseBytes), 0) AS outbound
       FROM traffic_metrics
       WHERE createdAt >= ? AND createdAt <= ?`,
      [from, to],
    );

    const storageRows = await AppDataSource.query(
      `SELECT COALESCE(SUM(sizeBytes), 0) AS storage
       FROM storage_samples s
       WHERE s.sampledAt = (
         SELECT MAX(s2.sampledAt) FROM storage_samples s2 WHERE s2.databaseId = s.databaseId
       )`,
    );

    return {
      rowsRead: numberValue(row.rowsRead),
      rowsWritten: numberValue(row.rowsWritten),
      queries,
      errors: numberValue(row.errors),
      avgDurationMs: Math.round(numberValue(row.avgDuration)),
      p95DurationMs,
      maxDurationMs: numberValue(row.maxDuration),
      storageBytes: numberValue(storageRows[0]?.storage),
      trafficInBytes: numberValue(trafficRows[0]?.inbound),
      trafficOutBytes: numberValue(trafficRows[0]?.outbound),
      syncs: null,
    };
  }

  private async getSeries(window: AnalyticsWindow) {
    const from = sqlDate(window.from);
    const to = sqlDate(window.to);
    const bucketFormat = bucketExpression(window.bucket);

    const [queryRows, trafficRows, storageRows] = await Promise.all([
      AppDataSource.query(
        `SELECT strftime(?, createdAt) AS bucket,
                COUNT(*) AS queries,
                COALESCE(SUM(rowsRead), 0) AS rowsRead,
                COALESCE(SUM(rowsWritten), 0) AS rowsWritten,
                COALESCE(AVG(durationMs), 0) AS avgDuration,
                COALESCE(MAX(durationMs), 0) AS maxDuration
         FROM query_metrics
         WHERE createdAt >= ? AND createdAt <= ?
         GROUP BY bucket ORDER BY bucket ASC`,
        [bucketFormat, from, to],
      ),
      AppDataSource.query(
        `SELECT strftime(?, createdAt) AS bucket,
                COALESCE(SUM(requestBytes), 0) AS inbound,
                COALESCE(SUM(responseBytes), 0) AS outbound
         FROM traffic_metrics
         WHERE createdAt >= ? AND createdAt <= ?
         GROUP BY bucket ORDER BY bucket ASC`,
        [bucketFormat, from, to],
      ),
      AppDataSource.query(
        `SELECT bucket, COALESCE(SUM(sizeBytes), 0) AS storage
         FROM (
           SELECT strftime(?, sampledAt) AS bucket,
                  sizeBytes,
                  ROW_NUMBER() OVER (
                    PARTITION BY databaseId, strftime(?, sampledAt)
                    ORDER BY sampledAt DESC
                  ) AS rn
           FROM storage_samples
           WHERE sampledAt >= ? AND sampledAt <= ?
         )
         WHERE rn = 1
         GROUP BY bucket ORDER BY bucket ASC`,
        [bucketFormat, bucketFormat, from, to],
      ),
    ]);

    const labels = Array.from(new Set([
      ...queryRows.map((row: any) => row.bucket),
      ...trafficRows.map((row: any) => row.bucket),
      ...storageRows.map((row: any) => row.bucket),
    ])).filter(Boolean).sort() as string[];

    const queryMap = new Map(queryRows.map((row: any) => [row.bucket, row]));
    const trafficMap = new Map(trafficRows.map((row: any) => [row.bucket, row]));
    const storageMap = new Map(storageRows.map((row: any) => [row.bucket, row]));

    return {
      labels,
      queries: labels.map((label) => numberValue((queryMap.get(label) as any)?.queries)),
      rowsRead: labels.map((label) => numberValue((queryMap.get(label) as any)?.rowsRead)),
      rowsWritten: labels.map((label) => numberValue((queryMap.get(label) as any)?.rowsWritten)),
      latencyAvg: labels.map((label) => Math.round(numberValue((queryMap.get(label) as any)?.avgDuration))),
      latencyMax: labels.map((label) => numberValue((queryMap.get(label) as any)?.maxDuration)),
      trafficIn: labels.map((label) => numberValue((trafficMap.get(label) as any)?.inbound)),
      trafficOut: labels.map((label) => numberValue((trafficMap.get(label) as any)?.outbound)),
      storage: labels.map((label) => numberValue((storageMap.get(label) as any)?.storage)),
    };
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
      ? await this.databaseRepo.findByIds(ids)
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

  private async getTopQueries(window: AnalyticsWindow, rank: 'duration' | 'rowsRead' | 'rowsWritten' | 'queries' = 'duration') {
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
}
