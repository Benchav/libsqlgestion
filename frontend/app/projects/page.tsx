"use client";

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type Project = {
  id: string;
  name: string;
  createdAt: string;
  owner?: { email: string };
  databases?: Array<{ id: string }>;
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadProjects() {
    try {
      const result = await apiRequest<{ projects: Project[] }>('/projects');
      setProjects(result.projects);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => { loadProjects(); }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setError('');
    setLoading(true);
    try {
      await apiRequest('/projects', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      await loadProjects();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string, projectName: string) {
    const event = undefined;
    if (!confirm(`Delete project "${projectName}"? This will also remove all its databases.`)) return;
    try {
      await apiRequest(`/projects/${id}`, { method: 'DELETE' });
      await loadProjects();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <AppShell>
      <ShellFrame
        title="Projects"
        subtitle="Organize databases by project. Each project can contain multiple SQLite or libsql databases."
        actions={
          <Link className="button" href="/databases">View all databases →</Link>
        }
      >
        <form className="toolbar" onSubmit={handleSubmit}>
          <input
            id="project-name-input"
            className="input"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button id="create-project-btn" className="button" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : '+ Create project'}
          </button>
        </form>

        {error ? <div className="badge danger" style={{ padding: '8px 14px' }}>{error}</div> : null}

        {projects.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">No projects yet. Create one to start managing databases.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {projects.map((project) => (
              <div key={project.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                    <Link href={`/projects/${project.id}`} style={{ fontWeight: 600, fontSize: '1.05rem' }}>
                      {project.name}
                    </Link>
                    <span className="badge">{project.databases?.length || 0} db{(project.databases?.length || 0) !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="small muted">
                    {project.owner?.email ? `Owner: ${project.owner.email} · ` : ''}
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </div>
                  <div className="small muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 4, opacity: 0.6 }}>
                    {project.id}
                  </div>
                </div>
                <div className="toolbar" style={{ flexShrink: 0 }}>
                  <Link className="button-secondary" href={`/projects/${project.id}`}>View</Link>
                  <button type="button" className="button-secondary" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(project.id, project.name)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </ShellFrame>
    </AppShell>
  );
}
