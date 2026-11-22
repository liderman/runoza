import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { objectStorage } from "./objects.ts";
export interface StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}
export function createStorage(options: StorageOptions) {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.pathStyle,
    credentials: {
      accessKeyId: options.accessKey,
      secretAccessKey: options.secretKey,
    },
    maxAttempts: 2,
  });
  return {
    ...objectStorage(client, options.bucket),
    async ready() {
      await client.send(new HeadBucketCommand({ Bucket: options.bucket }), {
        abortSignal: AbortSignal.timeout(5000),
      });
    },
    async provision() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode !== 404
        )
          throw error;
        try {
          await client.send(
            new CreateBucketCommand({
              Bucket: options.bucket,
              ...(options.region === "us-east-1"
                ? {}
                : {
                    CreateBucketConfiguration: {
                      LocationConstraint: options.region as "eu-west-1",
                    },
                  }),
            }),
          );
        } catch (e) {
          if ((e as { name: string }).name !== "BucketAlreadyOwnedByYou")
            throw e;
        }
      }
    },
    close() {
      client.destroy();
    },
  };
}

export type StorageService = ReturnType<typeof createStorage>;
