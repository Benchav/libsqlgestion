import Link from 'next/link';
import { AppShell } from '../../components/AppShell';
import { ShellFrame } from '../../components/ShellFrame';

export default function DashboardPage() {
  return (
    <AppShell>
      <section className="hero">
        <div className="hero-copy">
          <span className="brand-badge">Dashboard</span>
          <h1>Control plane overview</h1>
          <p>Quick access to projects, databases, audit logs and system settings.</p>
        </div>
      </section>

      <ShellFrame title="Shortcuts" subtitle="Navigate the admin panel.">
        <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Link className="card" href="/projects">Projects</Link>
          <Link className="card" href="/databases">Databases</Link>
          <Link className="card" href="/settings">Settings</Link>
        </div>
      </ShellFrame>
    </AppShell>
  );
}
