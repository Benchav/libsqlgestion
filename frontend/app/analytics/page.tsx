'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  BookOpen,
  Gauge,
  HardDrive,
  Network,
  PenLine,
  RefreshCw,
} from 'lucide-react';
import { AppShell } from '../../components/AppShell';
import { TimeSeriesChart } from '../../components/analytics/TimeSeriesChart';
import { apiRequest } from '../../lib/api';
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRatio,
  formatRelativeTime,
} from '../../lib/format';
import type { AnalyticsOverview, AnalyticsRange, TopQuery } from '../../lib/analytics-types';
import {
  OPERATION_COLORS,
  operationLabel,
  sourceLabel,
  summarizeTrafficPaths,
  TRAFFIC_KIND_COLORS,
  trafficKindLabel,
  trafficPathKind,
  trafficPathLabel,
} from '../../lib/analytics-ui';

type QueryRank = 'latency' | 'rowsRead' | 'rowsWritten' | 'queries';

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
  gateway: '#22d3ee',
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
  const [selectedDatabaseId, setSelectedDatabaseId] = useState('');
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  async function loadAnalytics(
    nextRange: AnalyticsRange = range,
    nextDatabaseId: string = selectedDatabaseId,
  ) {
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
    if (nextDatabaseId) params.set('databaseId', nextDatabaseId);

    try {
      const result = await apiRequest<AnalyticsOverview>(`/analytics?${params.toString()}`);
      if (requestId.current === currentRequest) setData(result);
    } catch (err: any) {
      if (requestId.current === currentRequest) {
        if (String(err?.message || '').includes('database not found')) {
          selectDatabase('');
        }
        setError(err.message || 'Failed to load analytics');
      }
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }

  function selectDatabase(databaseId: string) {
    setSelectedDatabaseId(databaseId);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (databaseId) url.searchParams.set('databaseId', databaseId);
    else url.searchParams.delete('databaseId');
    window.history.replaceState({}, '', url.toString());
  }

  useEffect(() => {
    void loadAnalytics(range, selectedDatabaseId);
  }, [range, selectedDatabaseId]);

  useEffect(() => {
    const databaseId = new URLSearchParams(window.location.search).get('databaseId') || '';
    if (databaseId) setSelectedDatabaseId(databaseId);
  }, []);

  const summary = data?.summary;
  const series = data?.series;
  const labels = series?.labels || [];
  const hasData = Boolean(summary && (
    summary.queries > 0
    || summary.trafficInBytes > 0
    || summary.trafficOutBytes > 0
    || summary.storageBytes > 0
    || data?.database
    || (data?.databaseUsage?.length || 0) > 0
  ));

  const topQueryLists: Record<QueryRank, TopQuery[]> = {
    latency: data?.topQueries || [],
    rowsRead: data?.topQueriesByRowsRead || [],
    rowsWritten: data?.topQueriesByRowsWritten || [],
    queries: data?.topQueriesByFrequency || [],
  };
  const visibleQueries = topQueryLists[queryRank];
  const totalSourceQueries = (data?.sources || []).reduce((total, source) => total + source.queries, 0);
  const totalOperationQueries = (data?.operations || []).reduce((total, operation) => total + operation.queries, 0);
  const totalReadWriteQueries = Math.max(1, (summary?.readQueries || 0) + (summary?.writeQueries || 0));
  const readShare = (summary?.readQueries || 0) / totalReadWriteQueries;
  const writeShare = (summary?.writeQueries || 0) / totalReadWriteQueries;
  const databaseUsage = data?.databaseUsage || [];
  const selectedDatabase = data?.database || null;
  const selectedUsage = selectedDatabase
    ? databaseUsage.find((database) => database.id === selectedDatabase.id) || null
    : null;
  const trafficPaths = data?.trafficPaths || [];
  const topTrafficPath = trafficPaths[0] || null;
  const topTrafficKind = topTrafficPath ? trafficPathKind(topTrafficPath.path) : null;
  const topTrafficLabel = topTrafficPath ? trafficPathLabel(topTrafficPath.path) : '';
  const trafficOrigins = summarizeTrafficPaths(trafficPaths);
  const captureHint = topTrafficKind === 'gateway'
    ? 'libSQL HTTP traffic was captured, but no SQL query metrics were recorded. Check the gateway/client pipeline and the analytics flush.'
    : topTrafficKind === 'health'
      ? 'Only health checks were captured; no ERP SQL reached the gateway.'
      : topTrafficKind === 'panel'
        ? 'Only panel API requests were captured; no ERP SQL reached the gateway.'
        : 'Only HTTP traffic was captured; no ERP SQL reached the gateway.';
  const comparisonMax = Math.max(
    1,
    ...databaseUsage.map((database) => database.rowsRead + database.rowsWritten),
  );

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
            <select
              value={selectedDatabaseId}
              onChange={(event) => selectDatabase(event.target.value)}
              className="h-9 max-w-[240px] rounded-lg border border-zinc-800 bg-[#0f0f0f] px-3 text-xs text-zinc-300 outline-none transition-colors focus:border-zinc-600"
              aria-label="Filter by database"
            >
              <option value="">All databases</option>
              {databaseUsage.map((database) => (
                <option key={database.id} value={database.id}>
                  {database.displayName || database.name}
                  {database.hasActivity
                    ? ''
                    : database.hasHttpActivity
                      ? ' · no SQL'
                      : ' · no traffic'}
                </option>
              ))}
            </select>
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
            {selectedDatabase && (
              <div className="flex flex-col gap-3 rounded-xl border border-zinc-800/80 bg-[#0f0f0f] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500">Database filter</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-zinc-100">{selectedDatabase.displayName}</h2>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      selectedDatabase.status === 'active'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border-zinc-700 text-zinc-400'
                    }`}>
                      {selectedDatabase.status || 'unknown'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {selectedDatabase.projectName || 'No project'}
                    {' · '}
                    {selectedDatabase.type || 'database'}
                    {selectedDatabase.runtimeProvider ? ` · ${selectedDatabase.runtimeProvider}` : ''}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
                    <span>
                      SQL queries:{' '}
                      <strong className="font-medium text-zinc-300">{formatNumber(summary!.queries)}</strong>
                    </span>
                    <span>
                      HTTP requests:{' '}
                      <strong className="font-medium text-zinc-300">{formatNumber(summary!.requests)}</strong>
                    </span>
                    {topTrafficPath && topTrafficKind && (
                      <span className="inline-flex items-center gap-1.5">
                        Top path:{' '}
                        <span
                          title={topTrafficPath.path}
                          className="inline-flex items-center gap-1.5 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300"
                        >
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: TRAFFIC_KIND_COLORS[topTrafficKind] }}
                          />
                          {topTrafficLabel}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {summary!.queries === 0 && (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
                      {summary!.requests > 0 ? 'No SQL queries' : 'No traffic captured'}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => selectDatabase('')}
                    className="rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-white"
                  >
                    Show all databases
                  </button>
                </div>
              </div>
            )}

            {selectedDatabase && summary!.queries === 0 && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
                <strong>No SQL query traffic captured for this database in the selected period.</strong>{' '}
                {summary!.requests > 0
                  ? `This database has ${formatNumber(summary!.requests)} HTTP requests (${formatBytes(summary!.trafficInBytes + summary!.trafficOutBytes)})${topTrafficLabel ? `, mostly ${topTrafficLabel}` : ''}, but no SQL statements were captured. ${captureHint} Storage is sampled independently. If an external client uses it directly, route it through the policy gateway.`
                  : 'No HTTP requests or SQL statements were captured. Storage is sampled independently. If an external client uses it directly, route it through the policy gateway.'}
              </div>
            )}

            {selectedDatabase && (
              <Panel
                title="Capture diagnostics"
                subtitle="SQL queries and HTTP requests are captured independently."
              >
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                  <DiagnosticStat label="SQL queries" value={formatNumber(summary!.queries)} />
                  <DiagnosticStat
                    label="HTTP requests"
                    value={formatNumber(summary!.requests)}
                    detail={formatBytes(summary!.trafficInBytes + summary!.trafficOutBytes)}
                  />
                  <DiagnosticStat
                    label="Last SQL source"
                    value={selectedUsage?.lastSource ? sourceLabel(selectedUsage.lastSource) : 'None'}
                  />
                  <DiagnosticStat
                    label="Last HTTP path"
                    value={
                      selectedUsage?.lastRequestPath
                        ? trafficPathLabel(selectedUsage.lastRequestPath)
                        : topTrafficLabel || '—'
                    }
                    detail={selectedUsage?.lastRequestAt ? formatRelativeTime(selectedUsage.lastRequestAt) : undefined}
                    title={selectedUsage?.lastRequestPath || topTrafficPath?.path}
                  />
                  <DiagnosticStat label="Storage" value={formatBytes(summary!.storageBytes)} />
                </div>

                <div className="mt-4">
                  <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                    Traffic origin
                  </h4>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <DiagnosticStat
                      label="Panel"
                      value={formatNumber(trafficOrigins.panel.requests)}
                      detail={formatBytes(trafficOrigins.panel.bytes)}
                    />
                    <DiagnosticStat
                      label="Gateway"
                      value={formatNumber(trafficOrigins.gateway.requests)}
                      detail={formatBytes(trafficOrigins.gateway.bytes)}
                    />
                    <DiagnosticStat
                      label="Health"
                      value={formatNumber(trafficOrigins.health.requests)}
                      detail={formatBytes(trafficOrigins.health.bytes)}
                    />
                    <DiagnosticStat
                      label="Other"
                      value={formatNumber(trafficOrigins.other.requests)}
                      detail={formatBytes(trafficOrigins.other.bytes)}
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                    HTTP traffic by path
                  </h4>
                  {trafficPaths.length > 0 ? (
                    <div className="overflow-hidden rounded-lg border border-zinc-800/70">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-zinc-800/80 text-zinc-500">
                            <th className="px-3 py-2">Origin</th>
                            <th className="px-3 py-2">Path</th>
                            <th className="px-3 py-2 text-right">Requests</th>
                            <th className="px-3 py-2 text-right">Bytes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trafficPaths.map((item) => {
                            const kind = trafficPathKind(item.path);
                            return (
                              <tr key={item.path} className="border-b border-zinc-800/40 last:border-0">
                                <td className="px-3 py-2">
                                  <span className="inline-flex items-center gap-1.5 text-[10px] text-zinc-400">
                                    <span
                                      className="h-1.5 w-1.5 rounded-full"
                                      style={{ backgroundColor: TRAFFIC_KIND_COLORS[kind] }}
                                    />
                                    {trafficKindLabel(kind)}
                                  </span>
                                </td>
                                <td className="break-all px-3 py-2 font-mono text-[11px] text-zinc-400">
                                  {item.path}
                                </td>
                                <td className="px-3 py-2 text-right text-zinc-400">{formatNumber(item.requests)}</td>
                                <td className="px-3 py-2 text-right text-zinc-400">{formatBytes(item.bytes)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-500">No HTTP requests captured in this period.</p>
                  )}
                </div>

                {summary!.queries === 0 && summary!.requests > 0 && (
                  <p className="mt-3 text-[11px] leading-relaxed text-amber-300">{captureHint}</p>
                )}
                <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                  SQL queries come from executed statements. HTTP requests include panel/API calls and gateway
                  health checks; storage is sampled hourly.
                </p>
              </Panel>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                icon={<Activity size={18} />}
                label="Queries"
                value={formatNumber(summary!.queries)}
                detail={`${formatNumber(summary!.readQueries)} read · ${formatNumber(summary!.writeQueries)} write · ${summary!.activeDatabases} active`}
              />
              <SummaryCard
                icon={<BookOpen size={18} />}
                label="Rows read"
                value={formatNumber(summary!.rowsRead)}
                detail={`${summary!.rowsReadPerQuery.toFixed(1)} rows per read`}
              />
              <SummaryCard
                icon={<PenLine size={18} />}
                label="Rows written"
                value={formatNumber(summary!.rowsWritten)}
                detail={`${summary!.rowsWrittenPerWrite.toFixed(1)} rows per write`}
              />
              <SummaryCard
                icon={<ArrowDownUp size={18} />}
                label="Read / write"
                value={formatRatio(summary!.readWriteRatio)}
                detail={`${formatNumber(summary!.readQueries)} read vs ${formatNumber(summary!.writeQueries)} write queries`}
              />
              <SummaryCard
                icon={<Gauge size={18} />}
                label="Latency p95"
                value={formatDuration(summary!.p95DurationMs)}
                detail={`${formatDuration(summary!.avgDurationMs)} average`}
              />
              <SummaryCard
                icon={<AlertTriangle size={18} />}
                label="Error rate"
                value={formatPercent(summary!.errorRate)}
                detail={`${formatNumber(summary!.errors)} failed queries`}
                tone={summary!.errors > 0 ? 'text-red-400' : undefined}
              />
              <SummaryCard
                icon={<HardDrive size={18} />}
                label="Storage"
                value={formatBytes(summary!.storageBytes)}
                detail={`${summary!.totalDatabases} ${summary!.totalDatabases === 1 ? 'database' : 'databases'} tracked`}
              />
              <SummaryCard
                icon={<Network size={18} />}
                label="HTTP traffic"
                value={formatBytes(summary!.trafficInBytes + summary!.trafficOutBytes)}
                detail={`${formatNumber(summary!.requests)} requests · ↓ ${formatBytes(summary!.trafficInBytes)} in · ↑ ${formatBytes(summary!.trafficOutBytes)} out`}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <ChartCard
                title="Query volume"
                subtitle="Read and write operations per bucket, with failed queries highlighted."
                className="xl:col-span-2"
              >
                <TimeSeriesChart
                  labels={labels}
                  series={[
                    { name: 'Read queries', color: '#34d399', values: series!.readQueries, fill: true },
                    { name: 'Write queries', color: '#a78bfa', values: series!.writeQueries },
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
              <Panel title="Operation mix" subtitle="Statements grouped by SQL operation.">
                {data.operations.length === 0 ? (
                  <EmptyPanelText>No operations in this period.</EmptyPanelText>
                ) : (
                  <div className="space-y-4">
                    {data.operations.map((operation) => {
                      const share = totalOperationQueries > 0 ? operation.queries / totalOperationQueries : 0;
                      const color = OPERATION_COLORS[operation.operation] || '#71717a';
                      return (
                        <div key={operation.operation}>
                          <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="flex items-center gap-2 text-zinc-300">
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                              {operationLabel(operation.operation)}
                            </span>
                            <span className="text-zinc-400">
                              {formatNumber(operation.queries)} · {Math.round(share * 100)}%
                            </span>
                          </div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.max(2, share * 100)}%`,
                                backgroundColor: color,
                              }}
                            />
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-500">
                            {formatNumber(operation.rowsRead)} read · {formatNumber(operation.rowsWritten)} written
                            {operation.errors > 0 ? ` · ${formatNumber(operation.errors)} failed` : ''}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>

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
                            <span className="text-zinc-300">{sourceLabel(source.source)}</span>
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

              <Panel title="Read / write mix" subtitle="Query distribution and row volume.">
                {summary!.readQueries + summary!.writeQueries === 0 ? (
                  <EmptyPanelText>No read or write queries in this period.</EmptyPanelText>
                ) : (
                  <div className="space-y-5">
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-3xl font-semibold text-zinc-100">
                          {formatRatio(summary!.readWriteRatio)}
                        </span>
                        <span className="text-xs text-zinc-500">reads per write</span>
                      </div>
                      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full bg-emerald-400" style={{ width: `${readShare * 100}%` }} />
                        <div className="h-full bg-violet-400" style={{ width: `${writeShare * 100}%` }} />
                      </div>
                      <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
                        <span>{formatNumber(summary!.readQueries)} read queries</span>
                        <span>{formatNumber(summary!.writeQueries)} write queries</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-zinc-800/70 p-3">
                        <p className="text-[11px] uppercase tracking-wider text-zinc-500">Rows read</p>
                        <p className="mt-1 text-lg font-semibold text-emerald-400">
                          {formatNumber(summary!.rowsRead)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-zinc-800/70 p-3">
                        <p className="text-[11px] uppercase tracking-wider text-zinc-500">Rows written</p>
                        <p className="mt-1 text-lg font-semibold text-violet-400">
                          {formatNumber(summary!.rowsWritten)}
                        </p>
                      </div>
                    </div>
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                      Reads count rows returned by SELECT or RETURNING. Writes count affected rows reported by the
                      database runtime.
                    </p>
                  </div>
                )}
              </Panel>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <Panel title="HTTP status codes" subtitle={`${formatNumber(summary!.requests)} requests in this period.`}>
                {data.statusCodes.length === 0 ? (
                  <EmptyPanelText>No HTTP requests recorded.</EmptyPanelText>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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

            <Panel
              title="Database comparison"
              subtitle="All existing databases. Bars show rows read and written in the selected period."
            >
              {databaseUsage.length === 0 ? (
                <EmptyPanelText>No existing databases.</EmptyPanelText>
              ) : (
                <div className="max-h-[360px] space-y-3 overflow-auto pr-1 custom-scrollbar">
                  {databaseUsage.map((database) => {
                    const totalRows = database.rowsRead + database.rowsWritten;
                    const readWidth = (database.rowsRead / comparisonMax) * 100;
                    const writeWidth = (database.rowsWritten / comparisonMax) * 100;
                    const isSelected = selectedDatabaseId === database.id;
                    return (
                      <button
                        key={database.id}
                        type="button"
                        onClick={() => selectDatabase(database.id)}
                        className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                          isSelected
                            ? 'border-emerald-500/30 bg-emerald-500/5'
                            : 'border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-800/20'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-zinc-200">
                              {database.displayName || database.name}
                            </p>
                            <p className="text-[11px] text-zinc-500">
                              {database.projectName || 'No project'} · {database.status || 'unknown'}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-xs text-zinc-300">{formatNumber(totalRows)} rows</p>
                            <p className="text-[11px] text-zinc-500">
                              {database.hasActivity
                                ? `${formatNumber(database.queries)} queries · ${formatDuration(database.p95DurationMs)} p95`
                                : database.hasHttpActivity
                                  ? `${formatNumber(database.httpRequests)} HTTP requests · no SQL`
                                  : 'No traffic captured'}
                            </p>
                          </div>
                        </div>
                        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-zinc-800">
                          {database.hasActivity && (
                            <>
                              <div className="h-full bg-emerald-400" style={{ width: `${readWidth}%` }} />
                              <div className="h-full bg-violet-400" style={{ width: `${writeWidth}%` }} />
                            </>
                          )}
                        </div>
                        <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
                          <span>{formatNumber(database.rowsRead)} read</span>
                          <span>{formatNumber(database.rowsWritten)} written</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </Panel>

            <DataTable
              title="Database usage"
              subtitle="All existing databases. Deleted databases are excluded. Click a row to filter every chart."
              columns={['Database', 'Reads', 'Writes', 'Query mix', 'Errors', 'P95', 'Storage', 'Source', 'Last activity']}
              empty={databaseUsage.length === 0}
              emptyMessage="No existing databases."
            >
              {databaseUsage.map((database) => {
                const totalQueries = Math.max(1, database.readQueries + database.writeQueries);
                const readShare = database.readQueries / totalQueries;
                const writeShare = database.writeQueries / totalQueries;
                const isSelected = selectedDatabaseId === database.id;
                const source = database.lastSource;
                const httpOnly = !source && database.hasHttpActivity;

                return (
                  <tr
                    key={database.id}
                    onClick={() => selectDatabase(database.id)}
                    className={`cursor-pointer border-b border-zinc-800/40 text-sm transition-colors last:border-0 ${
                      isSelected ? 'bg-emerald-500/5' : 'hover:bg-zinc-800/20'
                    }`}
                  >
                    <td className="px-6 py-3 font-medium text-zinc-200" title={database.id}>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/databases/${database.id}`}
                            onClick={(event) => event.stopPropagation()}
                            className="transition-colors hover:text-white"
                          >
                            {database.displayName || database.name}
                          </Link>
                          {isSelected && (
                            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
                              Selected
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] font-normal text-zinc-500">
                          {database.projectName || 'No project'} · {database.status || 'unknown'}
                        </span>
                        {database.needsRename && (
                          <Link
                            href={`/databases/${database.id}`}
                            onClick={(event) => event.stopPropagation()}
                            className="text-[11px] font-normal text-amber-400 transition-colors hover:text-amber-300"
                          >
                            Rename
                          </Link>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="text-zinc-300">{formatNumber(database.rowsRead)}</div>
                      <div className="text-[11px] text-zinc-500">{formatNumber(database.readQueries)} queries</div>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="text-zinc-300">{formatNumber(database.rowsWritten)}</div>
                      <div className="text-[11px] text-zinc-500">{formatNumber(database.writeQueries)} queries</div>
                    </td>
                    <td className="px-6 py-3">
                      {database.hasActivity ? (
                        <div
                          className="ml-auto flex h-2 w-20 overflow-hidden rounded-full bg-zinc-800"
                          title={`${formatNumber(database.readQueries)} read · ${formatNumber(database.writeQueries)} write queries`}
                        >
                          <div className="h-full bg-emerald-400" style={{ width: `${readShare * 100}%` }} />
                          <div className="h-full bg-violet-400" style={{ width: `${writeShare * 100}%` }} />
                        </div>
                      ) : (
                        <span className="block text-right text-[11px] text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className={database.errors > 0 ? 'text-red-400' : 'text-zinc-300'}>
                        {formatNumber(database.errors)}
                      </div>
                      <div className="text-[11px] text-zinc-500">{formatPercent(database.errorRate)}</div>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="text-zinc-300">
                        {database.hasActivity ? formatDuration(database.p95DurationMs) : '—'}
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        {database.hasActivity
                          ? `${formatDuration(database.avgDurationMs)} avg`
                          : database.hasHttpActivity
                            ? 'HTTP only'
                            : 'No traffic'}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-right text-zinc-400">{formatBytes(database.storageBytes)}</td>
                    <td className="px-6 py-3 text-right">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
                        source === 'gateway'
                          ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                          : source
                            ? 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
                            : httpOnly
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                              : 'border-zinc-700 bg-zinc-800/60 text-zinc-500'
                      }`}>
                        {source === 'gateway' ? 'Gateway' : source ? sourceLabel(source) : httpOnly ? 'HTTP only' : 'No traffic'}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right text-zinc-400">
                      {database.hasActivity ? (
                        formatRelativeTime(database.lastSeenAt)
                      ) : database.hasHttpActivity ? (
                        <span>
                          {formatRelativeTime(database.lastRequestAt)}
                          <span className="block font-mono text-[10px] text-zinc-600">
                            {database.lastRequestPath || 'HTTP'}
                          </span>
                        </span>
                      ) : (
                        'No traffic captured'
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>

            <DataTable
              title="Top projects"
              subtitle="Existing projects ranked by total rows processed."
              columns={['Project', 'Reads', 'Writes', 'Queries', 'Errors']}
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
                  <td className="px-6 py-3 text-right">
                    <div className="text-zinc-300">{formatNumber(project.rowsRead)}</div>
                    <div className="text-[11px] text-zinc-500">{formatNumber(project.readQueries)} queries</div>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <div className="text-zinc-300">{formatNumber(project.rowsWritten)}</div>
                    <div className="text-[11px] text-zinc-500">{formatNumber(project.writeQueries)} queries</div>
                  </td>
                  <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(project.queries)}</td>
                  <td className="px-6 py-3 text-right">
                    <div className={project.errors > 0 ? 'text-red-400' : 'text-zinc-400'}>
                      {formatNumber(project.errors)}
                    </div>
                    <div className="text-[11px] text-zinc-500">{formatPercent(project.errorRate)}</div>
                  </td>
                </tr>
              ))}
            </DataTable>

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
                          <span
                            className="mb-1.5 inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px]"
                            style={{
                              color: OPERATION_COLORS[query.operation || 'other'] || '#a1a1aa',
                              borderColor: `${OPERATION_COLORS[query.operation || 'other'] || '#71717a'}55`,
                              backgroundColor: `${OPERATION_COLORS[query.operation || 'other'] || '#71717a'}12`,
                            }}
                          >
                            {operationLabel(query.operation)}
                          </span>
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

            <p className="text-xs leading-relaxed text-zinc-500">
              Metrics are collected from this deployment onward. Read rows are rows returned by SELECT/RETURNING;
              written rows are affected rows reported by the runtime. HTTP traffic includes panel/API requests and
              gateway health checks; SQL query metrics are captured separately. Storage is sampled hourly. The gateway
              source captures direct ERP traffic. Deleted databases are excluded from every aggregate; existing
              databases with no captured SQL remain visible with zero query usage. Ranges follow your browser timezone.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function DiagnosticStat({
  label,
  value,
  detail,
  title,
}: {
  label: string;
  value: string;
  detail?: string;
  title?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/20 p-3" title={title}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-zinc-200">{value}</p>
      {detail && <p className="mt-0.5 truncate text-[11px] text-zinc-500">{detail}</p>}
    </div>
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
