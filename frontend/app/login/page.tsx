"use client";

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest, setSession } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('StrongPassword123!');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await apiRequest<{ accessToken: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setSession(response.accessToken, response.refreshToken);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="auth-grid">
        <section className="hero">
          <span className="brand-badge">Access</span>
          <h1>Sign in to your database control plane</h1>
          <p>
            Use the same backend to manage SQLite files and libsql endpoints from a single secure panel.
          </p>
          <p className="small">
            Tip: the first user you create through the backend usually becomes the base administrator.
          </p>
        </section>

        <form className="panel stack" onSubmit={handleSubmit}>
          <div className="section-header">
            <div>
              <h2 className="section-title">Login</h2>
              <p className="muted">Authenticate with email and password.</p>
            </div>
          </div>

          <div className="field-grid">
            <label className="stack">
              <span className="small">Email</span>
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="stack">
              <span className="small">Password</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>

          {error ? <div className="badge danger">{error}</div> : null}

          <button className="button" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
