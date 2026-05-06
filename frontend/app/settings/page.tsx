"use client";

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { apiRequest } from '../../lib/api';
import { User, Shield, Terminal, Globe, Plus, CheckCircle2, XCircle } from 'lucide-react';

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
      .catch(() => {});
  }, []);

  async function handleAssignRole(userId: string, roleName: string) {
    try {
      await apiRequest(`/users/${userId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleName }),
      });
      const r = await apiRequest<{ users: UserRecord[] }>('/users');
      setUsers(r.users);
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <AppShell>
      <div className="p-6 max-w-5xl mx-auto w-full">
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
          <p className="text-sm text-zinc-400 mt-1">Manage your platform configuration, users, and security.</p>
        </div>

        {error && (
          <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {/* System Health */}
          <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center gap-2">
              <Globe size={16} className="text-zinc-400" />
              <h2 className="font-medium text-zinc-200">System Status</h2>
            </div>
            <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <p className="text-sm text-zinc-500 mb-1">Backend Service</p>
                <div className="flex items-center gap-2">
                  {health ? (
                    health.ok ? <CheckCircle2 size={16} className="text-emerald-500" /> : <XCircle size={16} className="text-red-500" />
                  ) : <span className="w-4 h-4 rounded-full border-2 border-zinc-600 border-t-zinc-400 animate-spin"></span>}
                  <span className={`font-medium ${health?.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {health ? (health.ok ? 'Online' : 'Offline') : 'Checking...'}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-sm text-zinc-500 mb-1">Service Name</p>
                <p className="font-medium text-zinc-200">{health?.service || '—'}</p>
              </div>
              <div>
                <p className="text-sm text-zinc-500 mb-1">API Endpoint</p>
                <p className="font-mono text-xs text-zinc-400 mt-1 bg-zinc-900 px-2 py-1 rounded inline-block">/api/v1</p>
              </div>
            </div>
          </div>

          {/* Current User */}
          {user && (
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center gap-2">
                <User size={16} className="text-zinc-400" />
                <h2 className="font-medium text-zinc-200">Your Account</h2>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                  <p className="text-sm text-zinc-500 mb-1">Email Address</p>
                  <p className="font-medium text-zinc-200">{user.email}</p>
                </div>
                <div>
                  <p className="text-sm text-zinc-500 mb-1">Account ID</p>
                  <p className="font-mono text-xs text-zinc-500">{user.sub}</p>
                </div>
                <div className="md:col-span-2">
                  <p className="text-sm text-zinc-500 mb-2">Roles & Permissions</p>
                  <div className="flex flex-wrap gap-2">
                    {user.roles?.map(r => (
                      <span key={r} className="px-2 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded text-xs font-medium uppercase tracking-wider">{r}</span>
                    ))}
                    {user.permissions?.map(p => (
                      <span key={p} className="px-2 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded text-xs font-medium">{p}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* User Management */}
          {users.length > 0 && (
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center gap-2">
                <Shield size={16} className="text-zinc-400" />
                <h2 className="font-medium text-zinc-200">User Management</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800/80 text-zinc-400 text-xs font-medium">
                      <th className="py-3 px-6">User</th>
                      <th className="py-3 px-6">Status</th>
                      <th className="py-3 px-6">Roles</th>
                      <th className="py-3 px-6">Joined</th>
                      <th className="py-3 px-6 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors">
                        <td className="py-3 px-6 text-zinc-200 text-sm font-medium">{u.email}</td>
                        <td className="py-3 px-6">
                          <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${u.active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                            {u.active ? 'ACTIVE' : 'INACTIVE'}
                          </span>
                        </td>
                        <td className="py-3 px-6">
                          <div className="flex gap-1 flex-wrap">
                            {u.roles?.map(r => (
                              <span key={r.role.name} className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-300 rounded text-xs">{r.role.name}</span>
                            )) || <span className="text-zinc-500">—</span>}
                          </div>
                        </td>
                        <td className="py-3 px-6 text-zinc-500 text-xs">{new Date(u.createdAt).toLocaleDateString()}</td>
                        <td className="py-3 px-6 text-right">
                          <select
                            className="bg-[#050505] border border-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-600"
                            defaultValue=""
                            onChange={(e) => {
                              if (e.target.value) handleAssignRole(u.id, e.target.value);
                              e.target.value = '';
                            }}
                          >
                            <option value="" disabled>+ Assign role</option>
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
            </div>
          )}

          {/* Environment Variables Reference */}
          <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center gap-2">
              <Terminal size={16} className="text-zinc-400" />
              <h2 className="font-medium text-zinc-200">Environment Reference</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800/80 text-zinc-400 text-xs font-medium">
                    <th className="py-3 px-6">Variable</th>
                    <th className="py-3 px-6">Description</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {[
                    ['MASTER_KEY', '64-char hex key for AES-256-GCM encryption'],
                    ['DATABASE_FILE', 'Path to the control plane SQLite database'],
                    ['PORT', 'Backend API port (default: 5000)'],
                    ['CORS_ORIGIN', 'Allowed frontend origins'],
                    ['SQLITE_STORAGE_ROOT', 'Root path for managed database files'],
                    ['SQLITE_DISCOVERY_PATH', 'Directory to scan for unmanaged .db files'],
                    ['SQLITE_DISCOVERY_ADOPT', 'Automatically copy discovered files into managed storage'],
                  ].map(([key, desc]) => (
                    <tr key={key} className="border-b border-zinc-800/40 hover:bg-zinc-800/20">
                      <td className="py-2.5 px-6 font-mono text-xs text-blue-400">{key}</td>
                      <td className="py-2.5 px-6 text-zinc-400 text-xs">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
