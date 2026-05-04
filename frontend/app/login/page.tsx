"use client";

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest, setSession } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);

    const endpoint = mode === 'login' ? '/auth/login' : '/auth/register';

    try {
      const response = await apiRequest<{ accessToken: string; refreshToken: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setSession(response.accessToken, response.refreshToken);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="auth-grid">
        <section className="hero">
          <span className="brand-badge">libsqlite</span>
          <h1>Self-hosted control plane for SQLite and libsql</h1>
          <p>
            Manage local SQLite files, register libsql endpoints, browse schemas, run queries and apply
            migrations — all from a single secure panel on your own infrastructure.
          </p>
          <div style={{ marginTop: 24 }}>
            <div className="card" style={{ display: 'inline-block' }}>
              <ul className="small" style={{ lineHeight: 2, margin: 0, paddingLeft: 18 }}>
                <li>Projects, roles and permissions (RBAC)</li>
                <li>SQLite provisioning and import</li>
                <li>Discovery and adoption of mounted files</li>
                <li>libsql remote management</li>
                <li>Schema browser, query editor and migrations</li>
                <li>Full audit trail</li>
              </ul>
            </div>
          </div>
        </section>

        <form className="panel stack" onSubmit={handleSubmit}>
          <div className="section-header">
            <div>
              <h2 className="section-title">{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
              <p className="muted">
                {mode === 'login'
                  ? 'Authenticate with your email and password.'
                  : 'Register a new administrator account.'}
              </p>
            </div>
          </div>

          <div className="field-grid">
            <label className="stack" style={{ gap: 6 }}>
              <span className="small">Email</span>
              <input
                id="login-email"
                className="input"
                type="email"
                autoComplete="email"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <span className="small">Password</span>
              <input
                id="login-password"
                className="input"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </label>
          </div>

          {error ? <div className="badge danger" style={{ padding: '8px 14px' }}>{error}</div> : null}

          <button id="login-submit" className="button" type="submit" disabled={loading}>
            {loading ? (mode === 'login' ? 'Signing in…' : 'Creating account…') : (mode === 'login' ? 'Sign in' : 'Create account')}
          </button>

          <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
            {mode === 'login' ? (
              <>No account yet?{' '}
                <button type="button" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }}
                  onClick={() => { setMode('register'); setError(''); }}>
                  Create one
                </button>
              </>
            ) : (
              <>Already have an account?{' '}
                <button type="button" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }}
                  onClick={() => { setMode('login'); setError(''); }}>
                  Sign in
                </button>
              </>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
