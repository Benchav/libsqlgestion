"use client";

import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="app-shell">
      <section className="hero">
        <div className="hero-top">
          <div className="hero-copy">
            <span className="brand-badge">libsqlite</span>
            <h1>Self-hosted control plane for SQLite and libsql.</h1>
            <p>
              Manage local SQLite files, import existing databases, discover mounted <code>.db</code> files and
              operate libsql endpoints from a single panel on your own infrastructure.
            </p>
            <div className="hero-actions">
              <Link className="button" href="/login">Open the admin panel</Link>
              <Link className="button-secondary" href="/login">Get started →</Link>
            </div>
          </div>
          <div className="card" style={{ maxWidth: 380 }}>
            <div className="card-label">Platform features</div>
            <ul className="small" style={{ lineHeight: 2, margin: '12px 0 0', paddingLeft: 18 }}>
              <li>Projects, roles and permissions (RBAC)</li>
              <li>SQLite provisioning and import</li>
              <li>Discovery and adoption of mounted <code>.db</code> files</li>
              <li>libsql remote management</li>
              <li>Schema browser, query editor and migrations</li>
              <li>Full audit trail</li>
              <li>Docker and Coolify deployment</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
