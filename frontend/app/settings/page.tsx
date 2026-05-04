export default function SettingsPage() {
  return (
    <div className="app-shell">
      <section className="panel section">
        <div>
          <h2 className="section-title">Settings</h2>
          <p className="muted">This panel is ready for environment and system settings once the frontend is fully connected.</p>
        </div>
        <div className="card">
          <p className="small">
            Recommended env vars: `NEXT_PUBLIC_API_URL`, `SQLITE_STORAGE_ROOT`, `MASTER_KEY`, `CORS_ORIGIN`.
          </p>
        </div>
      </section>
    </div>
  );
}
