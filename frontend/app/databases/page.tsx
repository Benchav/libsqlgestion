"use client";

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { apiRequest } from '../../lib/api';
import { Database, Table2, X, Plus, Search, HardDrive } from 'lucide-react';

type DatabaseInfo = { id: string; name: string; type: string; status: string; subdomain?: string; createdAt: string; project?: { id: string; name: string } };
type Project = { id: string; name: string };

export default function DatabasesPage() {
  const router = useRouter();
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Filter
  const [searchQuery, setSearchQuery] = useState('');

  async function loadDatabases() {
    const result = await apiRequest<{ databases: DatabaseInfo[] }>('/databases');
    setDatabases(result.databases);
  }

  async function loadProjects() {
    const result = await apiRequest<{ projects: Project[] }>('/projects');
    setProjects(result.projects);
  }

  useEffect(() => {
    Promise.all([loadDatabases(), loadProjects()]).catch(console.error);
  }, []);

  const filteredDatabases = databases.filter((d) => 
    d.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (d.project?.name || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Databases</h1>
            <p className="text-sm text-zinc-400 mt-1">Manage your local and remote database instances.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
              <input 
                type="text" 
                placeholder="Search databases..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 bg-[#0f0f0f] border border-zinc-800 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-zinc-600 transition-colors w-64"
              />
            </div>
            <button 
              onClick={() => setIsCreateModalOpen(true)}
              className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors"
            >
              <Plus size={16} /> Create Database
            </button>
          </div>
        </div>

        <div className="overflow-x-auto border border-zinc-800/80 rounded-lg bg-[#0f0f0f]">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-800/80 text-zinc-400 text-xs font-medium bg-zinc-900/20">
                <th className="py-3 px-4 font-normal">Name</th>
                <th className="py-3 px-4 font-normal">Project</th>
                <th className="py-3 px-4 font-normal">Type</th>
                <th className="py-3 px-4 font-normal">Status</th>
                <th className="py-3 px-4 font-normal">Created</th>
                <th className="py-3 px-4 font-normal w-24"></th>
              </tr>
            </thead>
            <tbody>
              {filteredDatabases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-zinc-500">
                    <div className="flex flex-col items-center gap-2">
                      <HardDrive size={32} className="opacity-20" />
                      <p>No databases found.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredDatabases.map((db) => (
                  <tr key={db.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors group cursor-pointer" onClick={() => router.push(`/databases/${db.id}`)}>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Database className="text-blue-500" size={14} />
                        <span className="font-medium text-zinc-200">{db.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-zinc-400">{db.project?.name || '—'}</td>
                    <td className="py-3 px-4">
                      <span className="bg-zinc-800 text-zinc-300 border border-zinc-700/50 px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider">
                        {db.type}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${
                        db.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                        db.status === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 
                        'bg-amber-500/10 text-amber-400 border-amber-500/20'
                      }`}>
                        {db.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-500 text-xs">
                      {new Date(db.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-3 px-4 flex justify-end gap-2 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/databases/${db.id}/studio`);
                        }} 
                        className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1.5 rounded text-xs font-medium border border-zinc-700 transition-colors"
                      >
                        <Table2 size={14} /> Edit Data
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isCreateModalOpen && (
        <CreateDatabaseModal 
          projects={projects}
          onClose={() => setIsCreateModalOpen(false)} 
          onSuccess={() => {
            setIsCreateModalOpen(false);
            loadDatabases();
          }}
        />
      )}
    </AppShell>
  );
}

function CreateDatabaseModal({ projects, onClose, onSuccess }: { projects: Project[], onClose: () => void, onSuccess: () => void }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [name, setName] = useState('');
  const [type, setType] = useState<'sqlite' | 'libsql' | 'remote'>('sqlite');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!projectId || !name.trim()) return;
    setError('');
    setCreating(true);
    try {
      await apiRequest('/databases', {
        method: 'POST',
        body: JSON.stringify({ projectId, name, type }),
      });
      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]">
      <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl w-full max-w-[480px] p-6 shadow-2xl">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Create Database</h2>
            <p className="text-sm text-zinc-400 mt-1">Create a new local SQLite database</p>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-md transition-colors">
            <X size={20} />
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleCreate} className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Project</label>
            <select 
              value={projectId} 
              onChange={(e) => setProjectId(e.target.value)}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
            >
              <option value="" disabled>Select a project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Name</label>
            <input 
              type="text" 
              placeholder="e.g. production-db" 
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" 
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Engine</label>
            <select 
              value={type} 
              onChange={(e) => setType(e.target.value as any)}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
            >
              <option value="sqlite">Local SQLite</option>
              <option value="libsql">Local libsql</option>
              <option value="remote">Remote Connection</option>
            </select>
          </div>

          <div className="mt-8 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
            <button type="submit" disabled={creating || !projectId || !name.trim()} className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
              {creating ? 'Creating...' : 'Create Database'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
