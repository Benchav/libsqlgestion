"use client";

import React, { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { apiRequest } from '../../lib/api';
import { History, Search, FileJson, ChevronDown, ChevronUp } from 'lucide-react';

type AuditLog = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  userEmail?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ logs: AuditLog[] }>('/audit')
      .then((r) => setLogs(r.logs || []))
      .catch((err: any) => setError(err.message));
  }, []);

  const filteredLogs = logs.filter((log) => {
    const term = search.toLowerCase();
    return (
      log.action.toLowerCase().includes(term) ||
      log.entityType.toLowerCase().includes(term) ||
      (log.userEmail || '').toLowerCase().includes(term)
    );
  });

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Audit Logs</h1>
            <p className="text-sm text-zinc-400 mt-1">Immutable record of all administrative actions performed in the platform.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
              <input 
                type="text" 
                placeholder="Search logs..." 
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-4 py-2 bg-[#0f0f0f] border border-zinc-800 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-zinc-600 transition-colors w-64"
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
          {filteredLogs.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center">
              <div className="w-12 h-12 bg-zinc-800/50 rounded-full flex items-center justify-center mb-4">
                <History className="text-zinc-500" size={24} />
              </div>
              <h3 className="text-zinc-200 font-medium mb-1">No logs found</h3>
              <p className="text-zinc-500 text-sm">No administrative actions have been recorded yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800/80 text-zinc-400 text-xs font-medium bg-zinc-900/30">
                    <th className="py-3 px-6">Timestamp</th>
                    <th className="py-3 px-6">Action</th>
                    <th className="py-3 px-6">Entity</th>
                    <th className="py-3 px-6">Actor</th>
                    <th className="py-3 px-6 w-12"></th>
                  </tr>
                </thead>
                <tbody className="text-sm text-zinc-300">
                  {filteredLogs.map((log) => {
                    const isExpanded = expandedId === log.id;
                    const isDelete = log.action.includes('DELETE');
                    return (
                      <React.Fragment key={log.id}>
                        <tr 
                          className={`border-b border-zinc-800/40 hover:bg-zinc-800/20 cursor-pointer transition-colors ${isExpanded ? 'bg-zinc-800/20' : ''}`}
                          onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        >
                          <td className="py-3 px-6 text-zinc-500 font-mono text-xs">
                            {new Date(log.createdAt).toLocaleString()}
                          </td>
                          <td className="py-3 px-6">
                            <span className={`px-2 py-0.5 rounded text-[11px] font-medium border uppercase tracking-wider ${
                              isDelete ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            }`}>
                              {log.action}
                            </span>
                          </td>
                          <td className="py-3 px-6">
                            <div className="flex flex-col">
                              <span className="font-medium text-zinc-200">{log.entityType}</span>
                              <span className="text-xs text-zinc-500 font-mono mt-0.5">{log.entityId}</span>
                            </div>
                          </td>
                          <td className="py-3 px-6 text-zinc-400">{log.userEmail || 'System'}</td>
                          <td className="py-3 px-6 text-zinc-500">
                            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </td>
                        </tr>
                        {isExpanded && log.metadata && (
                          <tr className="border-b border-zinc-800/60 bg-black/20">
                            <td colSpan={5} className="py-4 px-6">
                              <div className="bg-[#050505] border border-zinc-800 rounded-lg p-4">
                                <div className="flex items-center gap-2 mb-2 text-zinc-400">
                                  <FileJson size={14} />
                                  <span className="text-xs font-medium uppercase tracking-wider">Metadata Payload</span>
                                </div>
                                <pre className="font-mono text-xs text-blue-400 overflow-x-auto custom-scrollbar">
                                  {JSON.stringify(log.metadata, null, 2)}
                                </pre>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
