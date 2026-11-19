import path from 'path';
import { DatabaseSnapshot } from '../../domain/entities/DatabaseSnapshot';
import { isSqlDumpFile } from './libsql-dump';

export type SnapshotFormat = 'sqlite' | 'libsql-sql-dump' | 'libsql-sqlite-export';
export type SnapshotArtifactKind = 'db' | 'sql';

export type SnapshotArtifact = {
  kind: SnapshotArtifactKind;
  path: string;
  fileName: string;
  sizeBytes?: number;
  checksumSha256?: string;
};

export type SnapshotArtifacts = {
  primary: SnapshotArtifact;
  db?: SnapshotArtifact;
  dump?: SnapshotArtifact;
  preferred: SnapshotArtifact;
  downloadFormats: SnapshotArtifactKind[];
  totalBytes: number;
  warning?: string;
};

export type DatabaseSnapshotFileView = Pick<
  DatabaseSnapshot,
  'filePath' | 'fileName' | 'sizeBytes' | 'checksumSha256' | 'metadata'
>;

function safeSnapshotFileName(value: unknown) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || name === '.' || name === '..') return '';
  if (/[\\/]/.test(name)) return '';
  if (path.basename(name) !== name) return '';
  return name;
}

function metadataNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Describes every artifact that belongs to a snapshot without touching disk.
 *
 * Older snapshots have a single .sql file. New libSQL snapshots can carry a
 * materialized .db, and the transitional "both" mode keeps the legacy .sql as
 * the primary path so an older backend can still restore it.
 */
export function getSnapshotArtifacts(snapshot: DatabaseSnapshotFileView): SnapshotArtifacts {
  const primaryKind: SnapshotArtifactKind = isSqlDumpFile(snapshot.fileName) ? 'sql' : 'db';
  const primary: SnapshotArtifact = {
    kind: primaryKind,
    path: snapshot.filePath,
    fileName: snapshot.fileName,
    sizeBytes: metadataNumber(snapshot.sizeBytes),
    checksumSha256: snapshot.checksumSha256,
  };

  const directory = path.dirname(snapshot.filePath);
  const artifacts: SnapshotArtifact[] = [primary];

  const sqliteFileName = safeSnapshotFileName(snapshot.metadata?.sqliteFileName);
  if (sqliteFileName) {
    const sqliteSize = metadataNumber(snapshot.metadata?.sqliteSizeBytes);
    const sqliteChecksum = typeof snapshot.metadata?.sqliteChecksumSha256 === 'string'
      ? snapshot.metadata.sqliteChecksumSha256
      : undefined;
    const existing = artifacts.find((artifact) => artifact.kind === 'db');
    if (!existing) {
      artifacts.push({
        kind: 'db',
        path: path.join(directory, sqliteFileName),
        fileName: sqliteFileName,
        sizeBytes: sqliteSize,
        checksumSha256: sqliteChecksum,
      });
    }
  }

  const dumpFileName = safeSnapshotFileName(snapshot.metadata?.dumpFileName);
  if (dumpFileName) {
    const dumpSize = metadataNumber(snapshot.metadata?.dumpSizeBytes);
    const dumpChecksum = typeof snapshot.metadata?.dumpChecksumSha256 === 'string'
      ? snapshot.metadata.dumpChecksumSha256
      : undefined;
    const existing = artifacts.find((artifact) => artifact.kind === 'sql');
    if (!existing) {
      artifacts.push({
        kind: 'sql',
        path: path.join(directory, dumpFileName),
        fileName: dumpFileName,
        sizeBytes: dumpSize,
        checksumSha256: dumpChecksum,
      });
    }
  }

  const dbArtifact = artifacts.find((artifact) => artifact.kind === 'db');
  const sqlArtifact = artifacts.find((artifact) => artifact.kind === 'sql');
  const downloadFormats: SnapshotArtifactKind[] = [];
  if (dbArtifact) downloadFormats.push('db');
  if (sqlArtifact) downloadFormats.push('sql');

  const totalBytes = metadataNumber(snapshot.metadata?.totalBytes)
    ?? artifacts.reduce((total, artifact) => total + Number(artifact.sizeBytes || 0), 0);

  return {
    primary,
    db: dbArtifact,
    dump: sqlArtifact,
    preferred: dbArtifact || primary,
    downloadFormats,
    totalBytes,
    warning: typeof snapshot.metadata?.warning === 'string' ? snapshot.metadata.warning : undefined,
  };
}

export function getSnapshotFormat(
  snapshot: Pick<DatabaseSnapshot, 'fileName' | 'metadata'>,
): SnapshotFormat {
  const sqliteExport = snapshot.metadata?.format === 'libsql-sqlite-export'
    || (
      typeof snapshot.metadata?.sqliteFileName === 'string'
      && snapshot.metadata?.sqliteVerified === true
    );
  if (sqliteExport) return 'libsql-sqlite-export';

  const format = snapshot.metadata?.format;
  if (format === 'libsql-sql-dump' || isSqlDumpFile(snapshot.fileName)) {
    return 'libsql-sql-dump';
  }
  return 'sqlite';
}
