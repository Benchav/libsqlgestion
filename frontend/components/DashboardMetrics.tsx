export function DashboardMetrics({ metrics }: { metrics: Array<{ label: string; value: string; tone?: string }> }) {
  return (
    <div className="cards">
      {metrics.map((metric) => (
        <div key={metric.label} className="card">
          <div className="card-label">{metric.label}</div>
          <div className="card-value">{metric.value}</div>
          {metric.tone ? <div className={`badge ${metric.tone}`}>{metric.tone}</div> : null}
        </div>
      ))}
    </div>
  );
}
