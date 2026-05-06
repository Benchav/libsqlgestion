"use client";

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { apiRequest } from '../../lib/api';
import { Activity, Plus, Search, FolderClosed, X, Settings2, Trash2 } from 'lucide-react';

type Project = {
  id: string;
  name: string;
  createdAt: string;
  owner?: { email: string };
  databases?: Array<{ id: string }>;
};

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  async function loadProjects() {
    try {
      const result = await apiRequest<{ projects: Project[] }>('/projects');
      setProjects(result.projects);
    } catch (err: any) {
      console.error(err.message);
    }
  }

  useEffect(() => { loadProjects(); }, []);

  async function handleDelete(id: string, projectName: string) {
    if (!confirm(`Delete project "${projectName}"? This will also remove all its databases.`)) return;
    try {
      await apiRequest(`/projects/${id}`, { method: 'DELETE' });
      await loadProjects();
    } catch (err: any) {
      alert(err.message);
    }
  }

  const filteredProjects = projects.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Projects</h1>
            <p className="text-sm text-zinc-400 mt-1">Organize your databases into logical groups or environments.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
              <input 
                type="text" 
                placeholder="Search projects..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 bg-[#0f0f0f] border border-zinc-800 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-zinc-600 transition-colors w-64"
              />
            </div>
            <button 
              onClick={() => setIsCreateModalOpen(true)}
              className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors"
            >
              <Plus size={16} /> Create Project
            </button>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="border border-zinc-800/80 rounded-lg bg-[#0f0f0f] p-12 text-center flex flex-col items-center justify-center">
             <div className="w-12 h-12 bg-zinc-800/50 rounded-full flex items-center justify-center mb-4">
                <FolderClosed className="text-zinc-500" size={24} />
             </div>
             <h3 className="text-zinc-200 font-medium mb-1">No projects yet</h3>
             <p className="text-zinc-500 text-sm mb-6 max-w-md">Create your first project to start organizing your SQLite and libsql databases securely.</p>
             <button 
              onClick={() => setIsCreateModalOpen(true)}
              className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors"
            >
              <Plus size={16} /> Create Project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredProjects.map((project) => (
              <div key={project.id} className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] p-5 hover:border-zinc-700 transition-colors group relative flex flex-col h-full">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center text-zinc-300">
                      <Activity size={20} />
                    </div>
                    <div>
                      <h3 
                        onClick={() => router.push(`/projects/${project.id}`)}
                        className="text-zinc-100 font-medium cursor-pointer hover:underline"
                      >
                        {project.name}
                      </h3>
                      <div className="text-xs text-zinc-500 mt-0.5">Created {new Date(project.createdAt).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <button 
                    onClick={() => handleDelete(project.id, project.name)}
                    className="text-zinc-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 p-1 bg-zinc-800/50 hover:bg-red-500/10 rounded-md"
                    title="Delete Project"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                
                <div className="mt-auto pt-4 border-t border-zinc-800/50 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-xs text-zinc-500 uppercase font-semibold tracking-wider">Databases</span>
                    <span className="text-zinc-200 font-medium">{project.databases?.length || 0}</span>
                  </div>
                  <button 
                    onClick={() => router.push(`/projects/${project.id}`)}
                    className="flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800 px-3 py-1.5 rounded-md transition-colors"
                  >
                    <Settings2 size={14} /> Manage
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isCreateModalOpen && (
        <CreateProjectModal 
          onClose={() => setIsCreateModalOpen(false)} 
          onSuccess={() => {
            setIsCreateModalOpen(false);
            loadProjects();
          }}
        />
      )}
    </AppShell>
  );
}

function CreateProjectModal({ onClose, onSuccess }: { onClose: () => void, onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setLoading(true);
    try {
      await apiRequest('/projects', { method: 'POST', body: JSON.stringify({ name }) });
      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-[2px] modal-backdrop">
      <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl w-full max-w-[480px] p-6 shadow-2xl modal-content">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">New Project</h2>
            <p className="text-sm text-zinc-400 mt-1">Create a group to organize related databases.</p>
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
            <label className="w-16 text-sm font-medium text-zinc-300">Name</label>
            <input 
              type="text" 
              placeholder="e.g. production-api" 
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600" 
            />
          </div>
          <div className="mt-8 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
            <button type="submit" disabled={loading || !name.trim()} className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
              {loading ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
