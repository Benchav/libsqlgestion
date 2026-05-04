export type ApiResult<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

export function getToken() {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('libsqlite.accessToken');
}

export function setSession(accessToken: string, refreshToken: string) {
  window.localStorage.setItem('libsqlite.accessToken', accessToken);
  window.localStorage.setItem('libsqlite.refreshToken', refreshToken);
}

export function clearSession() {
  window.localStorage.removeItem('libsqlite.accessToken');
  window.localStorage.removeItem('libsqlite.refreshToken');
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || response.statusText);
  }

  return response.json();
}
