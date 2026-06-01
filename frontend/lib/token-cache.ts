type TokenEntry = {
  token: string;
  label?: string;
};

declare global {
  interface Window {
    __libsqliteEphemeralTokens?: Record<string, TokenEntry>;
  }
}

function getStore() {
  if (typeof window === 'undefined') {
    return {} as Record<string, TokenEntry>;
  }

  if (!window.__libsqliteEphemeralTokens) {
    window.__libsqliteEphemeralTokens = {};
  }

  return window.__libsqliteEphemeralTokens;
}

export function setEphemeralDatabaseToken(databaseId: string, token: string, label?: string) {
  if (!databaseId || !token) return;
  getStore()[databaseId] = { token, label };
}

export function consumeEphemeralDatabaseToken(databaseId: string) {
  if (!databaseId || typeof window === 'undefined') return null;
  const store = getStore();
  const entry = store[databaseId];
  if (!entry) return null;
  delete store[databaseId];
  return entry;
}

export function clearEphemeralDatabaseToken(databaseId: string) {
  if (!databaseId || typeof window === 'undefined') return;
  delete getStore()[databaseId];
}
