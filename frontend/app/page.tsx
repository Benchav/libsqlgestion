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
              Manage local SQLite files, import existing databases, discover mounted `.db` files and
              operate libsql endpoints from a single panel.
            </p>
            <div className="hero-actions">
              <Link className="button" href="/login">Open the admin panel</Link>
              <Link className="button-secondary" href="/dashboard">View dashboard</Link>
            </div>
          </div>
          <div className="card" style={{ maxWidth: 380 }}>
            <div className="card-label">Included</div>
            <ul className="small" style={{ lineHeight: 1.9 }}>
              <li>Projects, roles and permissions</li>
              <li>SQLite provisioning and import</li>
              <li>Discovery and adoption of mounted `.db` files</li>
              <li>libsql remote management</li>
              <li>Schema browser, queries and migrations</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
