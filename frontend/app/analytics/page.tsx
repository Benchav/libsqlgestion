'use client';

import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownUp,
  Database,
  Gauge,
  HardDrive,
  RefreshCw,
  Rows3,
  Timer,
} from 'lucide-react';
import { AppShell } from '../../components/AppShell';
import { TimeSeriesChart } from '../../components/analytics/TimeSeriesChart';
import { apiRequest } from '../../lib/api';

type AnalyticsRange = 'today' | '7d' | '30d' | 'month';

type AnalyticsOverview = {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  summary: {
    rowsRead: number;
    rowsWritten: number;
    queries: number;
    errors: number;
    avgDurationMs: number;
    p95DurationMs: number;
    maxDurationMs: number;
    storageBytes: number;
    trafficInBytes: number;
    trafficOutBytes: number;
    syncs: null;
  };
  series: {
    labels: string[];
    queries: number[];
    rowsRead: number[];
    rowsWritten: number[];
    latencyAvg: number[];
    latencyMax: number[];
    trafficIn: number[];
    trafficOut: number[];
    storage: number[];
  };
  topDatabases: Array<{
    id: string;
    name: string;
    rowsRead: number;
    rowsWritten: number;
    queries: number;
    storageBytes: number;
  }>;
  topQueries: Array<{
    fingerprint: string;
    sqlPreview: string;
    queries: number;
    rowsRead: number;
    rowsWritten: number;
    avgDurationMs: number;
    maxDurationMs: number;
  }>;
};

const RANGES: Array<{ value: AnalyticsRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
];

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

function formatBucketLabel(label: string, bucket: 'hour' | 'day') {
  const date = new Date(label);
  if (!Number.isFinite(date.getTime())) return label;
  if (bucket === 'hour') {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadAnalytics(nextRange: AnalyticsRange = range) {
    setLoading(true);
    setError('');
    try {
      const result = await apiRequest<AnalyticsOverview>(`/analytics?range=${nextRange}`);
      setData(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAnalytics(range);
  }, [range]);

  const summary = data?.summary;
  const series = data?.series;
  const chartLabels = series?.labels || [];
  const hasData = Boolean(summary && (
    summary.queries > 0
    || summary.trafficInBytes > 0
    || summary.trafficOutBytes > 0
    || summary.storageBytes > 0
  ));

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
        ) : !hasData ? (
          <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-12 text-center">
            <Activity className="mx-auto text-zinc-600" size={28} />
            <h2 className="mt-3 text-sm font-medium text-zinc-200">No analytics yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
              Query metrics are collected from the moment this version was deployed. Run some queries or connect
              the ERP to start seeing usage.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard icon={<Rows3 size={18} />} label="Rows read" value={formatNumber(summary!.rowsRead)} />
              <SummaryCard icon={<ArrowDownUp size={18} />} label="Rows written" value={formatNumber(summary!.rowsWritten)} />
              <SummaryCard icon={<Database size={18} />} label="Queries" value={formatNumber(summary!.queries)} />
              <SummaryCard icon={<Gauge size={18} />} label="Latency p95" value={formatDuration(summary!.p95DurationMs)} />
              <SummaryCard icon={<HardDrive size={18} />} label="Storage" value={formatBytes(summary!.storageBytes)} />
              <SummaryCard icon={<Timer size={18} />} label="Average latency" value={formatDuration(summary!.avgDurationMs)} />
              <SummaryCard icon={<ArrowDownUp size={18} />} label="Traffic in" value={formatBytes(summary!.trafficInBytes)} />
              <SummaryCard icon={<ArrowDownUp size={18} />} label="Traffic out" value={formatBytes(summary!.trafficOutBytes)} />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <ChartCard title="Latency" subtitle="Average and maximum query duration">
                <TimeSeriesChart
                  labels={chartLabels}
                  series={[
                    { name: 'Average', color: '#38bdf8', values: series!.latencyAvg, fill: true },
                    { name: 'Max', color: '#f472b6', values: series!.latencyMax },
                  ]}
                  formatValue={formatDuration}
                  formatLabel={(label) => formatBucketLabel(label, data!.bucket)}
                />
              </ChartCard>

              <ChartCard title="Rows" subtitle="Rows returned by reads and affected by writes">
                <TimeSeriesChart
                  labels={chartLabels}
                  series={[
                    { name: 'Rows read', color: '#34d399', values: series!.rowsRead, fill: true },
                    { name: 'Rows written', color: '#a78bfa', values: series!.rowsWritten },
                  ]}
                  formatValue={formatNumber}
                  formatLabel={(label) => formatBucketLabel(label, data!.bucket)}
                />
              </ChartCard>

              <ChartCard title="Traffic" subtitle="Database API request and response bytes">
                <TimeSeriesChart
                  labels={chartLabels}
                  series={[
                    { name: 'Inbound', color: '#f59e0b', values: series!.trafficIn, fill: true },
                    { name: 'Outbound', color: '#60a5fa', values: series!.trafficOut },
                  ]}
                  formatValue={formatBytes}
                  formatLabel={(label) => formatBucketLabel(label, data!.bucket)}
                />
              </ChartCard>

              <ChartCard title="Storage" subtitle="Size of managed databases and sidecar files">
                <TimeSeriesChart
                  labels={chartLabels}
                  series={[
                    { name: 'Storage', color: '#c084fc', values: series!.storage, fill: true },
                  ]}
                  formatValue={formatBytes}
                  formatLabel={(label) => formatBucketLabel(label, data!.bucket)}
                />
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-[#0f0f0f]">
                <div className="border-b border-zinc-800/80 bg-zinc-900/30 px-6 py-4">
                  <h2 className="font-medium text-zinc-200">Top databases</h2>
                  <p className="mt-1 text-xs text-zinc-500">Ranked by rows read in the selected period.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-zinc-800/80 text-xs font-medium text-zinc-400">
                        <th className="px-6 py-3">Database</th>
                        <th className="px-6 py-3 text-right">Rows read</th>
                        <th className="px-6 py-3 text-right">Rows written</th>
                        <th className="px-6 py-3 text-right">Queries</th>
                        <th className="px-6 py-3 text-right">Storage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.topDatabases.map((database) => (
                        <tr key={database.id} className="border-b border-zinc-800/40 text-sm">
                          <td className="px-6 py-3 font-medium text-zinc-200">{database.name}</td>
                          <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(database.rowsRead)}</td>
                          <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(database.rowsWritten)}</td>
                          <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(database.queries)}</td>
                          <td className="px-6 py-3 text-right text-zinc-400">{formatBytes(database.storageBytes)}</td>
                        </tr>
                      ))}
                      {data!.topDatabases.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-6 py-8 text-center text-sm text-zinc-500">No activity yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-[#0f0f0f]">
                <div className="border-b border-zinc-800/80 bg-zinc-900/30 px-6 py-4">
                  <h2 className="font-medium text-zinc-200">Top queries</h2>
                  <p className="mt-1 text-xs text-zinc-500">Grouped by normalized SQL. Literals are redacted.</p>
                </div>
                <div className="max-h-[420px] overflow-auto custom-scrollbar">
                  <table className="w-full border-collapse text-left">
                    <thead className="sticky top-0 bg-[#0f0f0f]">
                      <tr className="border-b border-zinc-800/80 text-xs font-medium text-zinc-400">
                        <th className="px-6 py-3">Query</th>
                        <th className="px-6 py-3 text-right">Avg</th>
                        <th className="px-6 py-3 text-right">Read</th>
                        <th className="px-6 py-3 text-right">Written</th>
                        <th className="px-6 py-3 text-right">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.topQueries.map((query) => (
                        <tr key={query.fingerprint} className="border-b border-zinc-800/40 align-top text-xs">
                          <td className="max-w-[320px] px-6 py-3">
                            <pre className="max-h-16 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-400">
                              {query.sqlPreview}
                            </pre>
                          </td>
                          <td className="px-6 py-3 text-right text-zinc-300">{formatDuration(query.avgDurationMs)}</td>
                          <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(query.rowsRead)}</td>
                          <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(query.rowsWritten)}</td>
                          <td className="px-6 py-3 text-right text-zinc-400">{formatNumber(query.queries)}</td>
                        </tr>
                      ))}
                      {data!.topQueries.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-6 py-8 text-center text-sm text-zinc-500">No queries yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <p className="text-xs text-zinc-500">
              Metrics are collected from this deployment onward. Syncs are not applicable because LibSQLite is
              running without embedded replicas.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="text-zinc-500">{icon}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
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
