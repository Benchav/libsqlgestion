"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { apiRequest } from '../lib/api';
import { useAuth } from '../lib/useAuth';

const navigation = [
  { href: '/dashboard', label: 'Dashboard', icon: '◈' },
  { href: '/projects', label: 'Projects', icon: '⬡' },
  { href: '/databases', label: 'Databases', icon: '⛁' },
  { href: '/audit', label: 'Audit log', icon: '⟐' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <div className="panel" style={{ padding: 48, textAlign: 'center' }}>
          <div className="brand-badge" style={{ marginBottom: 16 }}>libsqlite</div>
          <p className="muted">Loading control plane…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-grid">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-badge">libsqlite</span>
            <h1 style={{ fontSize: '1.25rem' }}>Control Plane</h1>
            <p className="small" style={{ margin: 0 }}>Self-hosted SQLite &amp; libsql management</p>
          </div>

          <nav className="nav">
            {navigation.map((item) => (
              <Link key={item.href} href={item.href} className={pathname === item.href || pathname?.startsWith(item.href + '/') ? 'active' : ''}>
                <span style={{ marginRight: 10, opacity: 0.7 }}>{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="sidebar-footer stack">
            {user ? (
              <span className="small" style={{ wordBreak: 'break-all' }}>{user.email}</span>
            ) : null}
            <span className="badge success" style={{ width: 'fit-content' }}>● Online</span>
            <button className="button-secondary" onClick={async () => {
              await apiRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
              window.location.href = '/login';
            }}>
              Sign out
            </button>
          </div>
        </aside>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
