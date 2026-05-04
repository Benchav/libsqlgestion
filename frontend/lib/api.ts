export type ApiResult<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

export function getToken() {
  return null;
}

export function getRefreshToken() {
  return null;
}

export function setSession(accessToken: string, refreshToken: string) {
  void accessToken;
  void refreshToken;
}

export function clearSession() {
  return;
}

export function isAuthenticated() {
  return true;
}

async function tryRefreshToken(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });

    if (!response.ok) return false;

    const data = await response.json();
    setSession(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  // If we get a 401, attempt a silent refresh and retry once
  if (response.status === 401 && token) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set('Content-Type', 'application/json');
      retryHeaders.set('Authorization', `Bearer ${getToken()}`);
      response = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: retryHeaders,
        credentials: 'include',
        cache: 'no-store',
      });
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    }
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || response.statusText);
  }

  return response.json();
}
