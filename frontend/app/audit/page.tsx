"use client";

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type AuditLog = { id: string; action: string; createdAt: string };

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest<{ logs: AuditLog[] }>('/audit')
      .then((result) => setLogs(result.logs))
      .catch((err: any) => setError(err.message));
  }, []);

  return (
    <AppShell>
      <ShellFrame title="Audit log" subtitle="Track operational actions across the platform.">
        {error ? <div className="badge danger">{error}</div> : null}
        <div className="card">
          <table className="table">
            <thead><tr><th>Action</th><th>Time</th></tr></thead>
            <tbody>
              {logs.map((log) => (
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
