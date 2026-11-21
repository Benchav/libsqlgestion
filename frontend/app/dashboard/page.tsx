"use client";

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Cpu,
  Database,
  FolderClosed,
  HardDrive,
  PenLine,
  Timer,
} from 'lucide-react';
import { AppShell } from '../../components/AppShell';
import { TimeSeriesChart } from '../../components/analytics/TimeSeriesChart';
import { apiRequest } from '../../lib/api';
import { useAuth } from '../../lib/useAuth';
import {
  formatBytes,
  formatDayLabel,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRatio,
} from '../../lib/format';
import type { DashboardAnalytics } from '../../lib/analytics-types';
import { OPERATION_COLORS, operationLabel, sourceLabel } from '../../lib/analytics-ui';

function getMetricTypeLabel(database: any) {
  const effectiveType = database?.effectiveType || database?.type || 'sqlite';
  return effectiveType === 'libsql' ? 'LibSQL Container' : 'SQLite Local';
}

export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [stats, setStats] = useState({ databases: 0, projects: 0 });
  const [metrics, setMetrics] = useState<any>(null);
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState('');
  const canReadAnalytics = Boolean(user?.permissions?.includes('analytics.read'));

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    Promise.all([
      apiRequest<{ databases: any[] }>('/databases'),
      apiRequest<{ projects: any[] }>('/projects'),
      apiRequest<any>('/metrics'),
    ]).then(([dbs, projects, metricsData]) => {
      if (cancelled) return;
      setStats({
        databases: dbs.databases?.length || 0,
        projects: projects.projects?.length || 0,
      });
      setMetrics(metricsData);
    }).catch(() => undefined);

    if (canReadAnalytics) {
      setAnalyticsLoading(true);
      setAnalyticsError('');
      apiRequest<DashboardAnalytics>('/analytics/dashboard?range=7d')
        .then((data) => {
          if (!cancelled) setAnalytics(data);
        })
        .catch((error: any) => {
          if (!cancelled) setAnalyticsError(error?.message || 'Failed to load analytics');
        })
        .finally(() => {
          if (!cancelled) setAnalyticsLoading(false);
        });
    } else {
      setAnalytics(null);
      setAnalyticsLoading(false);
    }

    return () => { cancelled = true; };
  }, [user, canReadAnalytics]);

  const summary = analytics?.summary;
  const series = analytics?.series;
  const readShare = summary
    ? summary.readQueries / Math.max(1, summary.readQueries + summary.writeQueries)
    : 0;
  const writeShare = summary
    ? summary.writeQueries / Math.max(1, summary.readQueries + summary.writeQueries)
    : 0;
  const totalOperationQueries = (analytics?.operations || [])
    .reduce((total, operation) => total + operation.queries, 0);

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-100">Overview</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Resource health, data activity and quick access to your databases.
            </p>
          </div>
          {canReadAnalytics && (
            <button
              type="button"
              onClick={() => router.push('/analytics')}
              className="inline-flex items-center gap-2 self-start rounded-lg border border-zinc-800 bg-[#0f0f0f] px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-white sm:self-auto"
            >
              Open analytics
              <ArrowRight size={14} />
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition-colors cursor-pointer group" onClick={() => router.push('/databases')}>
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                <Database size={20} />
              </div>
              <ArrowUpRight size={16} className="text-zinc-600 group-hover:text-zinc-300 transition-colors" />
            </div>
            <h3 className="text-zinc-400 text-sm font-medium">Total Databases</h3>
            <p className="text-3xl font-semibold text-zinc-100 mt-1">{stats.databases}</p>
          </div>

          <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition-colors cursor-pointer group" onClick={() => router.push('/projects')}>
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                <FolderClosed size={20} />
              </div>
              <ArrowUpRight size={16} className="text-zinc-600 group-hover:text-zinc-300 transition-colors" />
            </div>
            <h3 className="text-zinc-400 text-sm font-medium">Total Projects</h3>
            <p className="text-3xl font-semibold text-zinc-100 mt-1">{stats.projects}</p>
          </div>

          <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl p-5 relative overflow-hidden group">
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
                <HardDrive size={20} />
              </div>
            </div>
            <h3 className="text-zinc-400 text-sm font-medium">Total Disk Used</h3>
            <p className="text-3xl font-semibold text-zinc-100 mt-1">{metrics ? formatBytes(metrics.totalDiskBytes) : '—'}</p>
          </div>

          <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl p-5 relative overflow-hidden group">
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                <Cpu size={20} />
              </div>
            </div>
            <h3 className="text-zinc-400 text-sm font-medium">Total RAM Used</h3>
            <div className="flex items-end justify-between mt-1">
              <p className="text-3xl font-semibold text-zinc-100">{metrics ? formatBytes(metrics.totalRamBytes) : '—'}</p>
              {metrics && metrics.maxRamBytes && (
                <span className="text-xs text-zinc-500 mb-1">/ {formatBytes(metrics.maxRamBytes)}</span>
              )}
            </div>
            {metrics && metrics.maxRamBytes > 0 && (
              <div className="w-full bg-zinc-800/50 h-1 mt-3 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${((metrics.totalRamBytes / metrics.maxRamBytes) * 100) > 80 ? 'bg-red-500' : 'bg-amber-500'}`}
                  style={{ width: `${Math.min(100, Math.max(0, (metrics.totalRamBytes / metrics.maxRamBytes) * 100))}%` }}
                ></div>
              </div>
            )}
          </div>
        </div>

        {canReadAnalytics && (
          <section className="mb-8">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium text-zinc-200">Data activity · last 7 days</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Read and write usage from the panel and direct ERP traffic through the gateway.
                </p>
              </div>
            </div>

            {analyticsLoading && !analytics ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="h-28 animate-pulse rounded-xl border border-zinc-800/80 bg-[#0f0f0f]" />
                ))}
              </div>
            ) : analyticsError ? (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
                {analyticsError}
              </div>
            ) : summary && series ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <MiniKpi
                    icon={<BookOpen size={18} />}
                    label="Rows read"
                    value={formatNumber(summary.rowsRead)}
                    detail={`${formatNumber(summary.readQueries)} read queries`}
                    tone="text-emerald-400"
                  />
                  <MiniKpi
                    icon={<PenLine size={18} />}
                    label="Rows written"
                    value={formatNumber(summary.rowsWritten)}
                    detail={`${formatNumber(summary.writeQueries)} write queries`}
                    tone="text-violet-400"
                  />
                  <MiniKpi
                    icon={<Activity size={18} />}
                    label="Queries"
                    value={formatNumber(summary.queries)}
                    detail={`${formatPercent(summary.errorRate)} error rate`}
                  />
                  <MiniKpi
                    icon={<Timer size={18} />}
                    label="P95 latency"
                    value={formatDuration(summary.p95DurationMs)}
                    detail={`${formatDuration(summary.avgDurationMs)} average`}
                  />
                </div>

                <div className="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-3">
                  <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-5 xl:col-span-2">
                    <div className="mb-4">
                      <h3 className="font-medium text-zinc-200">Read vs write activity</h3>
                      <p className="mt-1 text-xs text-zinc-500">
                        Rows processed per {analytics!.bucket === 'hour' ? 'hour' : 'day'}.
                      </p>
                    </div>
                    <TimeSeriesChart
                      labels={series.labels}
                      series={[
                        { name: 'Rows read', color: '#34d399', values: series.rowsRead, fill: true },
                        { name: 'Rows written', color: '#a78bfa', values: series.rowsWritten },
                      ]}
                      height={230}
                      formatValue={formatNumber}
                      formatLabel={formatDayLabel}
                      emptyMessage="No activity in the last 7 days."
                    />
                  </div>

                  <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-5">
                    <div>
                      <h3 className="font-medium text-zinc-200">Usage mix</h3>
                      <p className="mt-1 text-xs text-zinc-500">Read and write query distribution.</p>
                    </div>

                    <div className="mt-5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-3xl font-semibold text-zinc-100">
                          {formatRatio(summary.readWriteRatio)}
                        </span>
                        <span className="text-xs text-zinc-500">reads per write</span>
                      </div>
                      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full bg-emerald-400" style={{ width: `${readShare * 100}%` }} />
                        <div className="h-full bg-violet-400" style={{ width: `${writeShare * 100}%` }} />
                      </div>
                      <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
                        <span>{formatNumber(summary.readQueries)} read</span>
                        <span>{formatNumber(summary.writeQueries)} write</span>
                      </div>
                    </div>

                    <div className="mt-5 space-y-3">
                      {analytics!.operations.length === 0 ? (
                        <p className="text-xs text-zinc-500">No operations in the last 7 days.</p>
                      ) : analytics!.operations.slice(0, 4).map((operation) => {
                        const share = totalOperationQueries > 0
                          ? operation.queries / totalOperationQueries
                          : 0;
                        return (
                          <div key={operation.operation}>
                            <div className="flex items-center justify-between gap-3 text-xs">
                              <span className="flex items-center gap-2 text-zinc-300">
                                <span
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{ backgroundColor: OPERATION_COLORS[operation.operation] || '#71717a' }}
                                />
                                {operationLabel(operation.operation)}
                              </span>
                              <span className="text-zinc-500">{formatNumber(operation.queries)}</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.max(2, share * 100)}%`,
                                  backgroundColor: OPERATION_COLORS[operation.operation] || '#71717a',
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="col-span-2 border border-zinc-800/80 rounded-xl bg-[#0f0f0f] flex flex-col h-96 shadow-lg shadow-black/20">
            <div className="p-5 border-b border-zinc-800/80 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart3 size={18} className="text-zinc-400" />
                <h3 className="font-medium text-zinc-200">Database Resources</h3>
              </div>
              {metrics && (
                <div className="text-xs text-zinc-500 flex items-center gap-2 bg-zinc-900 px-3 py-1.5 rounded-full border border-zinc-800">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  Server CPU: {metrics.cpuUsagePercent.toFixed(1)}%
                </div>
              )}
            </div>
            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
              {!metrics ? (
                <div className="h-full flex items-center justify-center"><p className="text-zinc-500 text-sm animate-pulse">Gathering telemetry...</p></div>
              ) : metrics.databases.length === 0 ? (
                <div className="h-full flex items-center justify-center"><p className="text-zinc-500 text-sm">No active databases.</p></div>
              ) : (
                <div className="space-y-3">
                  {metrics.databases.map((db: any) => {
                    const maxDbDisk = Math.max(...metrics.databases.map((d: any) => d.diskBytes), 1);
                    const maxDbRam = Math.max(...metrics.databases.map((d: any) => d.ramBytes), 1);
                    const diskPercent = (db.diskBytes / maxDbDisk) * 100;
                    const ramPercent = (db.ramBytes / maxDbRam) * 100;

                    return (
                      <div key={db.id} onClick={() => router.push(`/databases/${db.id}`)} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-zinc-800/50 bg-zinc-900/30 hover:bg-zinc-800/40 cursor-pointer transition-all duration-200 group">
                        <div className="flex items-center gap-3 mb-3 sm:mb-0">
                          <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${(db.effectiveType || db.type) === 'libsql' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
                            <Database size={16} />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors flex items-center gap-2">
                              {db.name}
                            </div>
                            <div className="text-xs text-zinc-500 flex items-center gap-1.5 mt-0.5">
                              <span className={`w-1.5 h-1.5 rounded-full ${(db.effectiveType || db.type) === 'libsql' ? 'bg-blue-500' : 'bg-emerald-500'}`}></span>
                              {getMetricTypeLabel(db)}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-8 sm:w-1/2 justify-end">
                          <div className="w-1/2 flex flex-col gap-1.5">
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-zinc-500">Disk</span>
                              <span className="text-zinc-300 font-medium">{formatBytes(db.diskBytes)}</span>
                            </div>
                            <div className="w-full bg-zinc-950 h-1.5 rounded-full overflow-hidden border border-zinc-800/30">
                              <div className="h-full bg-purple-500/80 rounded-full" style={{ width: `${Math.max(2, diskPercent)}%` }}></div>
                            </div>
                          </div>

                          <div className="w-1/2 flex flex-col gap-1.5">
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-zinc-500">RAM</span>
                              <span className="text-zinc-300 font-medium">
                                {(db.effectiveType || db.type) === 'sqlite'
                                  ? (db.isRamEstimated && db.ramBytes > 0 ? '~25 MB' : 'Shared')
                                  : formatBytes(db.ramBytes)}
                              </span>
                            </div>
                            <div className="w-full bg-zinc-950 h-1.5 rounded-full overflow-hidden border border-zinc-800/30">
                              <div className={`h-full rounded-full ${(db.effectiveType || db.type) === 'sqlite' ? 'bg-zinc-600/50' : 'bg-amber-500/80'}`} style={{ width: `${(db.effectiveType || db.type) === 'sqlite' ? 100 : Math.max(2, ramPercent)}%` }}></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {canReadAnalytics && analyticsLoading ? (
            <div className="h-96 animate-pulse rounded-xl border border-zinc-800/80 bg-[#0f0f0f]" />
          ) : canReadAnalytics && analytics ? (
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] flex flex-col h-96">
              <div className="p-5 border-b border-zinc-800/80 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Activity size={18} className="text-zinc-400" />
                  <div>
                    <h3 className="font-medium text-zinc-200">Database usage</h3>
                    <p className="mt-0.5 text-[11px] text-zinc-500">All existing databases · last 7 days</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => router.push('/analytics')}
                  className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  View all
                </button>
              </div>
              <div className="flex-1 overflow-auto p-2 custom-scrollbar">
                {analytics.databaseUsage.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-zinc-500">No existing databases.</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {analytics.databaseUsage.map((database) => {
                      const totalQueries = Math.max(1, database.readQueries + database.writeQueries);
                      const readShare = database.readQueries / totalQueries;
                      const writeShare = database.writeQueries / totalQueries;
                      const activityLabel = database.hasActivity
                        ? sourceLabel(database.lastSource)
                        : database.hasHttpActivity
                          ? 'HTTP only'
                          : 'No traffic';
                      return (
                        <button
                          key={database.id}
                          type="button"
                          onClick={() => router.push(`/analytics?databaseId=${database.id}`)}
                          className="w-full rounded-lg p-3 text-left transition-colors hover:bg-zinc-800/40"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-zinc-200">
                                {database.displayName || database.name}
                              </p>
                              <p className="truncate text-[11px] text-zinc-500">
                                {database.projectName || 'No project'} · {activityLabel}
                              </p>
                            </div>
                            <span className="shrink-0 text-xs text-zinc-400">
                              {database.hasActivity
                                ? `${formatNumber(database.queries)} q`
                                : database.hasHttpActivity
                                  ? `${formatNumber(database.httpRequests)} HTTP`
                                  : 'No traffic'}
                            </span>
                          </div>
                          <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
                            {database.hasActivity && (
                              <>
                                <div className="h-full bg-emerald-400" style={{ width: `${readShare * 100}%` }} />
                                <div className="h-full bg-violet-400" style={{ width: `${writeShare * 100}%` }} />
                              </>
                            )}
                          </div>
                          <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
                            <span>{formatNumber(database.rowsRead)} read</span>
                            <span>
                              {database.hasActivity
                                ? `${formatNumber(database.rowsWritten)} written`
                                : database.hasHttpActivity
                                  ? 'No SQL captured'
                                  : 'No traffic captured'}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] flex flex-col h-96">
              <div className="p-5 border-b border-zinc-800/80 flex items-center gap-2">
                <Activity size={18} className="text-zinc-400" />
                <h3 className="font-medium text-zinc-200">Recent Activity</h3>
              </div>
              <div className="flex-1 flex flex-col p-2">
                <button onClick={() => router.push('/audit')} className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-zinc-800/40 transition-colors group">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                    <div className="text-sm text-zinc-300">System initialization complete</div>
                  </div>
                  <ArrowUpRight size={14} className="text-zinc-600 group-hover:text-zinc-400" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function MiniKpi({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="text-zinc-500">{icon}</span>
      </div>
      <p className={`mt-3 text-2xl font-semibold ${tone || 'text-zinc-100'}`}>{value}</p>
      <p className="mt-1 truncate text-[11px] text-zinc-500">{detail}</p>
    </div>
  );
}
