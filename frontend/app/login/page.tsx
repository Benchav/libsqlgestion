"use client";

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest, setSession } from '../../lib/api';
import { Database } from 'lucide-react';

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
      await apiRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setSession('', '');
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-[#0a0a0a] text-zinc-300 font-sans selection:bg-emerald-500/30">
      <div className="flex-1 flex items-center justify-center p-6 relative z-10">
        <form className="w-full max-w-[400px] bg-[#0f0f0f] border border-zinc-800/80 rounded-2xl p-8 shadow-2xl" onSubmit={handleSubmit}>
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-12 h-12 bg-zinc-800 rounded-xl flex items-center justify-center mb-4">
              <Database className="text-zinc-100" size={24} />
            </div>
            <h2 className="text-2xl font-semibold text-zinc-100">
              {mode === 'login' ? 'Welcome back' : 'Create your account'}
            </h2>
            <p className="text-zinc-400 mt-2 text-sm">
              {mode === 'login' 
                ? 'Sign in to access your databases.' 
                : 'Set up your administrator account.'}
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1.5">Email address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-[#050505] border border-zinc-800 rounded-lg px-4 py-2.5 text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1.5">Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[#050505] border border-zinc-800 rounded-lg px-4 py-2.5 text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors"
                placeholder="••••••••"
              />
            </div>
          </div>

          {error && (
            <div className="mt-4 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button 
            type="submit" 
            disabled={loading || !email || !password}
            className="w-full mt-8 bg-zinc-100 hover:bg-white text-zinc-900 font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>

          <p className="mt-6 text-center text-sm text-zinc-500">
            {mode === 'login' ? "Don't have an account? " : "Already have an account? "}
            <button 
              type="button" 
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
              className="text-zinc-300 hover:text-white font-medium hover:underline transition-all"
            >
              {mode === 'login' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>
      
      {/* Visual background pattern */}
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>
    </div>
  );
}
