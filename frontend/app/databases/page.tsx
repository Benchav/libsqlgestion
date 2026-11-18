"use client";

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { TokenReveal } from '../../components/TokenReveal';
import { apiRequest, apiUpload } from '../../lib/api';
import { useDatabases, useProjects, useCreateDatabase, useStorageCapabilities, DatabaseInfo, ProjectInfo } from '../../lib/hooks';
import { clearEphemeralDatabaseToken, setEphemeralDatabaseToken } from '../../lib/token-cache';
import { Database, Table2, X, Plus, Search, HardDrive, Upload, RefreshCw } from 'lucide-react';

function getDatabaseTypeLabel(database: DatabaseInfo) {
  return (database.effectiveType || database.type || 'sqlite').toUpperCase();
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default function DatabasesPage() {
  const router = useRouter();
  const { data: databases = [], isLoading, error, refetch } = useDatabases();
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const createDatabase = useCreateDatabase();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState('');
  const [generatedDatabaseName, setGeneratedDatabaseName] = useState('');
  const [generatedDatabaseId, setGeneratedDatabaseId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const filteredDatabases = databases.filter((d: DatabaseInfo) =>
    d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (d.project?.name || '').toLowerCase().includes(searchQuery.toLowerCase())
  );
  const legacyLocalDatabases = databases.filter((d: DatabaseInfo) => d.runtimeProvider === 'local-file');

  const totalPages = Math.ceil(filteredDatabases.length / pageSize);
  const paginatedDatabases = filteredDatabases.slice((page - 1) * pageSize, page * pageSize);

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Databases</h1>
            <p className="text-sm text-zinc-400 mt-1">Manage your libSQL primaries and remote database instances.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={14} />
              <input
                type="text"
                placeholder="Search databases..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                className="pl-9 pr-4 py-2 bg-[#0f0f0f] border border-zinc-800 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-zinc-600 transition-colors w-64"
              />
            </div>
            <button onClick={() => refetch()} className="text-zinc-500 hover:text-zinc-300 p-2 rounded-md transition-colors" title="Refresh">
              <RefreshCw size={16} />
            </button>
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

        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">
            Failed to load databases: {(error as Error).message}
          </div>
        )}

        {legacyLocalDatabases.length > 0 && (
          <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            <strong>{legacyLocalDatabases.length}</strong> legacy LOCAL-FILE database(s) detected.
            They cannot be used as libSQL embedded replicas. Convert them from each database page
            or run the <code className="text-amber-200">migrate:local-to-primary</code> script.
          </div>
        )}

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
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-zinc-500">
                    <div className="flex flex-col items-center gap-2">
                      <RefreshCw size={32} className="opacity-20 animate-spin" />
                      <p>Loading databases...</p>
                    </div>
                  </td>
                </tr>
              ) : paginatedDatabases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-zinc-500">
                    <div className="flex flex-col items-center gap-2">
                      <HardDrive size={32} className="opacity-20" />
                      <p>No databases found.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedDatabases.map((db: DatabaseInfo) => (
                  <tr key={db.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors group cursor-pointer" onClick={() => router.push(`/databases/${db.id}`)}>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Database className="text-blue-500" size={14} />
                        <span className="font-medium text-zinc-200">{db.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-zinc-400">{db.project?.name || '\u2014'}</td>
                    <td className="py-3 px-4">
                      <span className="bg-zinc-800 text-zinc-300 border border-zinc-700/50 px-2 py-0.5 rounded text-[11px] font-medium uppercase tracking-wider">
                        {getDatabaseTypeLabel(db)}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${
                        db.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        db.status === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                        db.status === 'provisioning' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
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

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 text-sm text-zinc-400">
            <span>Showing {Math.min((page - 1) * pageSize + 1, filteredDatabases.length)}\u2013{Math.min(page * pageSize, filteredDatabases.length)} of {filteredDatabases.length}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Previous</button>
              <span className="px-2">{page} / {totalPages}</span>
              <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
            </div>
          </div>
        )}
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
              setGeneratedDatabaseId(databaseId || '');
              if (databaseId) {
                setEphemeralDatabaseToken(databaseId, token, databaseName || 'database');
              }
            }
            refetch();
          }}
          isCreating={createDatabase.isPending}
          createError={createDatabase.error?.message}
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
              setGeneratedDatabaseId(databaseId || '');
              if (databaseId) {
                setEphemeralDatabaseToken(databaseId, token, databaseName || 'database');
              }
            }
            refetch();
          }}
        />
      )}

      {generatedToken && (
        <div className="px-6 pb-0 max-w-7xl mx-auto w-full">
          <div className="mb-6">
            <TokenReveal
              token={generatedToken}
              label={`Token for ${generatedDatabaseName}`}
              onDismiss={() => {
                clearEphemeralDatabaseToken(generatedDatabaseId);
                setGeneratedToken('');
                setGeneratedDatabaseId('');
                setGeneratedDatabaseName('');
              }}
            />
          </div>
        </div>
      )}
    </AppShell>
  );
}

function ImportDatabaseModal({ projects, onClose, onSuccess }: { projects: ProjectInfo[], onClose: () => void, onSuccess: (token: string, databaseName: string, databaseId?: string) => void }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [mode, setMode] = useState<'path' | 'file'>('file');
  const [sourcePath, setSourcePath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const { data: capabilities, isLoading: capabilitiesLoading, error: capabilitiesError } = useStorageCapabilities();
  const [storageMode, setStorageMode] = useState<'namespace' | 'runtime' | 'local'>('runtime');
  const [storageModeTouched, setStorageModeTouched] = useState(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'processing'>('idle');
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!projectId && projects[0]?.id) {
      setProjectId(projects[0].id);
    }
  }, [projectId, projects]);

  useEffect(() => {
    if (!capabilities || storageModeTouched) return;
    if (capabilities.defaultMode === 'namespace' || capabilities.defaultMode === 'runtime') {
      setStorageMode(capabilities.defaultMode);
    } else if (capabilities.local.allowed) {
      setStorageMode('local');
    }
  }, [capabilities, storageModeTouched]);

  useEffect(() => {
    if (!importing) {
      setElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [importing]);

  const publicDomain = capabilities?.publicDomain || '';
  const publicHost = subdomain.trim() && publicDomain
    ? `${subdomain.trim()}.${publicDomain}`
    : '';
  const namespaceUnavailable = !capabilities?.namespace.usable;
  const runtimeUnavailable = !capabilities?.runtime.available;
  const noPrimaryAvailable = namespaceUnavailable && runtimeUnavailable;
  const publicDomainMissing = !publicDomain || /localhost|127\.0\.0\.1/.test(publicDomain);
  const maxUploadBytes = capabilities?.maxUploadBytes || 0;
  const fileTooLarge = Boolean(file && maxUploadBytes > 0 && file.size > maxUploadBytes);
  const uploadPercent = uploadProgress && uploadProgress.total > 0
    ? Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))
    : null;

  function deriveNameFromFile(fileName: string) {
    return fileName.replace(/\.[^.]+$/, '').trim();
  }

  async function handleImport(e: FormEvent) {
    e.preventDefault();
    if (!projectId || importing) return;

    const validationError = getImportBlockReason();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setImporting(true);
    setStage(mode === 'file' ? 'uploading' : 'processing');
    setUploadProgress(mode === 'file' && file ? { loaded: 0, total: file.size } : null);

    try {
      if (mode === 'path') {
        const result = await apiRequest<{ database: { id: string; name: string }; token: string }>('/databases/import-sqlite', {
          method: 'POST',
          body: JSON.stringify({
            projectId,
            ...(name.trim() ? { name: name.trim() } : {}),
            sourcePath,
            subdomain: subdomain.trim() || undefined,
            storageMode,
          }),
        });
        onSuccess(result.token, result.database.name, result.database.id);
      } else {
        const formData = new FormData();
        formData.append('projectId', projectId);
        if (name.trim()) formData.append('name', name.trim());
        if (subdomain.trim()) formData.append('subdomain', subdomain.trim());
        formData.append('storageMode', storageMode);
        if (file) formData.append('file', file);

        const result = await apiUpload<{ database: { id: string; name: string }; token: string }>(
          '/databases/import-upload',
          formData,
          {
            onProgress: (progress) => {
              setUploadProgress(progress);
              if (progress.total > 0 && progress.loaded >= progress.total) {
                setStage('processing');
              }
            },
            onUploadComplete: () => setStage('processing'),
            timeoutMs: 30 * 60 * 1000,
          },
        );
        onSuccess(result.token, result.database.name, result.database.id);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setImporting(false);
      setStage('idle');
      setUploadProgress(null);
    }
  }

  function getImportBlockReason(): string | null {
    if (importing) return null;
    if (capabilitiesLoading) return 'Checking available libSQL primaries...';
    if (capabilitiesError) return 'Unable to read storage capabilities. Refresh the page and try again.';
    if (!capabilities) return 'Storage capabilities are still loading. Try again in a moment.';
    if (!projectId) return 'Select a project.';
    if (mode === 'path' ? !sourcePath.trim() : !file) {
      return mode === 'path' ? 'Provide a server path to the .db file.' : 'Choose a .db file to upload.';
    }
    if (fileTooLarge) {
      const maxMb = Math.round(maxUploadBytes / (1024 * 1024));
      return `This file is larger than the ${maxMb} MB upload limit. Use Server path for larger databases.`;
    }
    if (storageMode === 'namespace' && namespaceUnavailable) {
      return capabilities.namespace.reason || 'Shared namespace is not available.';
    }
    if (storageMode === 'namespace' && !subdomain.trim()) {
      return 'A fixed subdomain is required for a shared namespace.';
    }
    if (storageMode === 'runtime' && runtimeUnavailable) {
      return capabilities.runtime.reason || 'Dedicated runtime is not available.';
    }
    if (storageMode === 'local' && !capabilities.local.allowed) {
      return 'LOCAL-FILE imports are disabled by policy.';
    }
    if (storageMode !== 'local' && publicDomainMissing) {
      return 'Configure the Wildcard domain in Settings before importing a libSQL primary.';
    }
    return null;
  }

  const submitBlockReason = getImportBlockReason();

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]">
      <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl w-full max-w-[560px] p-6 shadow-2xl">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Import Database</h2>
            <p className="text-sm text-zinc-400 mt-1">Import a SQLite file from the server or upload one from your computer.</p>
          </div>
          <button onClick={onClose} disabled={importing} className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40">
            <X size={20} />
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleImport} className="space-y-4" aria-busy={importing}>
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={importing}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
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
              disabled={importing}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Subdomain</label>
            <input
              type="text"
              placeholder={storageMode === 'namespace' ? 'required, e.g. erp-db' : 'leave blank to auto-generate'}
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              disabled={importing}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          <p className="-mt-2 ml-24 text-xs text-zinc-500">
            {storageMode === 'namespace'
              ? 'Required for a shared namespace: the first DNS label must match the namespace.'
              : 'Leave this empty and the backend will generate a public subdomain automatically.'}
          </p>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2">Import as</label>
            <select
              value={storageMode}
              onChange={(e) => {
                setStorageModeTouched(true);
                setStorageMode(e.target.value as 'namespace' | 'runtime' | 'local');
              }}
              disabled={importing || capabilitiesLoading}
              className="w-full bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="namespace" disabled={namespaceUnavailable}>
                libSQL namespace — shared sqld {namespaceUnavailable ? '(unavailable)' : '(recommended)'}
              </option>
              <option value="runtime" disabled={runtimeUnavailable}>
                libSQL runtime — dedicated container {runtimeUnavailable ? '(unavailable)' : ''}
              </option>
              {capabilities?.local.allowed && (
                <option value="local">Legacy SQLite local — HTTP only, no embedded replica</option>
              )}
            </select>

            <div className="mt-2 space-y-1 text-xs">
              {capabilitiesLoading && <p className="text-zinc-500">Checking available primaries...</p>}
              {capabilitiesError && <p className="text-red-400">Unable to read storage capabilities.</p>}
              {storageMode === 'namespace' && (
                <p className={namespaceUnavailable ? 'text-amber-400' : 'text-zinc-500'}>
                  {namespaceUnavailable
                    ? capabilities?.namespace.reason || 'Shared namespace is not available.'
                    : 'Shared sqld namespace. Supports embedded replicas.'}
                </p>
              )}
              {storageMode === 'runtime' && (
                <p className={runtimeUnavailable ? 'text-amber-400' : 'text-zinc-500'}>
                  {runtimeUnavailable
                    ? capabilities?.runtime.reason || 'Dedicated runtime is not available.'
                    : 'Dedicated libsql-server container. Supports embedded replicas.'}
                </p>
              )}
              {storageMode === 'local' && (
                <p className="text-amber-400">
                  Legacy LOCAL-FILE only exposes the HTTP pipeline and cannot be used as TURSO_SYNC_URL.
                </p>
              )}
              {namespaceUnavailable && storageMode !== 'namespace' && (
                <p className="text-amber-400">
                  Shared sqld namespace unavailable: {capabilities?.namespace.reason || 'not configured.'}
                </p>
              )}
              {noPrimaryAvailable && (
                <p className="text-red-400">
                  No libSQL primary is available. Configure sqld or the Docker socket before importing.
                </p>
              )}
              {storageMode !== 'local' && publicDomainMissing && (
                <p className="text-amber-400">
                  Wildcard domain is not configured. The public URL will use localhost and will not be usable.
                </p>
              )}
              {storageMode === 'runtime' && capabilities && !capabilities.runtimeTlsConfigured && (
                <p className="text-amber-400">
                  TRAEFIK_CERT_RESOLVER is not configured. The runtime HTTPS URL may fail until TLS is configured.
                </p>
              )}
              {storageMode !== 'local' && publicHost && (
                <p className="text-zinc-500">
                  Public host: <code className="text-zinc-300">{publicHost}</code>
                </p>
              )}
              {mode === 'file' && maxUploadBytes > 0 && (
                <p className="text-zinc-500">
                  Maximum upload size: {formatFileSize(maxUploadBytes)}. Use Server path for larger databases.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 bg-[#050505] border border-zinc-800 rounded-lg p-1">
            <button type="button" onClick={() => setMode('file')} disabled={importing} className={`flex-1 px-3 py-2 text-sm rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'file' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}>
              Upload from computer
            </button>
            <button type="button" onClick={() => setMode('path')} disabled={importing} className={`flex-1 px-3 py-2 text-sm rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'path' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}>
              Server path
            </button>
          </div>

          {mode === 'file' ? (
            <div className="space-y-2">
              <div className="flex items-center gap-4">
                <label className="w-20 text-sm font-medium text-zinc-300">File</label>
                <input
                  type="file"
                  accept=".db,.db3,.sqlite,.sqlite3"
                  disabled={importing}
                  onChange={(e) => {
                    const selectedFile = e.target.files?.[0] || null;
                    setFile(selectedFile);
                    if (selectedFile && !name.trim()) {
                      setName(deriveNameFromFile(selectedFile.name));
                    }
                  }}
                  className="flex-1 text-sm text-zinc-300 file:mr-4 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-zinc-100 file:text-zinc-900 hover:file:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              {file && (
                <p className="ml-24 text-xs text-zinc-500">
                  {file.name} · {formatFileSize(file.size)}
                  {uploadPercent !== null && stage === 'uploading' ? ` · uploading ${uploadPercent}%` : ''}
                </p>
              )}
              {fileTooLarge && (
                <p className="ml-24 text-xs text-amber-400">
                  This file is larger than the upload limit. Use Server path instead.
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <label className="w-20 text-sm font-medium text-zinc-300">Path</label>
              <input
                type="text"
                placeholder="/mnt/imports/example.db"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                disabled={importing}
                className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          )}

          {importing && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400" role="status" aria-live="polite">
              <div className="flex items-start gap-2">
                <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin text-zinc-200" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p>
                    {stage === 'uploading' && file
                      ? `Uploading ${file.name} (${formatFileSize(file.size)})...`
                      : storageMode === 'namespace'
                        ? `Copying ${mode === 'file' ? file?.name || 'database' : sourcePath} into the shared namespace...`
                        : `Creating the libSQL primary${mode === 'file' && file ? ` for ${file.name}` : ''}...`}
                  </p>
                  {stage === 'uploading' && uploadPercent !== null && uploadProgress && (
                    <div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-emerald-400 transition-all duration-200"
                          style={{ width: `${uploadPercent}%` }}
                        />
                      </div>
                      <p className="mt-1 text-zinc-500">
                        {uploadPercent}% · {formatFileSize(uploadProgress.loaded)} of {formatFileSize(uploadProgress.total)}
                      </p>
                    </div>
                  )}
                  <p className="text-zinc-500">
                    {stage === 'uploading'
                      ? 'Keep this window open while the file uploads.'
                      : 'Usually a few seconds. Public route health is checked in the background.'}
                  </p>
                  <p className="text-zinc-600">Elapsed: {elapsedSeconds}s</p>
                </div>
              </div>
            </div>
          )}

          <div className="mt-8 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} disabled={importing} className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors disabled:cursor-not-allowed disabled:opacity-40">Cancel</button>
            <button
              type="submit"
              disabled={importing || Boolean(submitBlockReason)}
              className={`inline-flex items-center gap-2 bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 ${importing ? 'cursor-wait' : 'disabled:cursor-not-allowed'}`}
            >
              {importing && <RefreshCw size={14} className="animate-spin" />}
              {importing ? 'Importing...' : 'Import Database'}
            </button>
          </div>
          {!importing && submitBlockReason && (
            <p className="text-right text-xs text-amber-400">{submitBlockReason}</p>
          )}
        </form>
      </div>
    </div>
  );
}

function CreateDatabaseModal({ projects, onClose, onSuccess, isCreating, createError }: { projects: ProjectInfo[], onClose: () => void, onSuccess: (token: string, databaseName: string, databaseId?: string) => void, isCreating: boolean, createError?: string }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [primaryMode, setPrimaryMode] = useState<'namespace' | 'runtime'>('runtime');
  const [primaryTouched, setPrimaryTouched] = useState(false);
  const [legacyLocal, setLegacyLocal] = useState(false);
  const [error, setError] = useState(createError || '');
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || isCreating;
  const { data: capabilities, isLoading: capabilitiesLoading, error: capabilitiesError } = useStorageCapabilities();

  useEffect(() => {
    if (createError) setError(createError);
  }, [createError]);

  useEffect(() => {
    if (!capabilities || primaryTouched) return;
    if (capabilities.defaultMode === 'namespace' || capabilities.defaultMode === 'runtime') {
      setPrimaryMode(capabilities.defaultMode);
    }
  }, [capabilities, primaryTouched]);

  const publicDomain = capabilities?.publicDomain || '';
  const publicHost = subdomain.trim() && publicDomain
    ? `${subdomain.trim()}.${publicDomain}`
    : '';
  const namespaceUnavailable = !capabilities?.namespace.usable;
  const runtimeUnavailable = !capabilities?.runtime.available;
  const noPrimaryAvailable = namespaceUnavailable && runtimeUnavailable;
  const publicDomainMissing = !publicDomain || /localhost|127\.0\.0\.1/.test(publicDomain);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!projectId || !name.trim() || busy) return;

    if (!capabilities) {
      setError('Storage capabilities are still loading. Try again in a moment.');
      return;
    }

    let body: Record<string, unknown> = { projectId, name: name.trim() };

    if (legacyLocal) {
      if (!capabilities.local.allowed) {
        setError('LOCAL-FILE creation is disabled by policy.');
        return;
      }
      body = { ...body, type: 'sqlite' };
    } else {
      if (primaryMode === 'namespace' && namespaceUnavailable) {
        setError(capabilities.namespace.reason || 'Shared namespace is not available.');
        return;
      }
      if (primaryMode === 'runtime' && runtimeUnavailable) {
        setError(capabilities.runtime.reason || 'Dedicated runtime is not available.');
        return;
      }
      if (primaryMode === 'namespace' && !subdomain.trim()) {
        setError('A fixed subdomain is required for a shared namespace.');
        return;
      }
      body = {
        ...body,
        type: 'libsql',
        primaryMode,
        subdomain: subdomain.trim() || undefined,
      };
    }

    setError('');
    setSubmitting(true);
    try {
      const result = await apiRequest<{ database: { id: string; name: string }; token: string }>('/databases', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onSuccess(result.token, result.database.name, result.database.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-[2px]">
      <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl w-full max-w-[540px] p-6 shadow-2xl">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Create Database</h2>
            <p className="text-sm text-zinc-400 mt-1">Create a new libSQL primary database.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40">
            <X size={20} />
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleCreate} className="space-y-4" aria-busy={busy}>
          <div className="flex items-center gap-4">
            <label className="w-24 text-sm font-medium text-zinc-300">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={busy}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="" disabled>Select a project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-4">
            <label className="w-24 text-sm font-medium text-zinc-300">Name</label>
            <input
              type="text"
              placeholder="e.g. production-db"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="w-24 text-sm font-medium text-zinc-300">Subdomain</label>
            <input
              type="text"
              placeholder={primaryMode === 'namespace' ? 'required, e.g. ventas' : 'leave blank to auto-generate'}
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              disabled={busy || legacyLocal}
              className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2">Primary</label>
            <select
              value={primaryMode}
              onChange={(e) => {
                setPrimaryTouched(true);
                setPrimaryMode(e.target.value as 'namespace' | 'runtime');
              }}
              disabled={busy || legacyLocal || capabilitiesLoading}
              className="w-full bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="namespace" disabled={namespaceUnavailable}>
                Shared sqld namespace {namespaceUnavailable ? '(unavailable)' : '(recommended)'}
              </option>
              <option value="runtime" disabled={runtimeUnavailable}>
                Dedicated runtime {runtimeUnavailable ? '(unavailable)' : ''}
              </option>
            </select>

            <div className="mt-2 space-y-1 text-xs">
              {capabilitiesLoading && <p className="text-zinc-500">Checking available primaries...</p>}
              {capabilitiesError && <p className="text-red-400">Unable to read storage capabilities.</p>}
              {primaryMode === 'namespace' && (
                <p className={namespaceUnavailable ? 'text-amber-400' : 'text-zinc-500'}>
                  {namespaceUnavailable
                    ? capabilities?.namespace.reason || 'Shared namespace is not available.'
                    : 'Shared sqld namespace. Embedded replica compatible.'}
                </p>
              )}
              {primaryMode === 'runtime' && (
                <p className={runtimeUnavailable ? 'text-amber-400' : 'text-zinc-500'}>
                  {runtimeUnavailable
                    ? capabilities?.runtime.reason || 'Dedicated runtime is not available.'
                    : 'Dedicated libsql-server container. Embedded replica compatible.'}
                </p>
              )}
              {noPrimaryAvailable && (
                <p className="text-red-400">
                  No libSQL primary is available. Configure sqld or the Docker socket before creating databases.
                </p>
              )}
              {primaryMode === 'runtime' && capabilities && !capabilities.runtimeTlsConfigured && (
                <p className="text-amber-400">
                  TRAEFIK_CERT_RESOLVER is not configured. The runtime HTTPS URL may fail.
                </p>
              )}
              {!legacyLocal && publicDomainMissing && (
                <p className="text-amber-400">
                  Wildcard domain is not configured. The public URL will use localhost and will not be usable.
                </p>
              )}
              {!legacyLocal && publicHost && (
                <p className="text-zinc-500">
                  Public host: <code className="text-zinc-300">{publicHost}</code>
                </p>
              )}
            </div>
          </div>

          {capabilities?.local.allowed && (
            <details className="rounded-lg border border-zinc-800 bg-[#050505] p-3 text-xs text-zinc-400">
              <summary className="cursor-pointer text-zinc-500">Advanced</summary>
              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={legacyLocal}
                  onChange={(e) => setLegacyLocal(e.target.checked)}
                  disabled={busy}
                  className="mt-0.5"
                />
                <span>
                  Create legacy LOCAL-FILE SQLite. HTTP pipeline only, not compatible with
                  <code className="mx-1 text-zinc-300">TURSO_SYNC_URL</code>.
                </span>
              </label>
            </details>
          )}

          {busy && (
            <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400" role="status" aria-live="polite">
              <RefreshCw size={14} className="mt-0.5 shrink-0 animate-spin text-zinc-200" />
              <span>
                Creating the {legacyLocal ? 'legacy SQLite' : primaryMode} database and generating credentials...
                <span className="block text-zinc-500">This can take a moment. Keep this window open.</span>
              </span>
            </div>
          )}

          <div className="mt-8 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors disabled:cursor-not-allowed disabled:opacity-40">Cancel</button>
            <button
              type="submit"
              disabled={
                busy
                || capabilitiesLoading
                || !capabilities
                || !projectId
                || !name.trim()
                || (!legacyLocal && primaryMode === 'namespace' && (namespaceUnavailable || !subdomain.trim()))
                || (!legacyLocal && primaryMode === 'runtime' && runtimeUnavailable)
                || (!legacyLocal && publicDomainMissing)
              }
              className={`inline-flex items-center gap-2 bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 ${busy ? 'cursor-wait' : 'disabled:cursor-not-allowed'}`}
            >
              {busy && <RefreshCw size={14} className="animate-spin" />}
              {busy ? 'Creating...' : 'Create Database'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
