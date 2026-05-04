"use client";

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '../../../components/AppShell';
import { ShellFrame } from '../../../components/ShellFrame';
import { apiRequest } from '../../../lib/api';
import '../../../components/studio/studio.css';

type DatabaseDetail = {
  id: string;
  name: string;
  type: string;
  status: string;
  subdomain?: string;
  url?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  project?: { id: string; name: string };
};

type TableSchema = {
  table: string;
  columns: Array<{ cid: number; name: string; type: string; notnull: number; pk: number }>;
  foreignKeys: Array<Record<string, unknown>>;
};

type MigrationRecord = {
  id: string;
  name: string;
  status: string;
  appliedAt: string;
  errorMessage?: string;
};

type QueryResult = {
  ok: boolean;
  rows?: unknown[];
  result?: { changes: number; lastID: number };
  rowsAffected?: number;
  error?: string;
};

type ConnectionTestResult = {
  ok: boolean;
  details: string;
};

export default function DatabaseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [database, setDatabase] = useState<DatabaseDetail | null>(null);
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [migrations, setMigrations] = useState<MigrationRecord[]>([]);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'schema' | 'query' | 'migrations'>('schema');
  const [expandedTable, setExpandedTable] = useState<string | null>(null);

  // Query editor state
  const [sql, setSql] = useState('');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  // Migration state
  const [migrationName, setMigrationName] = useState('');
  const [migrationSql, setMigrationSql] = useState('');
  const [migrationLoading, setMigrationLoading] = useState(false);

  // Connection test state
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  async function loadDatabase() {
    try {
      const result = await apiRequest<{ database: DatabaseDetail }>(`/databases/${id}`);
      setDatabase(result.database);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadSchema() {
    try {
      const result = await apiRequest<{ tables: TableSchema[] }>(`/databases/${id}/schema`);
      setSchema(result.tables || []);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadMigrations() {
    try {
      const result = await apiRequest<{ migrations: MigrationRecord[] }>(`/databases/${id}/migrations`);
      setMigrations(result.migrations || []);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (id) {
      loadDatabase();
      loadSchema();
      loadMigrations();
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleQuery() {
    if (!sql.trim()) return;
    setQueryLoading(true);
    setQueryResult(null);
    try {
      const result = await apiRequest<QueryResult>(`/databases/${id}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql }),
      });
      setQueryResult(result);
      // Reload schema in case the query modified it
      loadSchema();
    } catch (err: any) {
      setQueryResult({ ok: false, error: err.message });
    } finally {
      setQueryLoading(false);
    }
  }

  async function handleApplyMigration() {
    if (!migrationName.trim() || !migrationSql.trim()) return;
    setMigrationLoading(true);
    try {
      await apiRequest(`/databases/${id}/migrations`, {
        method: 'POST',
        body: JSON.stringify({ name: migrationName, sql: migrationSql }),
      });
      setMigrationName('');
      setMigrationSql('');
      await Promise.all([loadMigrations(), loadSchema()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setMigrationLoading(false);
    }
  }

  async function handleTestConnection() {
    setTestResult(null);
    try {
      const result = await apiRequest<ConnectionTestResult>(`/databases/${id}/test-connection`, { method: 'POST' });
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, details: err.message });
    }
  }

  async function handleRotateToken() {
    try {
      await apiRequest(`/databases/${id}/rotate-token`, { method: 'PATCH' });
      await loadDatabase();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!database && !error) {
    return (
      <AppShell>
        <ShellFrame title="Loading…" subtitle="Fetching database details.">
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <p className="muted">Loading database information…</p>
          </div>
        </ShellFrame>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="studio-shell">
        <div className="studio-topbar">
          <div className="studio-breadcrumbs">
            <button type="button" className="studio-chip" onClick={() => router.push('/databases')}>Databases</button>
            <span className="studio-divider">/</span>
            <span className="studio-current">{database?.name || 'Database'}</span>
          </div>

          <div className="studio-meta-row">
            <span className={`badge ${database?.status === 'active' ? 'success' : database?.status === 'error' ? 'danger' : 'warning'}`}>{database?.status || '—'}</span>
            {database?.subdomain ? <span className="badge">{database.subdomain}</span> : null}
            <button type="button" className="studio-btn" onClick={() => router.push(`/databases/${id}/studio`)}>Open Studio</button>
            <button type="button" className="studio-btn" onClick={handleTestConnection}>Test connection</button>
            <button type="button" className="studio-btn" onClick={handleRotateToken}>Rotate token</button>
          </div>
        </div>

        <div className="studio-workspace-intro">
          <div>
            <div className="studio-kicker">{database?.type || 'database'}</div>
            <h1 className="studio-title">{database?.name || 'Database'}</h1>
            <p className="studio-subtitle">
              {database?.project ? <>Project: <strong>{database.project.name}</strong> · </> : null}
              Created {database?.createdAt ? new Date(database.createdAt).toLocaleDateString() : '—'}
            </p>
          </div>
        </div>

        {testResult ? <div className={`studio-callout ${testResult.ok ? 'success' : 'danger'}`}>Connection: {testResult.details}</div> : null}

        {error ? <div className="studio-callout danger">{error}</div> : null}

        <div className="studio-tab-strip">
          {(['schema', 'query', 'migrations'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={`studio-tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'schema' ? 'Schema' : tab === 'query' ? 'Query' : 'Migrations'}
            </button>
          ))}
        </div>

        <div className="studio-panel">
          {activeTab === 'schema' && (
            <>
              <div className="studio-panel-header">
                <div>
                  <h2>Schema browser</h2>
                  <p>{schema.length} table{schema.length !== 1 ? 's' : ''} in this database.</p>
                </div>
              </div>
              {schema.length === 0 ? (
                <div className="studio-empty-state">No tables found. Use Query or Migrations to create one.</div>
              ) : (
                <div className="studio-schema-list">
                  {schema.map((tableInfo) => (
                    <button
                      key={tableInfo.table}
                      type="button"
                      className={`studio-schema-item ${expandedTable === tableInfo.table ? 'active' : ''}`}
                      onClick={() => setExpandedTable(expandedTable === tableInfo.table ? null : tableInfo.table)}
                    >
                      <span className="studio-schema-name">{tableInfo.table}</span>
                      <span className="studio-schema-count">{tableInfo.columns.length}</span>
                    </button>
                  ))}
                </div>
              )}

              {expandedTable ? (
                <div className="studio-card">
                  <table className="studio-mini-table">
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Type</th>
                        <th>Not null</th>
                        <th>PK</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(schema.find((s) => s.table === expandedTable)?.columns || []).map((col) => (
                        <tr key={col.name}>
                          <td>{col.name}</td>
                          <td>{col.type || 'ANY'}</td>
                          <td>{col.notnull ? 'Yes' : 'No'}</td>
                          <td>{col.pk ? 'PK' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}

          {activeTab === 'query' && (
            <div className="studio-panel-grid">
              <div className="studio-card">
                <div className="studio-panel-header">
                  <div>
                    <h2>Query console</h2>
                    <p>Run SQL and inspect output.</p>
                  </div>
                </div>
                <div className="stack">
                  <textarea
                    className="studio-sql-mini"
                    placeholder="SELECT * FROM your_table LIMIT 50;"
                    value={sql}
                    onChange={(e) => setSql(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        handleQuery();
                      }
                    }}
                  />
                  <div className="toolbar">
                    <button type="button" className="studio-btn studio-btn-primary" onClick={handleQuery} disabled={queryLoading || !sql.trim()}>
                      {queryLoading ? 'Running…' : 'Execute'}
                    </button>
                    <span className="small muted">Ctrl+Enter</span>
                  </div>
                </div>
              </div>

              {queryResult ? (
                <div className="studio-card">
                  {queryResult.ok ? (
                    queryResult.rows && queryResult.rows.length > 0 ? (
                      <div className="studio-result-wrap">
                        <div className="studio-result-count">{queryResult.rows.length} row{queryResult.rows.length !== 1 ? 's' : ''} returned</div>
                        <table className="studio-mini-table">
                          <thead>
                            <tr>
                              {Object.keys(queryResult.rows[0] as object).map((key) => <th key={key}>{key}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {queryResult.rows.map((row: any, i) => (
                              <tr key={i}>
                                {Object.values(row).map((val: any, j) => <td key={j}>{val === null ? 'NULL' : String(val)}</td>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="studio-callout success">✓ Query executed successfully</div>
                    )
                  ) : (
                    <div className="studio-callout danger">{queryResult.error}</div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {activeTab === 'migrations' && (
            <div className="studio-panel-grid">
              <div className="studio-card">
                <div className="studio-panel-header">
                  <div>
                    <h2>Migrations</h2>
                    <p>Apply schema changes and track history.</p>
                  </div>
                </div>
                <div className="stack">
                  <input className="input" placeholder="Migration name" value={migrationName} onChange={(e) => setMigrationName(e.target.value)} />
                  <textarea className="studio-sql-mini" placeholder="CREATE TABLE users (...);" value={migrationSql} onChange={(e) => setMigrationSql(e.target.value)} />
                  <button type="button" className="studio-btn studio-btn-primary" onClick={handleApplyMigration} disabled={migrationLoading || !migrationName.trim() || !migrationSql.trim()}>
                    {migrationLoading ? 'Applying…' : 'Apply migration'}
                  </button>
                </div>
              </div>

              <div className="studio-card">
                <div className="studio-panel-header">
                  <div>
                    <h2>History</h2>
                    <p>{migrations.length} migration{migrations.length !== 1 ? 's' : ''}</p>
                  </div>
                </div>
                {migrations.length === 0 ? (
                  <div className="studio-empty-state">No migrations yet.</div>
                ) : (
                  <table className="studio-mini-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Status</th>
                        <th>Applied</th>
                      </tr>
                    </thead>
                    <tbody>
                      {migrations.map((migration) => (
                        <tr key={migration.id}>
                          <td>{migration.name}</td>
                          <td>{migration.status}</td>
                          <td>{new Date(migration.appliedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
