import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
export function objectStorage(client: S3Client, bucket: string) {
  const abort = async (key: string, id: string) => {
    try {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: id,
        }),
      );
    } catch (e) {
      if ((e as { name: string }).name !== "NoSuchUpload") throw e;
    }
  };
  return {
    async put(
      key: string,
      source: AsyncIterable<Uint8Array>,
      size: number,
      onStart: (id: string) => Promise<void>,
      check: () => Promise<void>,
      signal: AbortSignal,
    ) {
      if (size === 0) {
        signal.throwIfAborted();
        for await (const chunk of source) {
          signal.throwIfAborted();
          if (chunk.length) throw Error("SIZE_MISMATCH");
        }
        await check();
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: new Uint8Array(0),
            ContentLength: 0,
            ContentType: "application/octet-stream",
          }),
          { abortSignal: signal },
        );
        return {
          sha256: createHash("sha256").digest("hex"),
          sample: Buffer.alloc(0),
        };
      }
      const cancel = () => {
        if (source instanceof Readable) source.destroy();
      };
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: "application/octet-stream",
        }),
        { abortSignal: signal },
      );
      const id = created.UploadId!;
      let length = 0,
        buffer = Buffer.alloc(0),
        sample = Buffer.alloc(0);
      const hash = createHash("sha256"),
        parts: { PartNumber: number; ETag: string }[] = [];
      try {
        signal.addEventListener("abort", cancel, { once: true });
        signal.throwIfAborted();
        await onStart(id);
        const part = async (bytes: Buffer) => {
          await check();
          const result = await client.send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: id,
              PartNumber: parts.length + 1,
              Body: bytes,
              ContentLength: bytes.length,
            }),
            { abortSignal: signal },
          );
          parts.push({ PartNumber: parts.length + 1, ETag: result.ETag! });
        };
        for await (const chunk of source) {
          signal.throwIfAborted();
          length += chunk.length;
          if (length > size) throw Error("SIZE_MISMATCH");
          hash.update(chunk);
          if (sample.length < 1048576)
            sample = Buffer.concat([
              sample,
              Buffer.from(chunk).subarray(0, 1048576 - sample.length),
            ]);
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 5 * 1024 * 1024) {
            await part(buffer.subarray(0, 5 * 1024 * 1024));
            buffer = buffer.subarray(5 * 1024 * 1024);
          }
        }
        if (length !== size) throw Error("SIZE_MISMATCH");
        if (buffer.length) await part(buffer);
        await check();
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: id,
            MultipartUpload: { Parts: parts },
          }),
          { abortSignal: signal },
        );
        return { sha256: hash.digest("hex"), sample };
      } catch (e) {
        await abort(key, id).catch(() => {});
        throw e;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    abort,
    async remove(key: string) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async get(key: string, range?: string, signal?: AbortSignal) {
      const r = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }),
        {
          abortSignal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        },
      );
      return {
        body: r.Body as Readable,
        length: r.ContentLength,
        range: r.ContentRange,
      };
    },
    async *objects() {
      let cursor: string | undefined;
      do {
        const r = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: "files/",
            ContinuationToken: cursor,
          }),
        );
        for (const o of r.Contents ?? [])
          yield { key: o.Key!, at: o.LastModified! };
        cursor = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (cursor);
    },
    async *uploads() {
      let key: string | undefined, id: string | undefined;
      do {
        const r = await client.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: "files/",
            KeyMarker: key,
            UploadIdMarker: id,
          }),
        );
        for (const u of r.Uploads ?? [])
          yield { key: u.Key!, id: u.UploadId!, at: u.Initiated! };
        key = r.IsTruncated ? r.NextKeyMarker : undefined;
        id = r.NextUploadIdMarker;
      } while (key);
    },
  };
}
