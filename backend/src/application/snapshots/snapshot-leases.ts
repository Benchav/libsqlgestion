const leases = new Map<string, number>();
const deleting = new Set<string>();

function conflict(message: string) {
  const error: any = new Error(message);
  error.statusCode = 409;
  return error;
}

/**
 * Keeps a snapshot artifact alive while it is being read or uploaded.
 * The returned function is idempotent.
 */
export function acquireSnapshotLease(snapshotId: string) {
  if (deleting.has(snapshotId)) {
    throw conflict('snapshot is being deleted');
  }

  leases.set(snapshotId, (leases.get(snapshotId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (leases.get(snapshotId) || 1) - 1;
    if (remaining <= 0) {
      leases.delete(snapshotId);
    } else {
      leases.set(snapshotId, remaining);
    }
  };
}

export function isSnapshotLeased(snapshotId: string) {
  return (leases.get(snapshotId) || 0) > 0;
}

/**
 * Synchronously claims a snapshot for file removal. The check and the claim
 * happen without an await, so no new lease can slip in between them in the
 * Node event loop.
 */
export function beginSnapshotRemoval(snapshotId: string) {
  if (deleting.has(snapshotId)) return false;
  if (isSnapshotLeased(snapshotId)) return false;
  deleting.add(snapshotId);
  return true;
}

export function endSnapshotRemoval(snapshotId: string) {
  deleting.delete(snapshotId);
}
