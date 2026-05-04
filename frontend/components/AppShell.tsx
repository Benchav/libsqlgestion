"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clearSession } from '../lib/api';

const navigation = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/projects', label: 'Projects' },
  { href: '/databases', label: 'Databases' },
  { href: '/audit', label: 'Audit' },
  { href: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <div className="app-grid">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-badge">libsqlite</span>
            <h1>Control Plane</h1>
            <p>Self-hosted management for SQLite and libsql.</p>
          </div>

          <nav className="nav">
            {navigation.map((item) => (
              <Link key={item.href} href={item.href} className={pathname === item.href ? 'active' : ''}>
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="sidebar-footer stack">
            <span>Docker + Coolify ready</span>
            <button className="button-secondary" onClick={() => {
              clearSession();
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
