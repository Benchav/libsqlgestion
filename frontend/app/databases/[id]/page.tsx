"use client";

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '../../../components/AppShell';
import { ShellFrame } from '../../../components/ShellFrame';
import { apiRequest } from '../../../lib/api';

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
      {/* Header */}
      <section className="hero">
        <div className="hero-top">
          <div className="hero-copy">
            <span className="brand-badge">{database?.type || 'database'}</span>
            <h1>{database?.name || 'Database'}</h1>
            <p>
              {database?.project ? (
                <>Project: <strong>{database.project.name}</strong> · </>
              ) : null}
              Created {database?.createdAt ? new Date(database.createdAt).toLocaleDateString() : '—'}
            </p>
            <div className="hero-actions" style={{ marginTop: 12 }}>
              <button className="button" onClick={() => router.push(`/databases/${id}/studio`)}>⊞ Open Studio</button>
              <button className="button-secondary" onClick={() => router.push('/databases')}>← All databases</button>
              <button className="button-secondary" onClick={handleTestConnection}>Test connection</button>
              <button className="button-secondary" onClick={handleRotateToken}>Rotate token</button>
            </div>
          </div>
          <div className="stack" style={{ gap: 8, minWidth: 160 }}>
            <span className={`badge ${database?.status === 'active' ? 'success' : database?.status === 'error' ? 'danger' : 'warning'}`}>
              {database?.status}
            </span>
            {database?.subdomain ? <span className="badge">{database.subdomain}</span> : null}
          </div>
        </div>
      </section>

      {/* Test result */}
      {testResult ? (
        <div className={`badge ${testResult.ok ? 'success' : 'danger'}`} style={{ padding: '10px 16px' }}>
          Connection: {testResult.details}
        </div>
      ) : null}

      {error ? <div className="badge danger" style={{ padding: '10px 16px' }}>{error}</div> : null}

      {/* Tab bar */}
      <div className="toolbar" style={{ gap: 0, borderRadius: 16, overflow: 'hidden' }}>
        {(['schema', 'query', 'migrations'] as const).map((tab) => (
          <button
            key={tab}
            className={activeTab === tab ? 'button' : 'button-secondary'}
            style={{ borderRadius: 0, flex: 1, textTransform: 'capitalize' }}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'schema' ? '⛁ Schema' : tab === 'query' ? '▷ Query' : '↑ Migrations'}
          </button>
        ))}
      </div>

      {/* Schema tab */}
      {activeTab === 'schema' && (
        <ShellFrame title="Schema browser" subtitle={`${schema.length} table${schema.length !== 1 ? 's' : ''} found in this database.`}>
          {schema.length === 0 ? (
            <div className="card" style={{ padding: 24, textAlign: 'center' }}>
              <p className="muted">No tables found. Use the Query or Migrations tab to create one.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {schema.map((tableInfo) => (
                <div key={tableInfo.table} className="card" style={{ cursor: 'pointer' }}>
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    onClick={() => setExpandedTable(expandedTable === tableInfo.table ? null : tableInfo.table)}
                  >
                    <div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{tableInfo.table}</span>
                      <span className="muted small" style={{ marginLeft: 12 }}>
                        {tableInfo.columns.length} column{tableInfo.columns.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <span className="muted">{expandedTable === tableInfo.table ? '▾' : '▸'}</span>
                  </div>

                  {expandedTable === tableInfo.table && (
                    <table className="table" style={{ marginTop: 12 }}>
                      <thead>
                        <tr>
                          <th>Column</th>
                          <th>Type</th>
                          <th>Not null</th>
                          <th>PK</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tableInfo.columns.map((col) => (
                          <tr key={col.name}>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{col.name}</td>
                            <td><span className="badge">{col.type || 'ANY'}</span></td>
                            <td>{col.notnull ? '✓' : '—'}</td>
                            <td>{col.pk ? <span className="badge warning">PK</span> : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </ShellFrame>
      )}

      {/* Query tab */}
      {activeTab === 'query' && (
        <ShellFrame title="Query editor" subtitle="Execute SQL statements against this database.">
          <div className="stack">
            <textarea
              className="textarea"
              placeholder="SELECT * FROM your_table LIMIT 50;"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', minHeight: 140 }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleQuery();
                }
              }}
            />
            <div className="toolbar">
              <button className="button" onClick={handleQuery} disabled={queryLoading || !sql.trim()}>
                {queryLoading ? 'Running…' : '▶ Execute'}
              </button>
              <span className="small muted">Ctrl+Enter to run</span>
            </div>
          </div>

          {queryResult && (
            <div className="card" style={{ marginTop: 12 }}>
              {queryResult.ok ? (
                <>
                  {queryResult.rows && queryResult.rows.length > 0 ? (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="table">
                        <thead>
                          <tr>
                            {Object.keys(queryResult.rows[0] as object).map((key) => (
                              <th key={key} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{key}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {queryResult.rows.map((row: any, i) => (
                            <tr key={i}>
                              {Object.values(row).map((val: any, j) => (
                                <td key={j} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                                  {val === null ? <span className="muted">NULL</span> : String(val)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="small muted" style={{ marginTop: 8 }}>{queryResult.rows.length} row{queryResult.rows.length !== 1 ? 's' : ''} returned</div>
                    </div>
                  ) : queryResult.result ? (
                    <div className="badge success">
                      ✓ {queryResult.result.changes} row{queryResult.result.changes !== 1 ? 's' : ''} affected
                    </div>
                  ) : (
                    <div className="badge success">✓ Query executed successfully</div>
                  )}
                </>
              ) : (
                <div className="badge danger">{queryResult.error}</div>
              )}
            </div>
          )}
        </ShellFrame>
      )}

      {/* Migrations tab */}
      {activeTab === 'migrations' && (
        <ShellFrame title="Migrations" subtitle="Track and apply schema changes to this database.">
          <div className="card stack" style={{ padding: 20 }}>
            <h3 className="section-title" style={{ fontSize: '0.95rem' }}>Apply new migration</h3>
            <input
              className="input"
              placeholder="Migration name (e.g. create-users-table)"
              value={migrationName}
              onChange={(e) => setMigrationName(e.target.value)}
            />
            <textarea
              className="textarea"
              placeholder="CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);"
              value={migrationSql}
              onChange={(e) => setMigrationSql(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', minHeight: 120 }}
            />
            <button className="button" onClick={handleApplyMigration} disabled={migrationLoading || !migrationName.trim() || !migrationSql.trim()}>
              {migrationLoading ? 'Applying…' : '↑ Apply migration'}
            </button>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <h3 className="section-title" style={{ fontSize: '0.95rem', marginBottom: 12 }}>History</h3>
            {migrations.length === 0 ? (
              <p className="muted small">No migrations have been applied to this database yet.</p>
            ) : (
              <table className="table">
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
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{migration.name}</td>
                      <td>
                        <span className={`badge ${migration.status === 'applied' ? 'success' : migration.status === 'failed' ? 'danger' : 'warning'}`}>
                          {migration.status}
                        </span>
                        {migration.errorMessage ? (
                          <span className="small danger" style={{ marginLeft: 8 }}>{migration.errorMessage}</span>
                        ) : null}
                      </td>
                      <td className="muted">{new Date(migration.appliedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </ShellFrame>
      )}
    </AppShell>
  );
}
