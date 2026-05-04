"use client";

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type Database = { id: string; name: string; type: string; status: string; subdomain?: string };

export default function DatabasesPage() {
  const [databases, setDatabases] = useState<Database[]>([]);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'sqlite' | 'libsql' | 'remote'>('sqlite');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [error, setError] = useState('');

  async function loadDatabases() {
    const result = await apiRequest<{ databases: Database[] }>('/databases');
    setDatabases(result.databases);
  }

  useEffect(() => { loadDatabases().catch((err: any) => setError(err.message)); }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError('');
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
    }
  }

  async function handleImport(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await apiRequest('/databases/import-sqlite', {
        method: 'POST',
        body: JSON.stringify({ projectId, name, sourcePath }),
      });
      setName('');
      setSourcePath('');
      await loadDatabases();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <AppShell>
      <ShellFrame title="Databases" subtitle="Provision, import and register SQLite or libsql databases.">
        <form className="stack" onSubmit={handleCreate}>
          <div className="toolbar">
            <input className="input" placeholder="Project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
            <input className="input" placeholder="Database name" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="input" value={type} onChange={(e) => setType(e.target.value as any)}>
              <option value="sqlite">sqlite</option>
              <option value="libsql">libsql</option>
              <option value="remote">remote</option>
            </select>
          </div>
          <div className="toolbar">
            <input className="input" placeholder="Remote URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input className="input" placeholder="Token (optional)" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="button" type="submit">Create database</button>
          </div>
        </form>

        <form className="toolbar" onSubmit={handleImport}>
          <input className="input" placeholder="Source path for import" value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} />
          <button className="button-secondary" type="submit">Import SQLite</button>
        </form>

        {error ? <div className="badge danger">{error}</div> : null}

        <div className="card">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Status</th><th>Subdomain</th></tr>
            </thead>
            <tbody>
              {databases.map((database) => (
                <tr key={database.id}>
                  <td>{database.name}</td>
                  <td>{database.type}</td>
                  <td><span className={`badge ${database.status === 'active' ? 'success' : 'warning'}`}>{database.status}</span></td>
                  <td className="muted">{database.subdomain || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ShellFrame>
    </AppShell>
  );
}
