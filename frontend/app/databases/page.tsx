"use client";

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { TokenReveal } from '../../components/TokenReveal';
import { apiRequest } from '../../lib/api';
import { Database, Table2, X, Plus, Search, HardDrive, Upload } from 'lucide-react';

type DatabaseInfo = { id: string; name: string; type: string; status: string; subdomain?: string; createdAt: string; project?: { id: string; name: string } };
type Project = { id: string; name: string };

export default function DatabasesPage() {
  const router = useRouter();
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState('');
  const [generatedDatabaseName, setGeneratedDatabaseName] = useState('');

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
              onClick={() => setIsImportModalOpen(true)}
              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors border border-zinc-700"
            >
              <Upload size={16} /> Import Database
            </button>
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
          onSuccess={(token, databaseName, databaseId) => {
            setIsCreateModalOpen(false);
            if (token) {
              setGeneratedToken(token);
              setGeneratedDatabaseName(databaseName || 'database');
              if (typeof window !== 'undefined' && databaseId) {
                window.sessionStorage.setItem(`libsqlite.databaseToken.${databaseId}`, token);
              }
            }
            loadDatabases();
          }}
        />
      )}

      {isImportModalOpen && (
        <ImportDatabaseModal
          projects={projects}
          onClose={() => setIsImportModalOpen(false)}
          onSuccess={(token, databaseName, databaseId) => {
            setIsImportModalOpen(false);
            if (token) {
              setGeneratedToken(token);
              setGeneratedDatabaseName(databaseName || 'database');
              if (typeof window !== 'undefined' && databaseId) {
                window.sessionStorage.setItem(`libsqlite.databaseToken.${databaseId}`, token);
              }
            }
            loadDatabases();
          }}
        />
      )}

      {generatedToken && (
        <div className="px-6 pb-0 max-w-7xl mx-auto w-full">
          <div className="mb-6">
            <TokenReveal token={generatedToken} label={`Token for ${generatedDatabaseName}`} />
          </div>
        </div>
      )}
    </AppShell>
  );
}

function ImportDatabaseModal({ projects, onClose, onSuccess }: { projects: Project[], onClose: () => void, onSuccess: (token: string, databaseName: string, databaseId?: string) => void }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [mode, setMode] = useState<'path' | 'file'>('file');
  const [sourcePath, setSourcePath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  function deriveNameFromFile(fileName: string) {
    return fileName.replace(/\.[^.]+$/, '').trim();
  }

  async function handleImport(e: FormEvent) {
    e.preventDefault();
    if (!projectId) return;

    if (mode === 'path' && !sourcePath.trim()) {
      setError('Provide a server path to the .db file.');
      return;
    }

    if (mode === 'file' && !file) {
      setError('Choose a .db file to upload.');
      return;
    }

    setError('');
    setImporting(true);

    try {
      if (mode === 'path') {
        const result = await apiRequest<{ database: { id: string; name: string }; token: string }>('/databases/import-sqlite', {
          method: 'POST',
          body: JSON.stringify({
            projectId,
            ...(name.trim() ? { name: name.trim() } : {}),
            sourcePath,
            subdomain: subdomain || undefined,
          }),
        });
        onSuccess(result.token, result.database.name, result.database.id);
      } else {
        const formData = new FormData();
        formData.append('projectId', projectId);
        if (name.trim()) formData.append('name', name.trim());
        if (subdomain.trim()) formData.append('subdomain', subdomain.trim());
        if (file) formData.append('file', file);

        const result = await apiRequest<{ database: { id: string; name: string }; token: string }>('/databases/import-upload', {
          method: 'POST',
          body: formData,
        });
        onSuccess(result.token, result.database.name, result.database.id);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]">
      <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl w-full max-w-[560px] p-6 shadow-2xl">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Import Database</h2>
            <p className="text-sm text-zinc-400 mt-1">Import a SQLite file from the server or upload one from your computer.</p>
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

        <form onSubmit={handleImport} className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
            >
              <option value="" disabled>Select a project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Name</label>
            <input
              type="text"
              placeholder="e.g. legacy-db"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
            />
          </div>

          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Subdomain</label>
            <input
              type="text"
              placeholder="optional"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
            />
          </div>

          <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded-lg p-1">
            <button type="button" onClick={() => setMode('file')} className={`flex-1 px-3 py-2 text-sm rounded-md transition-colors ${mode === 'file' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}>
              Upload from computer
            </button>
            <button type="button" onClick={() => setMode('path')} className={`flex-1 px-3 py-2 text-sm rounded-md transition-colors ${mode === 'path' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}>
              Server path
            </button>
          </div>

          {mode === 'file' ? (
            <div className="flex items-center gap-4">
              <label className="w-20 text-sm font-medium text-zinc-300">File</label>
              <input
                type="file"
                accept=".db,.sqlite,.sqlite3"
                onChange={(e) => {
                  const selectedFile = e.target.files?.[0] || null;
                  setFile(selectedFile);
                  if (selectedFile && !name.trim()) {
                    setName(deriveNameFromFile(selectedFile.name));
                  }
                }}
                className="flex-1 text-sm text-zinc-300 file:mr-4 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-zinc-100 file:text-zinc-900 hover:file:bg-white"
              />
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <label className="w-20 text-sm font-medium text-zinc-300">Path</label>
              <input
                type="text"
                placeholder="/mnt/imports/example.db"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
              />
            </div>
          )}

          <div className="mt-8 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
            <button type="submit" disabled={importing || !projectId || (mode === 'path' ? !sourcePath.trim() : !file)} className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
              {importing ? 'Importing...' : 'Import Database'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateDatabaseModal({ projects, onClose, onSuccess }: { projects: Project[], onClose: () => void, onSuccess: (token: string, databaseName: string, databaseId?: string) => void }) {
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
      const result = await apiRequest<{ database: { id: string; name: string }; token: string }>('/databases', {
        method: 'POST',
        body: JSON.stringify({ projectId, name, type }),
      });
      onSuccess(result.token, result.database.name, result.database.id);
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
