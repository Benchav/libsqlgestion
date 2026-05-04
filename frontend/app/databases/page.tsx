"use client";

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type Database = { id: string; name: string; type: string; status: string; subdomain?: string; createdAt: string; project?: { id: string; name: string } };
type Project = { id: string; name: string };

export default function DatabasesPage() {
  const router = useRouter();
  const [databases, setDatabases] = useState<Database[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  // Create form
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'sqlite' | 'libsql' | 'remote'>('sqlite');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  // Import form
  const [importProjectId, setImportProjectId] = useState('');
  const [importName, setImportName] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [showImport, setShowImport] = useState(false);

  // Filter
  const [filterProject, setFilterProject] = useState('');

  async function loadDatabases() {
    const result = await apiRequest<{ databases: Database[] }>('/databases');
    setDatabases(result.databases);
  }

  async function loadProjects() {
    const result = await apiRequest<{ projects: Project[] }>('/projects');
    setProjects(result.projects);
  }

  useEffect(() => {
    Promise.all([loadDatabases(), loadProjects()]).catch((err: any) => setError(err.message));
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !name.trim()) return;
    setError('');
    setCreating(true);
    try {
      await apiRequest('/databases', {
        method: 'POST',
        body: JSON.stringify({ projectId, name, type, url: url || undefined, token: token || undefined }),
      });
      setName('');
      setUrl('');
      setToken('');
      await loadDatabases();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleImport(event: FormEvent) {
    event.preventDefault();
    if (!importProjectId || !importName.trim() || !sourcePath.trim()) return;
    setError('');
    try {
      await apiRequest('/databases/import-sqlite', {
        method: 'POST',
        body: JSON.stringify({ projectId: importProjectId, name: importName, sourcePath }),
      });
      setImportName('');
      setSourcePath('');
      setShowImport(false);
      await loadDatabases();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDelete(id: string, dbName: string) {
    if (!confirm(`Delete database "${dbName}"? This action cannot be undone.`)) return;
    try {
      await apiRequest(`/databases/${id}`, { method: 'DELETE' });
      await loadDatabases();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const filteredDatabases = filterProject
    ? databases.filter((d) => d.project?.id === filterProject)
    : databases;

  return (
    <AppShell>
      <ShellFrame
        title="Databases"
        subtitle="Provision, import and manage SQLite and libsql databases across all projects."
        actions={
          <button className="button-secondary" onClick={() => setShowImport(!showImport)}>
            {showImport ? 'Hide import' : 'Import SQLite file'}
          </button>
        }
      >
        {/* Create form */}
        <form className="stack" onSubmit={handleCreate} style={{ padding: 0 }}>
          <div className="toolbar">
            <select id="db-project-select" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input id="db-name-input" className="input" placeholder="Database name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            <select className="input" value={type} onChange={(e) => setType(e.target.value as any)} style={{ width: 130 }}>
              <option value="sqlite">SQLite</option>
              <option value="libsql">libsql</option>
              <option value="remote">Remote</option>
            </select>
          </div>
          {type !== 'sqlite' && (
            <div className="toolbar">
              <input className="input" placeholder="Remote URL" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
              <input className="input" placeholder="Auth token" type="password" value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1 }} />
            </div>
          )}
          <button id="create-db-btn" className="button" type="submit" disabled={creating || !projectId || !name.trim()} style={{ width: 'fit-content' }}>
            {creating ? 'Creating…' : '+ Create database'}
          </button>
        </form>

        {/* Import form */}
        {showImport && (
          <form className="card stack" style={{ padding: 16 }} onSubmit={handleImport}>
            <h3 className="section-title" style={{ fontSize: '0.95rem' }}>Import existing SQLite file</h3>
            <div className="toolbar">
              <select className="input" value={importProjectId} onChange={(e) => setImportProjectId(e.target.value)} style={{ minWidth: 180 }}>
                <option value="">Select project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <input className="input" placeholder="Database name" value={importName} onChange={(e) => setImportName(e.target.value)} style={{ flex: 1 }} />
            </div>
            <div className="toolbar">
              <input className="input" placeholder="Absolute path to .db file on server" value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} style={{ flex: 1 }} />
              <button className="button" type="submit" disabled={!importProjectId || !importName.trim() || !sourcePath.trim()}>Import</button>
            </div>
          </form>
        )}

        {error ? <div className="badge danger" style={{ padding: '8px 14px' }}>{error}</div> : null}

        {/* Filter */}
        {databases.length > 0 && (
          <div className="toolbar">
            <select className="input" value={filterProject} onChange={(e) => setFilterProject(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">All projects ({databases.length})</option>
              {projects.map((p) => {
                const count = databases.filter((d) => d.project?.id === p.id).length;
                return <option key={p.id} value={p.id}>{p.name} ({count})</option>;
              })}
            </select>
            <span className="small muted">{filteredDatabases.length} database{filteredDatabases.length !== 1 ? 's' : ''}</span>
          </div>
        )}

        {/* Table */}
        {filteredDatabases.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">No databases yet. Select a project and create one above.</p>
          </div>
        ) : (
          <div className="card">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Project</th><th>Type</th><th>Status</th><th>Subdomain</th><th></th></tr>
              </thead>
              <tbody>
                {filteredDatabases.map((database) => (
                  <tr key={database.id}>
                    <td>
                      <button
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', font: 'inherit', fontWeight: 600, padding: 0 }}
                        onClick={() => router.push(`/databases/${database.id}`)}
                      >
                        {database.name}
                      </button>
                    </td>
                    <td className="muted">{database.project?.name || '—'}</td>
                    <td><span className="badge">{database.type}</span></td>
                    <td><span className={`badge ${database.status === 'active' ? 'success' : database.status === 'error' ? 'danger' : 'warning'}`}>{database.status}</span></td>
                    <td className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{database.subdomain || '—'}</td>
                    <td>
                      <button
                        className="button-secondary"
                        style={{ color: 'var(--danger)', fontSize: 12, padding: '6px 10px' }}
                        onClick={() => handleDelete(database.id, database.name)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ShellFrame>
    </AppShell>
  );
}
