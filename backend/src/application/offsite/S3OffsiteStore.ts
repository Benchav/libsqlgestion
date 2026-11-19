import fs from 'fs';
import { pipeline } from 'stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  assertSafeOffsiteEndpoint,
  OffsiteBackupInternalSettings,
} from '../settings/OffsiteBackupSettingsService';

export type OffsiteObject = {
  key: string;
  size?: number;
  lastModified?: Date;
};

export type OffsiteUploadInput = {
  filePath: string;
  key: string;
  contentType: string;
  metadata?: Record<string, string>;
};

export interface OffsiteStore {
  testConnection(): Promise<{ latencyMs: number }>;
  uploadFile(input: OffsiteUploadInput): Promise<void>;
  putJson(key: string, body: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T>;
  downloadToFile(key: string, destinationPath: string): Promise<void>;
  listObjects(prefix: string): Promise<OffsiteObject[]>;
  deleteObject(key: string): Promise<void>;
}

const PART_SIZE = 8 * 1024 * 1024;

export function describeOffsiteError(error: any) {
  const status = error?.$metadata?.httpStatusCode;
  const name = error?.name || error?.Code || 'S3Error';
  const message = String(error?.message || error || 'S3 operation failed');
  return `${name}${status ? ` (HTTP ${status})` : ''}: ${message}`.slice(0, 800);
}

function createClient(
  settings: OffsiteBackupInternalSettings,
  endpoint: URL,
) {
  return new S3Client({
    endpoint: endpoint.toString(),
    region: settings.region || 'auto',
    forcePathStyle: true,
    maxAttempts: 3,
    // R2 and several S3-compatible gateways reject automatic CRC headers.
    // The manifest already carries our SHA-256, so only use checksums when the
    // operation explicitly requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey || '',
    },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: Math.min(15_000, settings.timeoutMs),
      requestTimeout: settings.timeoutMs,
    }),
  });
}

export function createS3OffsiteStore(settings: OffsiteBackupInternalSettings): OffsiteStore {
  let clientPromise: Promise<S3Client> | undefined;

  const getClient = async () => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const endpoint = await assertSafeOffsiteEndpoint(settings.endpoint);
        return createClient(settings, endpoint);
      })();
    }
    return clientPromise;
  };

  return {
    async testConnection() {
      const startedAt = Date.now();
      const client = await getClient();
      await client.send(new ListObjectsV2Command({
        Bucket: settings.bucket,
        Prefix: settings.prefix ? `${settings.prefix}/` : undefined,
        MaxKeys: 1,
      }));
      return { latencyMs: Date.now() - startedAt };
    },

    async uploadFile(input) {
      const stat = await fs.promises.stat(input.filePath);
      if (!stat.isFile() || stat.size <= 0) {
        throw new Error(`offsite upload source is not a non-empty file: ${input.filePath}`);
      }
      const client = await getClient();
      const upload = new Upload({
        client,
        params: {
          Bucket: settings.bucket,
          Key: input.key,
          Body: fs.createReadStream(input.filePath),
          ContentLength: stat.size,
          ContentType: input.contentType,
          CacheControl: 'private, no-store',
          Metadata: input.metadata,
        },
        queueSize: 2,
        partSize: PART_SIZE,
        leavePartsOnError: false,
      });
      await upload.done();
    },

    async putJson(key, body) {
      const client = await getClient();
      await client.send(new PutObjectCommand({
        Bucket: settings.bucket,
        Key: key,
        Body: Buffer.from(JSON.stringify(body, null, 2), 'utf8'),
        ContentType: 'application/json',
        CacheControl: 'private, no-store',
      }));
    },

    async getJson<T>(key: string) {
      const client = await getClient();
      const response = await client.send(new GetObjectCommand({
        Bucket: settings.bucket,
        Key: key,
      }));
      if (!response.Body) throw new Error(`offsite object is empty: ${key}`);
      const text = await (response.Body as any).transformToString();
      return JSON.parse(text) as T;
    },

    async downloadToFile(key, destinationPath) {
      const client = await getClient();
      const response = await client.send(new GetObjectCommand({
        Bucket: settings.bucket,
        Key: key,
      }));
      if (!response.Body) throw new Error(`offsite object is empty: ${key}`);
      try {
        await pipeline(response.Body as any, fs.createWriteStream(destinationPath, { flags: 'wx' }));
      } catch (error) {
        await fs.promises.rm(destinationPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async listObjects(prefix) {
      const client = await getClient();
      const objects: OffsiteObject[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: settings.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }));
        for (const item of page.Contents || []) {
          if (!item.Key) continue;
          objects.push({
            key: item.Key,
            size: item.Size,
            lastModified: item.LastModified,
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },

    async deleteObject(key) {
      const client = await getClient();
      await client.send(new DeleteObjectCommand({
        Bucket: settings.bucket,
        Key: key,
      }));
    },
  };
}
