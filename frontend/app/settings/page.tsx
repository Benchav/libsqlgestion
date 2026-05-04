"use client";

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';
import { apiRequest } from '../../lib/api';

type UserInfo = {
  sub: string;
  email: string;
  roles?: string[];
  permissions?: string[];
};

type HealthInfo = {
  ok: boolean;
  service?: string;
  timestamp?: string;
};

type UserRecord = {
  id: string;
  email: string;
  active: boolean;
  createdAt: string;
  roles?: Array<{ role: { name: string } }>;
};

export default function SettingsPage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest<{ user: UserInfo }>('/me')
      .then((r) => setUser(r.user))
      .catch(() => {});

    fetch('/api/v1/health', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setHealth(data))
      .catch(() => setHealth({ ok: false }));

    apiRequest<{ users: UserRecord[] }>('/users')
      .then((r) => setUsers(r.users))
      .catch(() => {}); // Silently fail if no permission
  }, []);

  async function handleAssignRole(userId: string, roleName: string) {
    try {
      await apiRequest(`/users/${userId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleName }),
      });
      // Reload users
      const r = await apiRequest<{ users: UserRecord[] }>('/users');
      setUsers(r.users);
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <AppShell>
      <section className="hero">
        <div className="hero-top">
        <div className="hero-copy">
          <span className="brand-badge">Settings</span>
          <h1>Platform settings</h1>
          <p>System health, current session info and user management.</p>
        </div>
        </div>
      </section>

      {error ? <div className="badge danger" style={{ padding: '10px 16px' }}>{error}</div> : null}

      {/* System status */}
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="card">
          <div className="card-label">Backend</div>
          <div className="card-value" style={{ fontSize: '1.4rem' }}>
            {health ? (
              <span className={`badge ${health.ok ? 'success' : 'danger'}`}>{health.ok ? '● Online' : '● Offline'}</span>
            ) : '…'}
          </div>
          {health?.timestamp && <p className="small muted" style={{ marginTop: 8 }}>{new Date(health.timestamp).toLocaleString()}</p>}
        </div>
        <div className="card">
          <div className="card-label">Service</div>
          <div className="card-value" style={{ fontSize: '1.4rem' }}>{health?.service || '—'}</div>
        </div>
        <div className="card">
          <div className="card-label">API URL</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 8, wordBreak: 'break-all', color: 'var(--muted)' }}>
            /api/v1
          </div>
        </div>
      </div>

      {/* Current session */}
      {user && (
        <ShellFrame title="Current session" subtitle="Details about the currently authenticated user.">
          <div className="card">
            <table className="table">
              <tbody>
                <tr><td style={{ fontWeight: 600 }}>Email</td><td>{user.email}</td></tr>
                <tr><td style={{ fontWeight: 600 }}>User ID</td><td className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{user.sub}</td></tr>
                <tr><td style={{ fontWeight: 600 }}>Roles</td><td>{user.roles?.map((r) => <span key={r} className="badge" style={{ marginRight: 6 }}>{r}</span>) || '—'}</td></tr>
                <tr><td style={{ fontWeight: 600 }}>Permissions</td><td>{user.permissions?.map((p) => <span key={p} className="badge success" style={{ marginRight: 6, marginBottom: 4, display: 'inline-block' }}>{p}</span>) || '—'}</td></tr>
              </tbody>
            </table>
          </div>
        </ShellFrame>
      )}

      {/* Users management */}
      {users.length > 0 && (
        <ShellFrame title="Users" subtitle="Registered platform users and their roles.">
          <div className="card">
            <table className="table">
              <thead>
                <tr><th>Email</th><th>Status</th><th>Roles</th><th>Created</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td><span className={`badge ${u.active ? 'success' : 'danger'}`}>{u.active ? 'Active' : 'Inactive'}</span></td>
                    <td>
                      {u.roles?.map((r) => (
                        <span key={r.role.name} className="badge" style={{ marginRight: 4 }}>{r.role.name}</span>
                      )) || '—'}
                    </td>
                    <td className="muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td>
                      <select
                        className="input"
                        style={{ fontSize: 12, padding: '4px 8px' }}
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) handleAssignRole(u.id, e.target.value);
                          e.target.value = '';
                        }}
                      >
                        <option value="">+ Assign role</option>
                        <option value="superadmin">superadmin</option>
                        <option value="admin">admin</option>
                        <option value="operator">operator</option>
                        <option value="readonly">readonly</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ShellFrame>
      )}

      {/* Environment reference */}
      <ShellFrame title="Environment variables" subtitle="Reference for backend configuration.">
        <div className="card" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <table className="table">
            <thead><tr><th>Variable</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>MASTER_KEY</td><td className="muted">64-char hex key for AES-256-GCM encryption</td></tr>
              <tr><td>DATABASE_FILE</td><td className="muted">Path to the control plane SQLite database</td></tr>
              <tr><td>PORT</td><td className="muted">Backend port (default: 5000)</td></tr>
              <tr><td>CORS_ORIGIN</td><td className="muted">Allowed origins (comma-separated)</td></tr>
              <tr><td>SQLITE_STORAGE_ROOT</td><td className="muted">Root path for managed database files</td></tr>
              <tr><td>SQLITE_DISCOVERY_PATH</td><td className="muted">Path to scan for .db files</td></tr>
              <tr><td>SQLITE_DISCOVERY_PROJECT_ID</td><td className="muted">Project ID for discovered databases</td></tr>
              <tr><td>SQLITE_DISCOVERY_ADOPT</td><td className="muted">Copy discovered files into managed storage</td></tr>
              <tr><td>INTERNAL_API_URL</td><td className="muted">Optional backend URL used by the server-side proxy</td></tr>
            </tbody>
          </table>
        </div>
      </ShellFrame>
    </AppShell>
  );
}
