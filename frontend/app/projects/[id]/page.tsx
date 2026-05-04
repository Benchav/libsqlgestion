"use client";

import { useEffect, useState, FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '../../../components/AppShell';
import { apiRequest } from '../../../lib/api';
import { Database, Plus, ChevronRight, Activity, Users, HardDrive, X } from 'lucide-react';

type ProjectDetail = {
  id: string;
  name: string;
  createdAt: string;
  owner?: { id: string; email: string };
  members?: Array<{ id: string; user: { id: string; email: string } }>;
  databases?: Array<{ id: string; name: string; type: string; status: string; subdomain?: string; createdAt: string }>;
};

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  async function loadProject() {
    try {
      const result = await apiRequest<{ project: ProjectDetail }>(`/projects/${id}`);
      setProject(result.project);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (id) loadProject();
  }, [id]);

  if (!project && !error) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full text-zinc-500">Loading project details...</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center text-sm text-zinc-400 mb-4">
            <span className="cursor-pointer hover:text-zinc-200" onClick={() => router.push('/projects')}>Projects</span>
            <ChevronRight size={14} className="mx-2" />
            <span className="text-zinc-100">{project?.name}</span>
          </div>

          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center justify-center">
                <Activity className="text-emerald-500" size={24} />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-zinc-100">{project?.name}</h1>
                <div className="text-sm text-zinc-400 mt-1 flex items-center gap-2">
                  <span>Created {new Date(project?.createdAt || '').toLocaleDateString()}</span>
                  <span>·</span>
                  <span>Owner: <strong className="text-zinc-300">{project?.owner?.email || '—'}</strong></span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button 
                onClick={() => setIsCreateModalOpen(true)}
                className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors"
              >
                <Plus size={16} /> New Database
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Databases List */}
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Database size={16} className="text-zinc-400" />
                  <h2 className="font-medium text-zinc-200">Databases</h2>
                </div>
                <span className="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full text-xs font-medium">
                  {project?.databases?.length || 0}
                </span>
              </div>

              {!project?.databases?.length ? (
                <div className="p-12 text-center flex flex-col items-center justify-center">
                  <div className="w-12 h-12 bg-zinc-800/50 rounded-full flex items-center justify-center mb-4">
                    <HardDrive className="text-zinc-500" size={24} />
                  </div>
                  <h3 className="text-zinc-200 font-medium mb-1">No databases</h3>
                  <p className="text-zinc-500 text-sm mb-6 max-w-md">This project doesn't have any databases yet. Create one to get started.</p>
                  <button 
                    onClick={() => setIsCreateModalOpen(true)}
                    className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors"
                  >
                    <Plus size={16} /> Create Database
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-zinc-800/80 text-zinc-400 text-xs font-medium">
                        <th className="py-3 px-6">Name</th>
                        <th className="py-3 px-6">Type</th>
                        <th className="py-3 px-6">Status</th>
                        <th className="py-3 px-6">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {project.databases.map((db) => (
                        <tr 
                          key={db.id} 
                          className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors cursor-pointer group"
                          onClick={() => router.push(`/databases/${db.id}`)}
                        >
                          <td className="py-3 px-6">
                            <span className="font-medium text-zinc-200 group-hover:text-blue-400 transition-colors">{db.name}</span>
                          </td>
                          <td className="py-3 px-6">
                            <span className="bg-zinc-800 text-zinc-300 border border-zinc-700/50 px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider">
                              {db.type}
                            </span>
                          </td>
                          <td className="py-3 px-6">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium border ${
                              db.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                              db.status === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 
                              'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            }`}>
                              {db.status}
                            </span>
                          </td>
                          <td className="py-3 px-6 text-zinc-500 text-xs">
                            {new Date(db.createdAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            {/* Members */}
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center gap-2">
                <Users size={16} className="text-zinc-400" />
                <h2 className="font-medium text-zinc-200">Project Members</h2>
              </div>
              <div className="p-4">
                {!project?.members?.length ? (
                  <p className="text-sm text-zinc-500 text-center py-4">No additional members.</p>
                ) : (
                  <div className="space-y-3">
                    {project.members.map((m) => (
                      <div key={m.id} className="flex items-center gap-3 p-2 hover:bg-zinc-800/30 rounded-lg transition-colors">
                        <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0 border border-zinc-700">
                          <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${m.user?.email || 'User'}&backgroundColor=27272a`} alt="User" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-zinc-200 truncate">{m.user?.email || '—'}</p>
                          <p className="text-xs text-zinc-500 font-mono truncate">{m.user?.id || '—'}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {isCreateModalOpen && (
        <CreateDatabaseModal 
          projectId={id}
          onClose={() => setIsCreateModalOpen(false)} 
          onSuccess={() => {
            setIsCreateModalOpen(false);
            loadProject();
          }}
        />
      )}
    </AppShell>
  );
}

function CreateDatabaseModal({ projectId, onClose, onSuccess }: { projectId: string, onClose: () => void, onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'sqlite' | 'libsql' | 'remote'>('sqlite');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setCreating(true);
    try {
      await apiRequest('/databases', {
        method: 'POST',
        body: JSON.stringify({ projectId, name, type, url: url || undefined, token: token || undefined }),
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
            <p className="text-sm text-zinc-400 mt-1">Add a new database to this project.</p>
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

          {type === 'remote' && (
            <>
              <div className="flex items-center gap-4">
                <label className="w-20 text-sm font-medium text-zinc-300">URL</label>
                <input 
                  type="text" 
                  placeholder="libsql://..." 
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" 
                />
              </div>
              <div className="flex items-center gap-4">
                <label className="w-20 text-sm font-medium text-zinc-300">Auth Token</label>
                <input 
                  type="password" 
                  placeholder="eyJh..." 
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" 
                />
              </div>
            </>
          )}

          <div className="mt-8 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
            <button type="submit" disabled={creating || !name.trim()} className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
              {creating ? 'Creating...' : 'Create Database'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
