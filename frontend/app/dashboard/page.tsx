"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { Activity, Database, FolderClosed, ArrowUpRight, BarChart3, DatabaseZap, HardDrive, Cpu } from 'lucide-react';
import { apiRequest } from '../../lib/api';

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState({ databases: 0, projects: 0 });
  const [metrics, setMetrics] = useState<any>(null);

  useEffect(() => {
    Promise.all([
      apiRequest<{ databases: any[] }>('/databases'),
      apiRequest<{ projects: any[] }>('/projects'),
      apiRequest<any>('/metrics')
    ]).then(([dbs, projs, metricsData]) => {
      setStats({
        databases: dbs.databases?.length || 0,
        projects: projs.projects?.length || 0
      });
      setMetrics(metricsData);
    }).catch(() => undefined);
  }, []);

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-zinc-100">Overview</h1>
          <p className="text-sm text-zinc-400 mt-1">Metrics and quick access to your resources.</p>
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
                     // Calculate relative size for visual bars (using max values in the list for scale)
                     const maxDbDisk = Math.max(...metrics.databases.map((d: any) => d.diskBytes), 1);
                     const maxDbRam = Math.max(...metrics.databases.map((d: any) => d.ramBytes), 1);
                     const diskPercent = (db.diskBytes / maxDbDisk) * 100;
                     const ramPercent = (db.ramBytes / maxDbRam) * 100;

                     return (
                     <div key={db.id} onClick={() => router.push(`/databases/${db.id}`)} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-zinc-800/50 bg-zinc-900/30 hover:bg-zinc-800/40 cursor-pointer transition-all duration-200 group">
                       <div className="flex items-center gap-3 mb-3 sm:mb-0">
                         <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${db.type === 'libsql' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
                           <Database size={16} />
                         </div>
                         <div>
                           <div className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors flex items-center gap-2">
                             {db.name}
                           </div>
                           <div className="text-xs text-zinc-500 flex items-center gap-1.5 mt-0.5">
                             <span className={`w-1.5 h-1.5 rounded-full ${db.type === 'libsql' ? 'bg-blue-500' : 'bg-emerald-500'}`}></span>
                             {db.type === 'libsql' ? 'LibSQL Container' : 'SQLite Local'}
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
                               {db.type === 'sqlite' 
                                 ? (db.isRamEstimated && db.ramBytes > 0 ? '~25 MB' : 'Shared') 
                                 : formatBytes(db.ramBytes)}
                             </span>
                           </div>
                           <div className="w-full bg-zinc-950 h-1.5 rounded-full overflow-hidden border border-zinc-800/30">
                             <div className={`h-full rounded-full ${db.type === 'sqlite' ? 'bg-zinc-600/50' : 'bg-amber-500/80'}`} style={{ width: `${db.type === 'sqlite' ? 100 : Math.max(2, ramPercent)}%` }}></div>
                           </div>
                         </div>
                       </div>
                     </div>
                   )})}
                 </div>
               )}
            </div>
          </div>

          <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] flex flex-col h-80">
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
        </div>
      </div>
    </AppShell>
  );
}
