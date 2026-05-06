"use client";

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '../../../components/AppShell';
import { TokenReveal } from '../../../components/TokenReveal';
import { apiRequest } from '../../../lib/api';
import { Database, Table2, Terminal, RefreshCw, Key, ChevronRight, HardDrive, CheckCircle2, XCircle, Pencil, Trash2, X } from 'lucide-react';

type DatabaseDetail = {
  id: string;
  name: string;
  type: string;
  status: string;
  subdomain?: string;
  url?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  project?: { id: string; name: string };
};

export default function DatabaseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [database, setDatabase] = useState<DatabaseDetail | null>(null);
  const [error, setError] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [revealedToken, setRevealedToken] = useState('');
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function loadDatabase() {
    try {
      const result = await apiRequest<{ database: DatabaseDetail }>(`/databases/${id}`);
      setDatabase(result.database);
      if (typeof window !== 'undefined') {
        const storedToken = window.sessionStorage.getItem(`libsqlite.databaseToken.${id}`) || '';
        setRevealedToken(storedToken);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (id) loadDatabase();
  }, [id]);

  async function handleTestConnection() {
    setTestStatus('testing');
    try {
      const result = await apiRequest<{ ok: boolean; details: string }>(`/databases/${id}/test-connection`, { method: 'POST' });
      setTestStatus(result.ok ? 'success' : 'error');
      setTestMessage(result.details);
    } catch (err: any) {
      setTestStatus('error');
      setTestMessage(err.message);
    }
  }

  async function handleRotateToken() {
    if (!confirm('Rotate token? Active connections using the old token will be dropped.')) return;
    try {
      const result = await apiRequest<{ database: DatabaseDetail; token: string }>(`/databases/${id}/rotate-token`, { method: 'PATCH' });
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(`libsqlite.databaseToken.${id}`, result.token);
      }
      setRevealedToken(result.token);
      await loadDatabase();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDeleteDatabase() {
    if (!confirm('Delete this database? This cannot be undone.')) return;

    setIsDeleting(true);
    try {
      await apiRequest(`/databases/${id}`, { method: 'DELETE' });
      router.push('/databases');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsDeleting(false);
    }
  }

  if (!database && !error) {
    return (
      <AppShell>
        <div className="p-6 max-w-7xl mx-auto w-full animate-fadeIn">
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <div className="skeleton w-16 skeleton-text"></div>
              <div className="skeleton w-4 skeleton-text-sm"></div>
              <div className="skeleton w-24 skeleton-text"></div>
            </div>
            <div className="flex items-center gap-4">
              <div className="skeleton w-12 h-12 rounded-xl"></div>
              <div className="flex flex-col gap-2">
                <div className="skeleton w-48 h-6 rounded"></div>
                <div className="skeleton w-32 skeleton-text"></div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
                <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30">
                  <div className="skeleton w-40 skeleton-text"></div>
                </div>
                <div className="p-6 space-y-4">
                  <div className="skeleton w-full h-10 rounded-lg"></div>
                  <div className="skeleton w-full h-10 rounded-lg"></div>
                </div>
              </div>
            </div>
            <div>
              <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
                <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30">
                  <div className="skeleton w-36 skeleton-text"></div>
                </div>
                <div className="p-6 space-y-4">
                  <div className="skeleton w-full h-8 rounded"></div>
                  <div className="skeleton w-full h-8 rounded"></div>
                  <div className="skeleton w-full h-8 rounded"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center text-sm text-zinc-400 mb-4">
            <span className="cursor-pointer hover:text-zinc-200" onClick={() => router.push('/databases')}>Databases</span>
            <ChevronRight size={14} className="mx-2" />
            <span className="text-zinc-100">{database?.name}</span>
          </div>

          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center justify-center">
                <Database className="text-blue-500" size={24} />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-zinc-100 flex items-center gap-3">
                  {database?.name}
                  <span className={`px-2 py-0.5 rounded text-xs font-medium border ${
                    database?.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                    database?.status === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 
                    'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>
                    {database?.status}
                  </span>
                </h1>
                <div className="text-sm text-zinc-400 mt-1 flex items-center gap-2">
                  <span className="uppercase tracking-wider font-semibold text-[11px] bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded">
                    {database?.type}
                  </span>
                  <span>Created {new Date(database?.createdAt || '').toLocaleDateString()}</span>
                  {database?.project && (
                    <>
                      <span>·</span>
                      <span>Project: <strong className="text-zinc-300">{database.project.name}</strong></span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsEditOpen(true)}
                className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
              >
                <Pencil size={16} /> Edit Database
              </button>
              <button
                onClick={handleDeleteDatabase}
                disabled={isDeleting}
                className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-60"
              >
                <Trash2 size={16} /> {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
              <button 
                onClick={() => router.push(`/databases/${id}/studio`)}
                className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors"
              >
                <Table2 size={16} /> Open Studio
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
            {/* Connection Info */}
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Terminal size={16} className="text-zinc-400" />
                  <h2 className="font-medium text-zinc-200">Connection Details</h2>
                </div>
                <button 
                  onClick={handleTestConnection}
                  disabled={testStatus === 'testing'}
                  className="text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-md transition-colors"
                >
                  {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                </button>
              </div>

              {testStatus !== 'idle' && (
                <div className={`px-6 py-3 border-b border-zinc-800/80 flex items-center gap-2 text-sm ${testStatus === 'success' ? 'bg-emerald-500/5 text-emerald-400' : 'bg-red-500/5 text-red-400'}`}>
                  {testStatus === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                  {testMessage}
                </div>
              )}

              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Connection URL</label>
                  <div className="flex items-center border border-zinc-800 bg-[#050505] rounded-lg p-3 font-mono text-xs text-zinc-300 overflow-x-auto custom-scrollbar">
                    {database?.subdomain ? `libsql://${database.subdomain}.libsqlite.local` : database?.url || `http://localhost:3000/api/v1/databases/${id}/query`}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Auth Token</label>
                  {revealedToken ? (
                    <TokenReveal
                      token={revealedToken}
                      onDismiss={() => {
                        if (typeof window !== 'undefined') {
                          window.sessionStorage.removeItem(`libsqlite.databaseToken.${id}`);
                        }
                        setRevealedToken('');
                      }}
                    />
                  ) : (
                    <div className="flex items-center justify-between border border-zinc-800 bg-[#050505] rounded-lg p-3 font-mono text-xs text-zinc-300">
                      <span className="blur-[4px] select-none">Token is only shown once after create/import/rotate</span>
                      <button onClick={handleRotateToken} className="text-blue-400 hover:text-blue-300 font-sans flex items-center gap-1.5 ml-4">
                        <RefreshCw size={14} /> Rotate
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Quick Actions / Tips */}
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] p-6">
              <h3 className="font-medium text-zinc-200 mb-4 flex items-center gap-2">
                <Key size={16} className="text-zinc-400" /> Connecting to your database
              </h3>
              <p className="text-sm text-zinc-400 mb-4">
                Use the <code className="text-blue-400 bg-blue-400/10 px-1 rounded">@libsql/client</code> package in your application to connect securely.
              </p>
              <pre className="bg-[#050505] border border-zinc-800 p-4 rounded-lg overflow-x-auto text-xs font-mono text-zinc-300 custom-scrollbar">
{`import { createClient } from '@libsql/client';

const client = createClient({
  url: "YOUR_CONNECTION_URL",
  authToken: "YOUR_AUTH_TOKEN",
});

const rs = await client.execute("SELECT * FROM users");
console.log(rs.rows);`}
              </pre>
            </div>
          </div>

          <div className="space-y-6">
            {/* Storage / Meta info */}
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center gap-2">
                <HardDrive size={16} className="text-zinc-400" />
                <h2 className="font-medium text-zinc-200">Storage Information</h2>
              </div>
              <div className="p-6 space-y-4">
                <div className="flex justify-between items-center border-b border-zinc-800/50 pb-3">
                  <span className="text-sm text-zinc-500">Storage Used</span>
                  <span className="text-sm font-medium text-zinc-200">— (Not calculated)</span>
                </div>
                <div className="flex justify-between items-center border-b border-zinc-800/50 pb-3">
                  <span className="text-sm text-zinc-500">Read / Write Ratio</span>
                  <span className="text-sm font-medium text-zinc-200">—</span>
                </div>
                <div className="flex justify-between items-center border-b border-zinc-800/50 pb-3">
                  <span className="text-sm text-zinc-500">Database ID</span>
                  <span className="text-xs font-mono text-zinc-400">{database?.id}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isEditOpen && database && (
        <EditDatabaseModal
          database={database}
          onClose={() => setIsEditOpen(false)}
          onSaved={async () => {
            setIsEditOpen(false);
            await loadDatabase();
          }}
        />
      )}
    </AppShell>
  );
}

function EditDatabaseModal({
  database,
  onClose,
  onSaved,
}: {
  database: DatabaseDetail;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(database.name);
  const [status, setStatus] = useState(database.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;

    setError('');
    setSaving(true);
    try {
      await apiRequest(`/databases/${database.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), status }),
      });
      await onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] modal-backdrop">
      <div className="w-full max-w-[520px] rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-6 shadow-2xl modal-content">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Edit Database</h2>
            <p className="mt-1 text-sm text-zinc-400">Update the database name or status.</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300">
            <X size={20} />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-4">
            <label className="w-20 text-sm font-medium text-zinc-300">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="flex-1 rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
              <option value="error">error</option>
            </select>
          </div>

          <div className="mt-8 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
