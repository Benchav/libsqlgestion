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

          <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl p-5">
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
                <HardDrive size={20} />
              </div>
            </div>
            <h3 className="text-zinc-400 text-sm font-medium">Total Disk Used</h3>
            <p className="text-3xl font-semibold text-zinc-100 mt-1">{metrics ? formatBytes(metrics.totalDiskBytes) : '—'}</p>
          </div>

          <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl p-5">
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                <Cpu size={20} />
              </div>
            </div>
            <h3 className="text-zinc-400 text-sm font-medium">Total RAM Used</h3>
            <p className="text-3xl font-semibold text-zinc-100 mt-1">{metrics ? formatBytes(metrics.totalRamBytes) : '—'}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="col-span-2 border border-zinc-800/80 rounded-xl bg-[#0f0f0f] flex flex-col h-80">
            <div className="p-5 border-b border-zinc-800/80 flex items-center gap-2">
              <BarChart3 size={18} className="text-zinc-400" />
              <h3 className="font-medium text-zinc-200">System Activity</h3>
            </div>
            <div className="flex-1 overflow-auto p-4">
               {!metrics ? (
                 <div className="h-full flex items-center justify-center"><p className="text-zinc-500 text-sm">Loading metrics...</p></div>
               ) : metrics.databases.length === 0 ? (
                 <div className="h-full flex items-center justify-center"><p className="text-zinc-500 text-sm">No active databases.</p></div>
               ) : (
                 <div className="space-y-3">
                   {metrics.databases.map((db: any) => (
                     <div key={db.id} onClick={() => router.push(`/databases/${db.id}`)} className="flex items-center justify-between p-3 rounded-lg border border-zinc-800/50 bg-zinc-900/30 hover:bg-zinc-800/40 cursor-pointer transition-colors group">
                       <div className="flex items-center gap-3">
                         <div className={`w-2 h-2 rounded-full ${db.type === 'libsql' ? 'bg-blue-500' : 'bg-emerald-500'}`}></div>
                         <div>
                           <div className="text-sm font-medium text-zinc-200 group-hover:text-blue-400 transition-colors">{db.name}</div>
                           <div className="text-xs text-zinc-500 capitalize">{db.type === 'libsql' ? 'Docker Managed' : 'Local SQLite'}</div>
                         </div>
                       </div>
                       <div className="flex items-center gap-6">
                         <div className="text-right">
                           <div className="text-xs text-zinc-500">Disk</div>
                           <div className="text-sm text-zinc-300">{formatBytes(db.diskBytes)}</div>
                         </div>
                         <div className="text-right w-20">
                           <div className="text-xs text-zinc-500">RAM</div>
                           <div className="text-sm text-zinc-300">
                             {db.type === 'sqlite' 
                               ? (db.isRamEstimated && db.ramBytes > 0 ? '~25 MB' : 'Shared') 
                               : formatBytes(db.ramBytes)}
                           </div>
                         </div>
                       </div>
                     </div>
                   ))}
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
