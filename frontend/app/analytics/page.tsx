'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  Database,
  Gauge,
  HardDrive,
  Network,
  RefreshCw,
  Rows3,
  Timer,
} from 'lucide-react';
import { AppShell } from '../../components/AppShell';
import { TimeSeriesChart } from '../../components/analytics/TimeSeriesChart';
import { apiRequest } from '../../lib/api';

type AnalyticsRange = 'today' | '7d' | '30d' | 'month';
type QueryRank = 'latency' | 'rowsRead' | 'rowsWritten' | 'queries';

type TopQuery = {
  fingerprint: string;
  sqlPreview: string;
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  avgDurationMs: number;
  maxDurationMs: number;
};

type AnalyticsOverview = {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  summary: {
    rowsRead: number;
    rowsWritten: number;
    queries: number;
    errors: number;
    errorRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
    maxDurationMs: number;
    storageBytes: number;
    trafficInBytes: number;
    trafficOutBytes: number;
    requests: number;
    syncs: null;
  };
  series: {
    labels: string[];
    queries: number[];
    errors: number[];
    rowsRead: number[];
    rowsWritten: number[];
    latencyAvg: Array<number | null>;
    latencyP95: Array<number | null>;
    latencyMax: Array<number | null>;
    trafficIn: number[];
    trafficOut: number[];
    requests: number[];
    storage: number[];
  };
  sources: Array<{
    source: string;
    queries: number;
    errors: number;
    avgDurationMs: number;
  }>;
  statusCodes: Array<{
    statusCode: number;
    requests: number;
    responseBytes: number;
  }>;
  topDatabases: Array<{
    id: string;
    name: string;
    displayName?: string;
    exists?: boolean;
    deleted?: boolean;
    needsRename?: boolean;
    subdomain?: string | null;
    rowsRead: number;
    rowsWritten: number;
    queries: number;
    storageBytes: number;
  }>;
  topProjects: Array<{
    id: string;
    name: string;
    rowsRead: number;
    rowsWritten: number;
    queries: number;
  }>;
  topQueries: TopQuery[];
  topQueriesByRowsRead: TopQuery[];
  topQueriesByRowsWritten: TopQuery[];
  topQueriesByFrequency: TopQuery[];
  topErrors: Array<{
    errorCode: string;
    queries: number;
    sqlPreview: string;
    lastSeenAt: string | null;
  }>;
};

const RANGES: Array<{ value: AnalyticsRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
];

const QUERY_RANKS: Array<{ value: QueryRank; label: string }> = [
  { value: 'latency', label: 'Slowest' },
  { value: 'rowsRead', label: 'Most rows read' },
  { value: 'rowsWritten', label: 'Most rows written' },
  { value: 'queries', label: 'Most frequent' },
];

const SOURCE_COLORS: Record<string, string> = {
  studio: '#38bdf8',
  api: '#34d399',
  pipeline: '#a78bfa',
  migration: '#f59e0b',
};

function getRangeWindow(range: AnalyticsRange) {
  const now = new Date();
  if (range === 'today') {
    return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: now };
  }
  if (range === '7d') {
    return { from: new Date(now.getTime() - 7 * 86_400_000), to: now };
  }
  if (range === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  }
  return { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(value: number) {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  const percent = value * 100;
  if (percent < 0.1) return '<0.1%';
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

function formatBucketLabel(label: string, bucket: 'hour' | 'day') {
  const date = new Date(label);
  if (!Number.isFinite(date.getTime())) return label;
  if (bucket === 'hour') {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatTooltipBucket(label: string, bucket: 'hour' | 'day') {
  const date = new Date(label);
  if (!Number.isFinite(date.getTime())) return label;
  if (bucket === 'hour') {
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSource(source: string) {
  if (source === 'api') return 'API';
  if (source === 'pipeline') return 'Pipeline';
  if (source === 'studio') return 'Studio';
  if (source === 'migration') return 'Migration';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function statusTone(statusCode: number) {
  if (statusCode >= 500) return 'border-red-500/20 bg-red-500/10 text-red-400';
  if (statusCode >= 400) return 'border-amber-500/20 bg-amber-500/10 text-amber-400';
  if (statusCode >= 300) return 'border-sky-500/20 bg-sky-500/10 text-sky-400';
  if (statusCode >= 200) return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400';
  return 'border-zinc-700 bg-zinc-800/60 text-zinc-400';
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const [queryRank, setQueryRank] = useState<QueryRank>('latency');
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  async function loadAnalytics(nextRange: AnalyticsRange = range) {
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    setLoading(true);
    setError('');

    const window = getRangeWindow(nextRange);
    const params = new URLSearchParams({
      range: nextRange,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    });

    try {
      const result = await apiRequest<AnalyticsOverview>(`/analytics?${params.toString()}`);
      if (requestId.current === currentRequest) setData(result);
    } catch (err: any) {
      if (requestId.current === currentRequest) {
        setError(err.message || 'Failed to load analytics');
      }
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }

  useEffect(() => {
    void loadAnalytics(range);
  }, [range]);

  const summary = data?.summary;
  const series = data?.series;
  const labels = series?.labels || [];
  const hasData = Boolean(summary && (
    summary.queries > 0
    || summary.trafficInBytes > 0
    || summary.trafficOutBytes > 0
    || summary.storageBytes > 0
  ));

  const topQueryLists: Record<QueryRank, TopQuery[]> = {
    latency: data?.topQueries || [],
    rowsRead: data?.topQueriesByRowsRead || [],
    rowsWritten: data?.topQueriesByRowsWritten || [],
    queries: data?.topQueriesByFrequency || [],
  };
  const visibleQueries = topQueryLists[queryRank];
  const totalSourceQueries = (data?.sources || []).reduce((total, source) => total + source.queries, 0);

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Analytics</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Usage, latency and database activity collected from the data plane.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-lg border border-zinc-800 bg-[#0f0f0f] p-1">
              {RANGES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setRange(item.value)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    range === item.value
                      ? 'bg-zinc-100 text-zinc-900'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => loadAnalytics(range)}
              disabled={loading}
              className="p-2 text-zinc-500 transition-colors hover:text-zinc-300 disabled:opacity-40"
              title="Refresh analytics"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-28 animate-pulse rounded-xl border border-zinc-800/80 bg-[#0f0f0f]" />
            ))}
          </div>
        ) : !data ? (
          <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-12 text-center">
            <Activity className="mx-auto text-zinc-600" size={28} />
            <h2 className="mt-3 text-sm font-medium text-zinc-200">Analytics unavailable</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
              Check the error above and refresh the page.
            </p>
          </div>
        ) : !hasData ? (
          <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-12 text-center">
            <Activity className="mx-auto text-zinc-600" size={28} />
            <h2 className="mt-3 text-sm font-medium text-zinc-200">No analytics yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
              Query metrics are collected from the moment this version was deployed. Connect a project to see
              progress.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                icon={<Database size={18} />}
                label="Queries"
                value={formatNumber(summary!.queries)}
                detail={`${formatNumber(summary!.requests)} database API requests`}
              />
              <SummaryCard
                icon={<AlertTriangle size={18} />}
                label="Errors"
                value={formatNumber(summary!.errors)}
                detail={`${formatPercent(summary!.errorRate)} error rate`}
                tone={summary!.errors > 0 ? 'text-red-400' : undefined}
              />
              <SummaryCard icon={<Rows3 size={18} />} label="Rows read" value={formatNumber(summary!.rowsRead)} />
              <SummaryCard icon={<ArrowDownUp size={18} />} label="Rows written" value={formatNumber(summary!.rowsWritten)} />
              <SummaryCard icon={<Timer size={18} />} label="Average latency" value={formatDuration(summary!.avgDurationMs)} />
              <SummaryCard icon={<Gauge size={18} />} label="Latency p95" value={formatDuration(summary!.p95DurationMs)} />
              <SummaryCard icon={<HardDrive size={18} />} label="Storage" value={formatBytes(summary!.storageBytes)} />
              <SummaryCard
                icon={<Network size={18} />}
                label="Traffic"
                value={formatBytes(summary!.trafficInBytes + summary!.trafficOutBytes)}
                detail={`↓ ${formatBytes(summary!.trafficInBytes)} in · ↑ ${formatBytes(summary!.trafficOutBytes)} out`}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <ChartCard
                title="Query volume"
                subtitle="Executed queries per bucket, with failed queries highlighted."
                className="xl:col-span-2"
              >
                <TimeSeriesChart
                  labels={labels}
                  series={[
                    { name: 'Queries', color: '#38bdf8', values: series!.queries, fill: true },
                    { name: 'Errors', color: '#f87171', values: series!.errors },
                  ]}
                  formatValue={formatNumber}
                  formatLabel={(label) => formatBucketLabel(label, data.bucket)}
                  formatTooltipLabel={(label) => formatTooltipBucket(label, data.bucket)}
                  emptyMessage="No queries in this period."
                />
              </ChartCard>

              <ChartCard title="Latency" subtitle="Average and p95 query duration.">
                <TimeSeriesChart
                  labels={labels}
                  series={[
                    { name: 'Average', color: '#38bdf8', values: series!.latencyAvg, fill: true },
                    { name: 'P95', color: '#f472b6', values: series!.latencyP95, dashed: true },
                  ]}
                  formatValue={formatDuration}
                  formatLabel={(label) => formatBucketLabel(label, data.bucket)}
                  formatTooltipLabel={(label) => formatTooltipBucket(label, data.bucket)}
                  emptyMessage="No query latency in this period."
                />
              </ChartCard>

              <ChartCard title="Rows" subtitle="Rows returned by reads and affected by writes.">
                <TimeSeriesChart
                  labels={labels}
                  series={[
                    { name: 'Rows read', color: '#34d399', values: series!.rowsRead, fill: true },
                    { name: 'Rows written', color: '#a78bfa', values: series!.rowsWritten },
                  ]}
                  formatValue={formatNumber}
                  formatLabel={(label) => formatBucketLabel(label, data.bucket)}
                  formatTooltipLabel={(label) => formatTooltipBucket(label, data.bucket)}
                  emptyMessage="No rows processed in this period."
                />
              </ChartCard>

              <ChartCard title="Traffic" subtitle="Database API request and response bytes.">
                <TimeSeriesChart
                  labels={labels}
                  series={[
                    { name: 'Inbound', color: '#f59e0b', values: series!.trafficIn, fill: true },
                    { name: 'Outbound', color: '#60a5fa', values: series!.trafficOut },
                  ]}
                  formatValue={formatBytes}
                  formatLabel={(label) => formatBucketLabel(label, data.bucket)}
                  formatTooltipLabel={(label) => formatTooltipBucket(label, data.bucket)}
                  emptyMessage="No database traffic in this period."
                />
              </ChartCard>

              <ChartCard title="Storage" subtitle="Managed database size, including SQLite sidecar files.">
                <TimeSeriesChart
                  labels={labels}
                  series={[
                    { name: 'Storage', color: '#c084fc', values: series!.storage, fill: true },
                  ]}
                  formatValue={formatBytes}
                  formatLabel={(label) => formatBucketLabel(label, data.bucket)}
                  formatTooltipLabel={(label) => formatTooltipBucket(label, data.bucket)}
                  emptyMessage="No storage samples yet."
                />
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <Panel title="Query sources" subtitle="Where query traffic comes from.">
                {data.sources.length === 0 ? (
                  <EmptyPanelText>No queries in this period.</EmptyPanelText>
                ) : (
                  <div className="space-y-4">
                    {data.sources.map((source) => {
                      const share = totalSourceQueries > 0 ? source.queries / totalSourceQueries : 0;
                      return (
                        <div key={source.source}>
                          <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="text-zinc-300">{formatSource(source.source)}</span>
                            <span className="text-zinc-400">
                              {formatNumber(source.queries)} · {Math.round(share * 100)}%
                            </span>
                          </div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.max(2, share * 100)}%`,
                                backgroundColor: SOURCE_COLORS[source.source] || '#71717a',
                              }}
                            />
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-500">
                            {formatDuration(source.avgDurationMs)} average
                            {source.errors > 0 ? ` · ${formatNumber(source.errors)} failed` : ''}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>

              <Panel title="HTTP status codes" subtitle={`${formatNumber(summary!.requests)} requests in this period.`}>
                {data.statusCodes.length === 0 ? (
                  <EmptyPanelText>No HTTP requests recorded.</EmptyPanelText>
                ) : (
                  <div className="space-y-2">
                    {data.statusCodes.map((status) => (
                      <div
                        key={status.statusCode}
                        className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 px-3 py-2"
                      >
                        <span className={`rounded border px-2 py-0.5 font-mono text-[11px] ${statusTone(status.statusCode)}`}>
                          {status.statusCode}
                        </span>
                        <span className="text-sm text-zinc-300">{formatNumber(status.requests)}</span>
                        <span className="text-xs text-zinc-500">{formatBytes(status.responseBytes)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Top errors" subtitle="Failed queries grouped by error code.">
                {data.topErrors.length === 0 ? (
                  <EmptyPanelText>No failed queries in this period.</EmptyPanelText>
                ) : (
                  <div className="max-h-[260px] space-y-4 overflow-auto pr-1 custom-scrollbar">
                    {data.topErrors.map((item) => (
                      <div key={item.errorCode} className="border-b border-zinc-800/50 pb-3 last:border-0 last:pb-0">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-xs text-red-400">{item.errorCode}</span>
                          <span className="text-xs text-zinc-400">{formatNumber(item.queries)}</span>
                        </div>
                        <pre className="mt-1 max-h-12 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-500">
                          {item.sqlPreview || 'No SQL preview available.'}
                        </pre>
                        {item.lastSeenAt && (
                          <p className="mt-1 text-[11px] text-zinc-600">Last seen {formatDateTime(item.lastSeenAt)}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <DataTable
                title="Top databases"
                subtitle="Ranked by rows read in the selected period."
                columns={['Database', 'Rows read', 'Rows written', 'Queries', 'Storage']}
                empty={data.topDatabases.length === 0}
                emptyMessage="No database activity yet."
              >
                {data.topDatabases.map((database) => {
                  const label = database.displayName || database.name || 'Deleted database';
                  const isDeleted = database.deleted === true || database.exists === false;
                  const shortId = database.id.slice(0, 8);

                  return (
                    <tr key={database.id} className="border-b border-zinc-800/40 text-sm last:border-0">
                      <td className="px-6 py-3 font-medium text-zinc-200" title={database.id}>
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            {isDeleted ? (
                              <span className="text-zinc-400">{label}</span>
                            ) : (
                              <Link
                                href={`/databases/${database.id}`}
                                className="transition-colors hover:text-white"
                              >
                                {label}
                              </Link>
                            )}
                            {isDeleted && (
                              <span className="rounded-full border border-zinc-700 px-1.5 py-0.5 text-[10px] font-normal text-zinc-500">
                                Deleted
                              </span>
                            )}
                          </div>
                          {isDeleted && (
                            <span className="font-mono text-[10px] font-normal text-zinc-600">{shortId}</span>
                          )}
                          {database.needsRename && !isDeleted && (
                            <Link
                              href={`/databases/${database.id}`}
                              className="text-[11px] font-normal text-amber-400 transition-colors hover:text-amber-300"
                            >
                              Rename
                            </Link>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(database.rowsRead)}</td>
                      <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(database.rowsWritten)}</td>
                      <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(database.queries)}</td>
                      <td className="px-6 py-3 text-right text-zinc-400">{formatBytes(database.storageBytes)}</td>
                    </tr>
                  );
                })}
              </DataTable>

              <DataTable
                title="Top projects"
                subtitle="Ranked by rows read in the selected period."
                columns={['Project', 'Rows read', 'Rows written', 'Queries']}
                empty={data.topProjects.length === 0}
                emptyMessage="No project activity yet."
              >
                {data.topProjects.map((project) => (
                  <tr key={project.id} className="border-b border-zinc-800/40 text-sm last:border-0">
                    <td className="px-6 py-3 font-medium text-zinc-200">
                      <Link href={`/projects/${project.id}`} className="transition-colors hover:text-white">
                        {project.name}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(project.rowsRead)}</td>
                    <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(project.rowsWritten)}</td>
                    <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(project.queries)}</td>
                  </tr>
                ))}
              </DataTable>
            </div>

            <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-[#0f0f0f]">
              <div className="flex flex-col gap-3 border-b border-zinc-800/80 bg-zinc-900/30 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="font-medium text-zinc-200">Top queries</h2>
                  <p className="mt-1 text-xs text-zinc-500">Grouped by normalized SQL. Literals are redacted.</p>
                </div>
                <div className="flex flex-wrap gap-1 rounded-lg border border-zinc-800 bg-[#0b0b0b] p-1">
                  {QUERY_RANKS.map((rank) => (
                    <button
                      key={rank.value}
                      type="button"
                      onClick={() => setQueryRank(rank.value)}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        queryRank === rank.value
                          ? 'bg-zinc-100 text-zinc-900'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {rank.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-800/80 text-xs font-medium text-zinc-400">
                      <th className="px-6 py-3">Query</th>
                      <th className="px-4 py-3 text-right">Avg</th>
                      <th className="px-4 py-3 text-right">Max</th>
                      <th className="px-4 py-3 text-right">Read</th>
                      <th className="px-4 py-3 text-right">Written</th>
                      <th className="px-6 py-3 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleQueries.map((query) => (
                      <tr key={query.fingerprint} className="border-b border-zinc-800/40 align-top text-xs last:border-0">
                        <td className="max-w-[520px] px-6 py-3">
                          <pre
                            title={query.sqlPreview}
                            className="max-h-16 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-400"
                          >
                            {query.sqlPreview}
                          </pre>
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-300">{formatDuration(query.avgDurationMs)}</td>
                        <td className="px-4 py-3 text-right text-zinc-400">{formatDuration(query.maxDurationMs)}</td>
                        <td className="px-4 py-3 text-right text-zinc-400">{formatNumber(query.rowsRead)}</td>
                        <td className="px-4 py-3 text-right text-zinc-400">{formatNumber(query.rowsWritten)}</td>
                        <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(query.queries)}</td>
                      </tr>
                    ))}
                    {visibleQueries.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-6 py-8 text-center text-sm text-zinc-500">
                          No successful queries yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-zinc-500">
              Metrics are collected from this deployment onward. Ranges follow your browser timezone. Syncs are not
              applicable because LibSQLite is running without embedded replicas.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="text-zinc-500">{icon}</span>
      </div>
      <p className={`mt-3 text-2xl font-semibold ${tone || 'text-zinc-100'}`}>{value}</p>
      {detail && <p className="mt-1 truncate text-[11px] text-zinc-500">{detail}</p>}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  className = '',
  children,
}: {
  title: string;
  subtitle: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-5 ${className}`}>
      <div className="mb-4">
        <h2 className="font-medium text-zinc-200">{title}</h2>
        <p className="mt-1 text-xs text-zinc-500">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-5">
      <div className="mb-4">
        <h2 className="font-medium text-zinc-200">{title}</h2>
        <p className="mt-1 text-xs text-zinc-500">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function EmptyPanelText({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{children}</p>;
}

function DataTable({
  title,
  subtitle,
  columns,
  empty,
  emptyMessage,
  children,
}: {
  title: string;
  subtitle: string;
  columns: string[];
  empty: boolean;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-[#0f0f0f]">
      <div className="border-b border-zinc-800/80 bg-zinc-900/30 px-6 py-4">
        <h2 className="font-medium text-zinc-200">{title}</h2>
        <p className="mt-1 text-xs text-zinc-500">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-zinc-800/80 text-xs font-medium text-zinc-400">
              {columns.map((column, index) => (
                <th key={column} className={`px-6 py-3 ${index === 0 ? '' : 'text-right'}`}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {children}
            {empty && (
              <tr>
                <td colSpan={columns.length} className="px-6 py-8 text-center text-sm text-zinc-500">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
