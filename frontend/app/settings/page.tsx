"use client";

import React, { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { OffsiteBackupCard } from '../../components/settings/OffsiteBackupCard';
import { apiRequest } from '../../lib/api';
import { User, Shield, Terminal, Globe, Plus, CheckCircle2, XCircle, Pencil, KeyRound, Mail, UserPlus, X, RefreshCw } from 'lucide-react';

type UserInfo = {
  id?: string;
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
  roles?: string[];
};

type PublicDatabaseSettings = {
  domain: string;
  protocol: string;
  baseUrl: string;
  template: string;
  host: string;
};

const DEFAULT_PUBLIC_DATABASE_SETTINGS: PublicDatabaseSettings = {
  domain: '',
  protocol: 'https',
  baseUrl: '',
  template: '',
  host: '',
};

export default function SettingsPage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [publicDatabaseSettings, setPublicDatabaseSettings] = useState<PublicDatabaseSettings>(DEFAULT_PUBLIC_DATABASE_SETTINGS);
  const [loadingPublicDatabaseSettings, setLoadingPublicDatabaseSettings] = useState(true);
  const [savingPublicDatabaseSettings, setSavingPublicDatabaseSettings] = useState(false);
  const [dnsCheck, setDnsCheck] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; message: string }>({ status: 'idle', message: '' });
  const [error, setError] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountMessage, setAccountMessage] = useState('');
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserRecord | null>(null);

  const canManageUsers = Boolean(user?.permissions?.includes('users.write'));
  const canReadUsers = Boolean(user?.permissions?.includes('users.read'));
  const isSuperadmin = Boolean(user?.roles?.includes('superadmin'));

  async function loadUsers() {
    try {
      const result = await apiRequest<{ users: UserRecord[] }>('/users');
      setUsers(result.users);
    } catch {
      // The section stays hidden when the user lacks users.read.
    }
  }

  useEffect(() => {
    apiRequest<{ user: UserInfo }>('/me')
      .then((r) => setUser(r.user))
      .catch(() => {});

    apiRequest<{ settings: PublicDatabaseSettings }>('/settings/public-database')
      .then((r) => setPublicDatabaseSettings({ ...DEFAULT_PUBLIC_DATABASE_SETTINGS, ...r.settings }))
      .catch((err: any) => setError(err.message))
      .finally(() => setLoadingPublicDatabaseSettings(false));

    fetch('/api/v1/health', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setHealth(data))
      .catch(() => setHealth({ ok: false }));

  }, []);

  useEffect(() => {
    if (canReadUsers) void loadUsers();
  }, [canReadUsers]);

  async function handleAssignRole(userId: string, roleName: string) {
    try {
      await apiRequest(`/users/${userId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleName }),
      });
      setAccountMessage('Role updated.');
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleAccountSaved(message: string, email?: string) {
    if (email) {
      setUser((current) => current ? { ...current, email } : current);
    }
    setAccountOpen(false);
    setAccountMessage(message);
  }

  async function handleUserCreated() {
    setAddUserOpen(false);
    setAccountMessage('User created.');
    await loadUsers();
  }

  async function handleUserUpdated() {
    setEditUser(null);
    setAccountMessage('User updated.');
    await loadUsers();
  }

  async function handleSavePublicDatabaseSettings() {
    try {
      setSavingPublicDatabaseSettings(true);
      setError('');
      const result = await apiRequest<{ settings: PublicDatabaseSettings }>('/settings/public-database', {
        method: 'PUT',
        body: JSON.stringify({
          domain: publicDatabaseSettings.domain,
          protocol: publicDatabaseSettings.protocol,
          template: publicDatabaseSettings.template,
          baseUrl: publicDatabaseSettings.baseUrl,
          host: publicDatabaseSettings.host,
        }),
      });
      setPublicDatabaseSettings({ ...DEFAULT_PUBLIC_DATABASE_SETTINGS, ...result.settings });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingPublicDatabaseSettings(false);
    }
  }

  async function handleCheckPublicDns() {
    const domain = publicDatabaseSettings.domain.trim();
    if (!domain) {
      setDnsCheck({ status: 'error', message: 'Enter the database wildcard domain first.' });
      return;
    }

    setDnsCheck({ status: 'loading', message: 'Checking public DNS...' });
    try {
      const result = await apiRequest<{
        ok: boolean;
        record: string;
        addresses?: string[];
        message?: string;
        warning?: string;
        error?: string;
      }>(`/settings/public-database/dns-check?domain=${encodeURIComponent(domain)}`);

      if (result.ok) {
        setDnsCheck({
          status: 'ok',
          message: `${result.message || `${result.record} resolves.`}${result.warning ? ` ${result.warning}` : ''}`,
        });
      } else {
        setDnsCheck({
          status: 'error',
          message: result.error || `No wildcard DNS record found for ${result.record}.`,
        });
      }
    } catch (err: any) {
      setDnsCheck({ status: 'error', message: err.message });
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

        {accountMessage && (
          <div className="mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 px-4 py-3 rounded-lg text-sm">
            {accountMessage}
          </div>
        )}

        <div className="space-y-6">
          {/* Public Database Routing */}
          <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center gap-2">
              <Globe size={16} className="text-zinc-400" />
              <h2 className="font-medium text-zinc-200">Public Database Routing</h2>
            </div>
            <div className="p-6 space-y-5">
              <p className="text-sm text-zinc-400">
                Add only the dedicated database domain, for example `db.example.com`. The panel will auto-generate subdomains for each database and build public URLs using the protocol you choose here.
              </p>

              {loadingPublicDatabaseSettings ? (
                <div className="text-sm text-zinc-500">Loading routing settings...</div>
              ) : (
                <div className="grid grid-cols-1 gap-4">
                  <div className="flex items-center gap-4">
                    <label className="w-40 text-sm font-medium text-zinc-300">Wildcard domain</label>
                    <input
                      type="text"
                      placeholder="db.example.com"
                      value={publicDatabaseSettings.domain}
                      onChange={(e) => {
                        setPublicDatabaseSettings((current) => ({ ...current, domain: e.target.value }));
                        setDnsCheck({ status: 'idle', message: '' });
                      }}
                      className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
                    />
                  </div>
                  <p className="-mt-2 ml-44 text-xs text-zinc-500">
                    Required for libSQL runtime/namespace URLs. The Base URL below is only used by LOCAL-FILE databases.
                    {publicDatabaseSettings.domain.trim()
                      ? ` The DNS record must cover *.${publicDatabaseSettings.domain.trim()}. A wildcard on a parent domain does not cover this subdomain.`
                      : ''}
                  </p>

                  <div className="flex items-center gap-4">
                    <label className="w-40 text-sm font-medium text-zinc-300">Protocol</label>
                    <select
                      value={publicDatabaseSettings.protocol}
                      onChange={(e) => setPublicDatabaseSettings((current) => ({ ...current, protocol: e.target.value }))}
                      className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
                    >
                      <option value="https">https</option>
                      <option value="http">http (development only)</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="w-40 text-sm font-medium text-zinc-300">Base URL</label>
                    <input
                      type="url"
                      placeholder="https://libsql.example.com"
                      value={publicDatabaseSettings.baseUrl}
                      onChange={(e) => setPublicDatabaseSettings((current) => ({ ...current, baseUrl: e.target.value }))}
                      className="flex-1 bg-[#050505] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"
                    />
                  </div>
                  <p className="-mt-2 ml-44 text-xs text-zinc-500">
                    For LOCAL-FILE databases, this is the public base URL of the backend. It generates
                    {' '}
                    <code>{publicDatabaseSettings.baseUrl || 'https://your-domain'}/api/v1/databases/&lt;id&gt;/</code>.
                  </p>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                    <p className="text-xs text-zinc-500">
                      Save only the dedicated database domain. Example: `db.example.com` becomes a URL like `${publicDatabaseSettings.protocol}://subdomain.db.example.com`.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCheckPublicDns}
                        disabled={dnsCheck.status === 'loading' || savingPublicDatabaseSettings}
                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                      >
                        {dnsCheck.status === 'loading' ? 'Checking DNS...' : 'Test wildcard DNS'}
                      </button>
                      <button
                        type="button"
                        onClick={handleSavePublicDatabaseSettings}
                        disabled={savingPublicDatabaseSettings}
                        className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
                      >
                        {savingPublicDatabaseSettings ? 'Saving...' : 'Save routing'}
                      </button>
                    </div>
                  </div>
                  {dnsCheck.status !== 'idle' && (
                    <div
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        dnsCheck.status === 'ok'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : dnsCheck.status === 'error'
                            ? 'border-red-500/30 bg-red-500/10 text-red-300'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                      }`}
                    >
                      {dnsCheck.message}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {user?.permissions?.includes('settings.read') && (
            <OffsiteBackupCard canWrite={Boolean(user?.permissions?.includes('settings.write'))} />
          )}

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
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <User size={16} className="text-zinc-400" />
                  <h2 className="font-medium text-zinc-200">Your Account</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setAccountOpen(true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
                >
                  <Pencil size={14} /> Edit account
                </button>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                  <p className="text-sm text-zinc-500 mb-1">Email Address</p>
                  <p className="font-medium text-zinc-200">{user.email}</p>
                </div>
                <div>
                  <p className="text-sm text-zinc-500 mb-1">Account ID</p>
                  <p className="font-mono text-xs text-zinc-500">{user.id || user.sub}</p>
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
          {canReadUsers && (
            <div className="border border-zinc-800/80 rounded-xl bg-[#0f0f0f] overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Shield size={16} className="text-zinc-400" />
                  <h2 className="font-medium text-zinc-200">User Management</h2>
                </div>
                {canManageUsers && (
                  <button
                    type="button"
                    onClick={() => setAddUserOpen(true)}
                    className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-white"
                  >
                    <UserPlus size={14} /> Add user
                  </button>
                )}
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
                            {u.roles?.length ? u.roles.map((role) => (
                              <span key={role} className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-300 rounded text-xs">{role}</span>
                            )) : <span className="text-zinc-500">—</span>}
                          </div>
                        </td>
                        <td className="py-3 px-6 text-zinc-500 text-xs">{new Date(u.createdAt).toLocaleDateString()}</td>
                        <td className="py-3 px-6">
                          <div className="flex items-center justify-end gap-2">
                            {canManageUsers
                              && u.id !== user?.sub
                              && (isSuperadmin || !u.roles?.includes('superadmin'))
                              && (
                                <button
                                  type="button"
                                  onClick={() => setEditUser(u)}
                                  className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                                  title="Edit user"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                            {canManageUsers && (isSuperadmin || !u.roles?.includes('superadmin')) ? (
                              <select
                                className="bg-[#050505] border border-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-600"
                                defaultValue=""
                                onChange={(e) => {
                                  if (e.target.value) handleAssignRole(u.id, e.target.value);
                                  e.target.value = '';
                                }}
                              >
                                <option value="" disabled>+ Assign role</option>
                                {isSuperadmin && <option value="superadmin">superadmin</option>}
                                {isSuperadmin && <option value="admin">admin</option>}
                                <option value="operator">operator</option>
                                <option value="readonly">readonly</option>
                              </select>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </div>
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
                    ['DATABASE_PUBLIC_DOMAIN', 'Wildcard parent domain for public database subdomains'],
                    ['DATABASE_PUBLIC_BASE_URL', 'Path-based public URL fallback'],
                    ['DATABASE_PUBLIC_URL_TEMPLATE', 'Custom URL template for public database links'],
                    ['DATABASE_PUBLIC_HOST', 'Host used when publishing managed libSQL runtimes'],
                    ['DATABASE_PUBLIC_PROTOCOL', 'Protocol used for public database URLs'],
                    ['LIBSQL_REQUIRE_PRIMARY', 'Require new databases/imports to be libSQL primaries'],
                    ['LIBSQL_ALLOW_LOCAL_FILE', 'Allow legacy LOCAL-FILE creation (escape hatch)'],
                    ['LIBSQL_PRIMARY_MODE', 'Default primary selection: auto, namespace or runtime'],
                    ['LIBSQL_NAMESPACE_PUBLIC_ENABLED', 'Enable publicly routable shared namespaces'],
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

      {accountOpen && user && (
        <AccountSettingsModal
          user={user}
          onClose={() => setAccountOpen(false)}
          onSaved={handleAccountSaved}
        />
      )}

      {addUserOpen && (
        <AddUserModal
          isSuperadmin={isSuperadmin}
          onClose={() => setAddUserOpen(false)}
          onCreated={handleUserCreated}
        />
      )}

      {editUser && (
        <EditUserModal
          target={editUser}
          isSelf={editUser.id === (user?.id || user?.sub)}
          onClose={() => setEditUser(null)}
          onUpdated={handleUserUpdated}
        />
      )}
    </AppShell>
  );
}

function ModalShell({ title, description, onClose, children, busy = false }: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
      <div className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-xl border border-zinc-800/80 bg-[#0f0f0f] p-6 shadow-2xl custom-scrollbar">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">{title}</h2>
            {description && <p className="mt-1 text-sm text-zinc-400">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AccountSettingsModal({ user, onClose, onSaved }: {
  user: UserInfo;
  onClose: () => void;
  onSaved: (message: string, email?: string) => void;
}) {
  const [tab, setTab] = useState<'email' | 'password'>('email');
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleEmail(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const result = await apiRequest<{ user: { email: string } }>('/me/email', {
        method: 'PATCH',
        body: JSON.stringify({ email: email.trim(), currentPassword }),
      });
      onSaved('Email updated successfully.', result.user.email);
    } catch (err: any) {
      setError(err.message || 'Failed to change email');
    } finally {
      setSaving(false);
    }
  }

  async function handlePassword(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }

    setSaving(true);
    try {
      await apiRequest('/me/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      onSaved('Password updated. Other sessions were signed out.');
    } catch (err: any) {
      setError(err.message || 'Failed to change password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title="Edit account"
      description="Change your login email or password. Your current password is required."
      onClose={onClose}
      busy={saving}
    >
      <div className="mb-5 flex gap-2 rounded-lg border border-zinc-800 bg-[#050505] p-1">
        <button
          type="button"
          onClick={() => { setTab('email'); setError(''); }}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${tab === 'email' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          <Mail size={14} className="mr-1.5 inline" /> Email
        </button>
        <button
          type="button"
          onClick={() => { setTab('password'); setError(''); }}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${tab === 'password' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          <KeyRound size={14} className="mr-1.5 inline" /> Password
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {tab === 'email' ? (
        <form onSubmit={handleEmail} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-300">New email address</label>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={saving}
              autoComplete="email"
              className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-300">Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={saving}
              autoComplete="current-password"
              className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
            />
          </div>
          <div className="flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40">Cancel</button>
            <button type="submit" disabled={saving || !email.trim() || !currentPassword} className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-50">
              {saving && <RefreshCw size={14} className="animate-spin" />}
              {saving ? 'Saving...' : 'Save email'}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handlePassword} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-300">Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={saving}
              autoComplete="current-password"
              className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-300">New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={saving}
              autoComplete="new-password"
              className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-300">Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={saving}
              autoComplete="new-password"
              className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
            />
          </div>
          <p className="text-xs text-zinc-500">
            Changing your password signs out all other active sessions. This session stays signed in.
          </p>
          <div className="flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
            <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40">Cancel</button>
            <button type="submit" disabled={saving || !currentPassword || !newPassword || !confirmPassword} className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-50">
              {saving && <RefreshCw size={14} className="animate-spin" />}
              {saving ? 'Saving...' : 'Save password'}
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}

function AddUserModal({ isSuperadmin, onClose, onCreated }: {
  isSuperadmin: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleName, setRoleName] = useState('readonly');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const roles = isSuperadmin
    ? ['superadmin', 'admin', 'operator', 'readonly']
    : ['operator', 'readonly'];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await apiRequest('/users', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password, roleName }),
      });
      onCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create user');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Add user" description="Create another login with its own email and password." onClose={onClose} busy={saving}>
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-300">Email</label>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={saving} autoComplete="email" className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60" />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-300">Password</label>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={saving} autoComplete="new-password" className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60" />
          <p className="mt-1 text-xs text-zinc-500">Minimum 8 characters.</p>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-300">Role</label>
          <select value={roleName} onChange={(event) => setRoleName(event.target.value)} disabled={saving} className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60">
            {roles.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={saving || !email.trim() || password.length < 8} className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-50">
            {saving && <RefreshCw size={14} className="animate-spin" />}
            {saving ? 'Creating...' : 'Create user'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function EditUserModal({ target, isSelf, onClose, onUpdated }: {
  target: UserRecord;
  isSelf: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [email, setEmail] = useState(target.email);
  const [active, setActive] = useState(target.active);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await apiRequest(`/users/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          email: email.trim(),
          active,
          ...(password ? { password } : {}),
        }),
      });
      onUpdated();
    } catch (err: any) {
      setError(err.message || 'Failed to update user');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Edit user" description="Update the account email, status, or reset its password." onClose={onClose} busy={saving}>
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-300">Email</label>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={saving} className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60" />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-300">New password</label>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={saving} autoComplete="new-password" placeholder="Leave blank to keep current password" className="w-full rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60" />
          <p className="mt-1 text-xs text-zinc-500">Resetting a password signs out that user&apos;s active sessions.</p>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#050505] px-3 py-2">
          <span className="text-sm text-zinc-300">Active</span>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            disabled={saving || isSelf}
            className="h-4 w-4 accent-zinc-100 disabled:opacity-40"
          />
        </label>
        <div className="flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={saving || !email.trim() || (password.length > 0 && password.length < 8)} className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-50">
            {saving && <RefreshCw size={14} className="animate-spin" />}
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
