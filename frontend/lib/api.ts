export type ApiResult<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

const API_URL = '/api/v1';
const SESSION_KEY = 'libsqlite.auth.v1';

function getCookie(name: string) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function setSession(_accessToken: string, _refreshToken: string) {
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(SESSION_KEY, '1');
  }
}

export function clearSession() {
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem(SESSION_KEY);
  }
}

export function isAuthenticated() {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(SESSION_KEY) === '1';
}

function normalizeErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;

    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error;
    }

    if (record.error && typeof record.error === 'object') {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message.trim()) {
        return nested.message;
      }
      if (typeof nested.error === 'string' && nested.error.trim()) {
        return nested.error;
      }
    }

    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
  }

  return fallback;
}

async function tryRefreshToken(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });

    if (!response.ok) return false;
    setSession('', '');
    return true;
  } catch {
    return false;
  }
}

function buildHeaders(initHeaders: HeadersInit | undefined, body: BodyInit | null | undefined, method: string) {
  const headers = new Headers(initHeaders);
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  if (!isFormData && body !== undefined && body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = getCookie('libsqlite.csrfToken.v2') || getCookie('libsqlite.csrfToken');
    if (csrfToken) {
      headers.set('x-csrf-token-v2', csrfToken);
      headers.set('x-csrf-token', csrfToken);
    }
  }

  return headers;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = String(init.method || 'GET').toUpperCase();
  const headers = buildHeaders(init.headers, init.body, method);

  let response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  if (response.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      const retryHeaders = buildHeaders(init.headers, init.body, method);
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
    const text = await response.text().catch(() => '');
    let payload: unknown = text;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    throw new Error(normalizeErrorMessage(payload, response.statusText || 'Request failed'));
  }

  return response.json();
}

export function createApiHooks<TRead, TWrite = Partial<TRead>>(basePath: string) {
  const listPath = basePath;
  const itemPath = (id: string) => `${basePath}/${id}`;

  return {
    listPath,
    itemPath,
    list: async (): Promise<TRead[]> => {
      const result = await apiRequest<Record<string, TRead[]>>(listPath);
      const key = Object.keys(result).find(k => Array.isArray(result[k]));
      return (key ? result[key] : []) as TRead[];
    },
    get: async (id: string): Promise<TRead> => {
      const result = await apiRequest<Record<string, TRead>>(itemPath(id));
      const key = Object.keys(result).find(k => k !== 'ok');
      return (key ? result[key] : result) as TRead;
    },
    create: async (data: TWrite & Record<string, unknown>): Promise<TRead> => {
      return apiRequest<TRead>(listPath, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    update: async (id: string, data: Partial<TWrite>): Promise<TRead> => {
      return apiRequest<TRead>(itemPath(id), {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    delete: async (id: string): Promise<void> => {
      return apiRequest(itemPath(id), { method: 'DELETE' });
    },
  };
}
