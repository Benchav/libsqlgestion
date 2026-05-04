"use client";

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type AuditLog = {
  id: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  createdAt: string;
  actor?: { id: string; email: string } | null;
  metadata?: Record<string, unknown>;
};

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ logs: AuditLog[] }>('/audit')
      .then((result) => setLogs(result.logs))
      .catch((err: any) => setError(err.message));
  }, []);

  const filteredLogs = filter
    ? logs.filter((log) =>
        log.action.toLowerCase().includes(filter.toLowerCase()) ||
        (log.resourceType || '').toLowerCase().includes(filter.toLowerCase()) ||
        (log.actor?.email || '').toLowerCase().includes(filter.toLowerCase())
      )
    : logs;

  return (
    <AppShell>
      <ShellFrame title="Audit log" subtitle={`${logs.length} events recorded. Track all operational actions across the platform.`}>
        <div className="toolbar">
          <input
            className="input"
            placeholder="Filter by action, resource or actor…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: 1 }}
          />
          <span className="small muted">{filteredLogs.length} result{filteredLogs.length !== 1 ? 's' : ''}</span>
        </div>

        {error ? <div className="badge danger" style={{ padding: '8px 14px' }}>{error}</div> : null}

        {filteredLogs.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">{logs.length === 0 ? 'No audit events yet.' : 'No events match the current filter.'}</p>
          </div>
        ) : (
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Actor</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <>
                    <tr
                      key={log.id}
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{log.action}</td>
                      <td>
                        {log.resourceType ? (
                          <span className="badge">{log.resourceType}</span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="muted">{log.actor?.email || '—'}</td>
                      <td className="muted">{new Date(log.createdAt).toLocaleString()}</td>
                    </tr>
                    {expandedId === log.id && (
                      <tr key={`${log.id}-detail`}>
                        <td colSpan={4} style={{ background: '#0b0b0b', padding: 16 }}>
                          <div className="small" style={{ display: 'grid', gap: 6 }}>
                            <div><strong>Event ID:</strong> <span className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{log.id}</span></div>
                            {log.resourceId && (
                              <div><strong>Resource ID:</strong> <span className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{log.resourceId}</span></div>
                            )}
                            {log.ipAddress && (
                              <div><strong>IP:</strong> <span className="muted">{log.ipAddress}</span></div>
                            )}
                            {log.metadata && Object.keys(log.metadata).length > 0 && (
                              <div>
                                <strong>Metadata:</strong>
                                <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
                                  {JSON.stringify(log.metadata, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ShellFrame>
    </AppShell>
  );
}
