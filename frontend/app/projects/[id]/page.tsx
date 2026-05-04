"use client";

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '../../../components/AppShell';
import { ShellFrame } from '../../../components/ShellFrame';
import { apiRequest } from '../../../lib/api';

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

  // Create database form
  const [dbName, setDbName] = useState('');
  const [dbType, setDbType] = useState<'sqlite' | 'libsql' | 'remote'>('sqlite');
  const [dbUrl, setDbUrl] = useState('');
  const [dbToken, setDbToken] = useState('');
  const [creating, setCreating] = useState(false);

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
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCreateDatabase(e: React.FormEvent) {
    e.preventDefault();
    if (!dbName.trim()) return;
    setCreating(true);
    setError('');
    try {
      await apiRequest('/databases', {
        method: 'POST',
        body: JSON.stringify({
          projectId: id,
          name: dbName,
          type: dbType,
          url: dbUrl || undefined,
          token: dbToken || undefined,
        }),
      });
      setDbName('');
      setDbUrl('');
      setDbToken('');
      await loadProject();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  if (!project && !error) {
    return (
      <AppShell>
        <ShellFrame title="Loading…" subtitle="Fetching project details.">
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">Loading project…</p>
          </div>
        </ShellFrame>
      </AppShell>
    );
  }

  return (
    <AppShell>
      {/* Header */}
      <section className="hero">
        <div className="hero-top">
          <div className="hero-copy">
            <span className="brand-badge">Project</span>
            <h1>{project?.name || 'Project'}</h1>
            <p>
              Owner: <strong>{project?.owner?.email || '—'}</strong> ·
              Created {project?.createdAt ? new Date(project.createdAt).toLocaleDateString() : '—'} ·
              {project?.members?.length || 0} member{(project?.members?.length || 0) !== 1 ? 's' : ''}
            </p>
            <div className="hero-actions" style={{ marginTop: 12 }}>
              <button className="button-secondary" onClick={() => router.push('/projects')}>← All projects</button>
            </div>
          </div>
          <div className="card" style={{ minWidth: 140, textAlign: 'center' }}>
            <div className="card-label">Databases</div>
            <div className="card-value">{project?.databases?.length || 0}</div>
          </div>
        </div>
      </section>

      {error ? <div className="badge danger" style={{ padding: '10px 16px' }}>{error}</div> : null}

      {/* Create database */}
      <ShellFrame title="Add database" subtitle="Provision a new SQLite file or register a remote libsql endpoint.">
        <form className="stack" onSubmit={handleCreateDatabase}>
          <div className="toolbar">
            <input className="input" placeholder="Database name" value={dbName} onChange={(e) => setDbName(e.target.value)} style={{ flex: 1 }} />
            <select className="input" value={dbType} onChange={(e) => setDbType(e.target.value as any)} style={{ width: 140 }}>
              <option value="sqlite">SQLite</option>
              <option value="libsql">libsql</option>
              <option value="remote">Remote</option>
            </select>
          </div>
          {dbType !== 'sqlite' && (
            <div className="toolbar">
              <input className="input" placeholder="URL" value={dbUrl} onChange={(e) => setDbUrl(e.target.value)} style={{ flex: 1 }} />
              <input className="input" placeholder="Auth token" type="password" value={dbToken} onChange={(e) => setDbToken(e.target.value)} style={{ flex: 1 }} />
            </div>
          )}
          <button className="button" type="submit" disabled={creating || !dbName.trim()} style={{ width: 'fit-content' }}>
            {creating ? 'Creating…' : `+ Create ${dbType} database`}
          </button>
        </form>
      </ShellFrame>

      {/* Databases list */}
      <ShellFrame title="Databases" subtitle={`${project?.databases?.length || 0} databases in this project.`}>
        {!project?.databases?.length ? (
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <p className="muted">No databases in this project yet. Create one above.</p>
          </div>
        ) : (
          <div className="card">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Type</th><th>Status</th><th>Subdomain</th><th>Created</th></tr>
              </thead>
              <tbody>
                {project.databases.map((db) => (
                  <tr key={db.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/databases/${db.id}`)}>
                    <td><strong>{db.name}</strong></td>
                    <td><span className="badge">{db.type}</span></td>
                    <td><span className={`badge ${db.status === 'active' ? 'success' : 'warning'}`}>{db.status}</span></td>
                    <td className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{db.subdomain || '—'}</td>
                    <td className="muted">{new Date(db.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ShellFrame>

      {/* Members */}
      {project?.members && project.members.length > 0 && (
        <ShellFrame title="Members" subtitle="Users who have access to this project.">
          <div className="card">
            <table className="table">
              <thead><tr><th>Email</th><th>ID</th></tr></thead>
              <tbody>
                {project.members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.user?.email || '—'}</td>
                    <td className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{m.user?.id || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ShellFrame>
      )}
    </AppShell>
  );
}
