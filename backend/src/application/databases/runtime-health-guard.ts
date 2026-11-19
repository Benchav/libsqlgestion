export type RuntimeIdentity = {
  containerId?: unknown;
  authKeyPem?: unknown;
};

export type ExpectedRuntimeIdentity = {
  containerId: string;
  authKeyPem: string;
};

/**
 * Health checks take time (public DNS, TLS, SQL). During that window a token
 * rotation can replace the runtime and persist a new credential. Health may
 * only be written when the row still describes the runtime that was checked;
 * otherwise a stale health check would overwrite the new container id, key and
 * token metadata.
 */
export function runtimeIdentityMatches(
  actual: RuntimeIdentity | null | undefined,
  expected: ExpectedRuntimeIdentity,
): boolean {
  if (!actual || typeof actual !== 'object') return false;
  if (typeof actual.containerId !== 'string' || actual.containerId !== expected.containerId) {
    return false;
  }
  const actualKey = typeof actual.authKeyPem === 'string' ? actual.authKeyPem : '';
  return actualKey === expected.authKeyPem;
}
