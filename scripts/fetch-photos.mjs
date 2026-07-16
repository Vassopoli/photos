// Runs before every dev/build. Lists the photos bucket and writes
// src/data/photos.json so pages can render the gallery statically.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

const bucket = process.env.PHOTOS_BUCKET_NAME;
const region = process.env.AWS_REGION ?? 'us-east-1';
// Base URL photos are served from. Defaults to the bucket's public
// virtual-hosted-style URL; override once CloudFront is in front of it.
const publicUrlBase = process.env.PHOTOS_PUBLIC_URL_BASE ?? (bucket ? `https://${bucket}.s3.${region}.amazonaws.com` : undefined);

const outFile = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'data',
	'photos.json',
);

async function listAllObjects(client, Bucket) {
	const keys = [];
	let ContinuationToken;
	do {
		const res = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
		for (const obj of res.Contents ?? []) {
			if (obj.Key && IMAGE_EXTENSIONS.has(path.extname(obj.Key).toLowerCase())) {
				keys.push(obj.Key);
			}
		}
		ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
	} while (ContinuationToken);
	return keys;
}

async function main() {
	await mkdir(path.dirname(outFile), { recursive: true });

	if (!bucket) {
		console.warn('[fetch-photos] PHOTOS_BUCKET_NAME not set — writing an empty gallery.');
		await writeFile(outFile, '[]\n');
		return;
	}

	const client = new S3Client({ region });
	const keys = await listAllObjects(client, bucket);
	keys.sort();

	const photos = keys.map((key) => ({
		key,
		url: `${publicUrlBase}/${key.split('/').map(encodeURIComponent).join('/')}`,
	}));

	await writeFile(outFile, JSON.stringify(photos, null, 2) + '\n');
	console.log(`[fetch-photos] Wrote ${photos.length} photo(s) to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
	console.error('[fetch-photos] Failed to list photos bucket:', err.message);
	console.error('[fetch-photos] Falling back to an empty gallery so the build can continue.');
	writeFile(outFile, '[]\n').finally(() => process.exit(0));
});
