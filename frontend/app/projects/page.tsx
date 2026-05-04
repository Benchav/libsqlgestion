"use client";

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type Project = { id: string; name: string };

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

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
    setError('');
    try {
      await apiRequest('/projects', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      await loadProjects();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <AppShell>
      <ShellFrame title="Projects" subtitle="Create and organize database ownership by project.">
        <form className="toolbar" onSubmit={handleSubmit}>
          <input className="input" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="button" type="submit">Create project</button>
        </form>
        {error ? <div className="badge danger">{error}</div> : null}
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>ID</th></tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>{project.name}</td>
                  <td className="muted">{project.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ShellFrame>
    </AppShell>
  );
}
