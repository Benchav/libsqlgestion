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
      <div className="app-shell-loading">
        <div className="panel" style={{ width: 'min(420px, 100%)', textAlign: 'center' }}>
          <div className="brand-badge" style={{ marginBottom: 14 }}>libsqlite</div>
          <p className="muted" style={{ margin: 0 }}>Loading control plane…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-grid">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="sidebar-brand-mark">libsqlite</span>
            <div style={{ minWidth: 0 }}>
              <h1 className="sidebar-brand-title">Control Plane</h1>
              <p className="sidebar-brand-subtitle small" style={{ margin: '4px 0 0' }}>Self-hosted SQLite &amp; libsql management</p>
            </div>
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

        <div className="main-shell">
          <header className="topbar">
            <div className="topbar-left">
              <button type="button" className="icon-button" aria-label="Toggle sidebar">☰</button>
              <div className="topbar-breadcrumbs">
                <span className="breadcrumb-link">Databases</span>
                <span className="topbar-separator">/</span>
                <span className="breadcrumb-current">Workspace</span>
              </div>
            </div>

            <div className="topbar-actions">
              <span className="topbar-chip hidden sm:inline-flex">aA</span>
              <button type="button" className="icon-button" aria-label="Search">⌕</button>
              <button type="button" className="icon-button" aria-label="Activity">◌</button>
              <button type="button" className="icon-button" aria-label="Settings">⚙</button>
              <span className="topbar-avatar">{user?.email?.[0]?.toUpperCase() || 'U'}</span>
            </div>
          </header>

          <main className="content">{children}</main>
        </div>
      </div>
    </div>
  );
}
