"use client";

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { DashboardMetrics } from '../../components/DashboardMetrics';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type DashboardData = {
  projects?: Array<{ id: string; name: string }>;
  databases?: Array<{ id: string; name: string; type: string; status: string }>;
  logs?: Array<{ id: string; action: string; createdAt: string }>;
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>({});
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [projects, databases, logs] = await Promise.all([
          apiRequest<{ projects: Array<{ id: string; name: string }> }>('/projects'),
          apiRequest<{ databases: Array<{ id: string; name: string; type: string; status: string }> }>('/databases'),
          apiRequest<{ logs: Array<{ id: string; action: string; createdAt: string }> }>('/audit'),
        ]);
        setData({ projects: projects.projects, databases: databases.databases, logs: logs.logs });
      } catch (err: any) {
        setError(err.message || 'Unable to load dashboard');
      }
    }

    load();
  }, []);

  const metrics = [
    { label: 'Projects', value: String(data.projects?.length ?? 0) },
    { label: 'Databases', value: String(data.databases?.length ?? 0) },
    { label: 'Audit events', value: String(data.logs?.length ?? 0) },
    { label: 'Status', value: error ? 'Needs login' : 'Online' },
  ];

  return (
    <AppShell>
      <section className="hero">
        <div className="hero-copy">
          <span className="brand-badge">Dashboard</span>
          <h1>Operational overview</h1>
          <p>
            Monitor projects, databases and audit activity from a single panel backed by your own infrastructure.
          </p>
        </div>
      </section>

      <DashboardMetrics metrics={metrics} />

      <ShellFrame title="Latest activity" subtitle="Recent changes recorded by the control plane.">
        {error ? <div className="badge warning">{error}</div> : null}
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {data.logs?.slice(0, 5).map((log) => (
                <tr key={log.id}>
                  <td>{log.action}</td>
                  <td className="muted">{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ShellFrame>
    </AppShell>
  );
}
