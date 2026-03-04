import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { CompletedPart } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { webEnv } from "@opencut/env/web";

let s3Client: S3Client | null = null;

function assertS3Configured(): void {
	if (!webEnv.S3_ENDPOINT) {
		throw new Error("S3_ENDPOINT is not configured");
	}
	if (!webEnv.S3_ACCESS_KEY_ID || !webEnv.S3_SECRET_ACCESS_KEY) {
		throw new Error("S3 credentials are not configured");
	}
}

export function isServerStorageEnabled(): boolean {
	return webEnv.STORAGE_BACKEND === "server";
}

export function getS3Bucket(): string {
	return webEnv.S3_BUCKET ?? "opencut-media";
}

export function getS3Client(): S3Client {
	if (s3Client) return s3Client;
	assertS3Configured();
	s3Client = new S3Client({
		region: webEnv.S3_REGION ?? "us-east-1",
		endpoint: webEnv.S3_ENDPOINT,
		forcePathStyle: webEnv.S3_FORCE_PATH_STYLE,
		credentials: {
			accessKeyId: webEnv.S3_ACCESS_KEY_ID ?? "",
			secretAccessKey: webEnv.S3_SECRET_ACCESS_KEY ?? "",
		},
	});
	return s3Client;
}

export async function putObjectToStorage({
	key,
	body,
	contentType,
}: {
	key: string;
	body: Uint8Array;
	contentType?: string;
}): Promise<void> {
	await getS3Client().send(
		new PutObjectCommand({
			Bucket: getS3Bucket(),
			Key: key,
			Body: body,
			ContentType: contentType,
		}),
	);
}

export async function deleteObjectFromStorage({ key }: { key: string }): Promise<void> {
	await getS3Client().send(
		new DeleteObjectCommand({
			Bucket: getS3Bucket(),
			Key: key,
		}),
	);
}

export async function deleteObjectsByPrefix({
	prefix,
}: {
	prefix: string;
}): Promise<void> {
	const client = getS3Client();
	let continuationToken: string | undefined;

	do {
		const listResult = await client.send(
			new ListObjectsV2Command({
				Bucket: getS3Bucket(),
				Prefix: prefix,
				ContinuationToken: continuationToken,
			}),
		);

		const keys = (listResult.Contents ?? [])
			.map((item) => item.Key)
			.filter((key): key is string => typeof key === "string" && key.length > 0);

		for (const key of keys) {
			await client.send(
				new DeleteObjectCommand({
					Bucket: getS3Bucket(),
					Key: key,
				}),
			);
		}

		continuationToken = listResult.IsTruncated
			? listResult.NextContinuationToken
			: undefined;
	} while (continuationToken);
}

export async function getObjectFromStorage({
	key,
	range,
}: {
	key: string;
	range?: string;
}): Promise<{
	body: Readable;
	contentType?: string;
	contentLength?: number;
	contentRange?: string;
	acceptRanges?: string;
} | null> {
	try {
		const response = await getS3Client().send(
			new GetObjectCommand({
				Bucket: getS3Bucket(),
				Key: key,
				Range: range,
			}),
		);
		if (!response.Body) return null;
		return {
			body: response.Body as Readable,
			contentType: response.ContentType,
			contentLength:
				typeof response.ContentLength === "number"
					? response.ContentLength
					: undefined,
			contentRange:
				typeof response.ContentRange === "string" ? response.ContentRange : undefined,
			acceptRanges:
				typeof response.AcceptRanges === "string" ? response.AcceptRanges : undefined,
		};
	} catch (error) {
		if (error && typeof error === "object") {
			const named = error as { name?: string };
			if (named.name === "NoSuchKey" || named.name === "NotFound") {
				return null;
			}
		}
		throw error;
	}
}

export async function checkStorageHealth(): Promise<boolean> {
	if (!isServerStorageEnabled()) return true;
	try {
		await getS3Client().send(
			new HeadBucketCommand({
				Bucket: getS3Bucket(),
			}),
		);
		return true;
	} catch {
		return false;
	}
}

export async function createMultipartUpload({
	key,
	contentType,
}: {
	key: string;
	contentType?: string;
}): Promise<string> {
	const response = await getS3Client().send(
		new CreateMultipartUploadCommand({
			Bucket: getS3Bucket(),
			Key: key,
			ContentType: contentType,
		}),
	);
	if (!response.UploadId) {
		throw new Error(`Failed to create multipart upload for key ${key}`);
	}
	return response.UploadId;
}

export async function uploadMultipartPart({
	key,
	multipartUploadId,
	partNumber,
	body,
}: {
	key: string;
	multipartUploadId: string;
	partNumber: number;
	body: Uint8Array;
}): Promise<string> {
	const response = await getS3Client().send(
		new UploadPartCommand({
			Bucket: getS3Bucket(),
			Key: key,
			UploadId: multipartUploadId,
			PartNumber: partNumber,
			Body: body,
		}),
	);
	const etag = response.ETag?.replaceAll('"', "");
	if (!etag) {
		throw new Error(`Missing ETag for multipart part ${partNumber}`);
	}
	return etag;
}

export async function completeMultipartUpload({
	key,
	multipartUploadId,
	parts,
}: {
	key: string;
	multipartUploadId: string;
	parts: CompletedPart[];
}): Promise<void> {
	await getS3Client().send(
		new CompleteMultipartUploadCommand({
			Bucket: getS3Bucket(),
			Key: key,
			UploadId: multipartUploadId,
			MultipartUpload: {
				Parts: parts.sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0)),
			},
		}),
	);
}

export async function abortMultipartUpload({
	key,
	multipartUploadId,
}: {
	key: string;
	multipartUploadId: string;
}): Promise<void> {
	await getS3Client().send(
		new AbortMultipartUploadCommand({
			Bucket: getS3Bucket(),
			Key: key,
			UploadId: multipartUploadId,
		}),
	);
}
