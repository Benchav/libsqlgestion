"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '../../components/AppShell';
import { DashboardMetrics } from '../../components/DashboardMetrics';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type DashboardData = {
  projects?: Array<{ id: string; name: string; createdAt: string }>;
  databases?: Array<{ id: string; name: string; type: string; status: string; createdAt: string }>;
  logs?: Array<{ id: string; action: string; createdAt: string; resourceType?: string; resourceId?: string }>;
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>({});
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [projects, databases, logs] = await Promise.all([
          apiRequest<{ projects: DashboardData['projects'] }>('/projects'),
          apiRequest<{ databases: DashboardData['databases'] }>('/databases'),
          apiRequest<{ logs: DashboardData['logs'] }>('/audit'),
        ]);
        setData({ projects: projects.projects, databases: databases.databases, logs: logs.logs });
      } catch (err: any) {
        setError(err.message || 'Unable to load dashboard');
      }
    }

    load();
  }, []);

  const activeDbs = data.databases?.filter((d) => d.status === 'active').length ?? 0;
  const metrics = [
    { label: 'Projects', value: String(data.projects?.length ?? 0) },
    { label: 'Databases', value: String(data.databases?.length ?? 0) },
    { label: 'Active', value: String(activeDbs), tone: 'success' },
    { label: 'Audit events', value: String(data.logs?.length ?? 0) },
  ];

  return (
    <AppShell>
      <section className="hero">
        <div className="hero-top">
          <div className="hero-copy">
            <span className="brand-badge">Dashboard</span>
            <h1>Operational overview</h1>
            <p>
              Monitor projects, databases and audit activity from a single panel backed by your own infrastructure.
            </p>
            <div className="hero-actions" style={{ marginTop: 12 }}>
              <Link className="button" href="/projects">+ New project</Link>
              <Link className="button-secondary" href="/databases">Manage databases</Link>
            </div>
          </div>
        </div>
      </section>

      <DashboardMetrics metrics={metrics} />

      {error ? <div className="badge warning" style={{ padding: '10px 16px' }}>{error}</div> : null}

      {/* Recent databases */}
      <ShellFrame title="Recent databases" subtitle="Latest databases registered in the platform.">
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {(data.databases || []).slice(0, 5).map((db) => (
                <tr key={db.id} style={{ cursor: 'pointer' }} onClick={() => window.location.href = `/databases/${db.id}`}>
                  <td><strong>{db.name}</strong></td>
                  <td><span className="badge">{db.type}</span></td>
                  <td><span className={`badge ${db.status === 'active' ? 'success' : 'warning'}`}>{db.status}</span></td>
                  <td className="muted">{new Date(db.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {!data.databases?.length && (
                <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>No databases yet. Create a project first, then add databases.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </ShellFrame>

      {/* Latest activity */}
      <ShellFrame title="Latest activity" subtitle="Recent changes recorded by the control plane.">
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>Action</th><th>Resource</th><th>Time</th></tr>
            </thead>
            <tbody>
              {(data.logs || []).slice(0, 8).map((log) => (
                <tr key={log.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{log.action}</td>
                  <td className="muted">{log.resourceType ? `${log.resourceType}` : '—'}</td>
                  <td className="muted">{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {!data.logs?.length && (
                <tr><td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 24 }}>No audit events yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </ShellFrame>
    </AppShell>
  );
}
