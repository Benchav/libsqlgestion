export function ShellFrame({ title, subtitle, actions, children }: { title: string; subtitle: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel section">
      <div className="section-header">
        <div>
          <h2 className="section-title">{title}</h2>
          <p className="muted">{subtitle}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
