// Runs before every dev/build. Lists the bucket under the photos prefix
// and groups objects by their album folder (photos/<album>/<file>),
// writing src/data/albums.json so pages can render galleries statically.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

const bucket = process.env.BUCKET_NAME;
const region = process.env.AWS_REGION ?? 'us-east-1';
// Folder (key prefix) photos live under. Each immediate subfolder is an album:
// photos/analog-camera/roll-01.jpg -> album "analog-camera"
const photosPrefix = (process.env.PHOTOS_PREFIX ?? 'photos/').replace(/\/?$/, '/');
// Base URL objects are served from. Defaults to the bucket's public
// virtual-hosted-style URL; override once CloudFront is in front of it.
const publicUrlBase = process.env.PUBLIC_URL_BASE ?? (bucket ? `https://${bucket}.s3.${region}.amazonaws.com` : undefined);

const outFile = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'data',
	'albums.json',
);

function albumTitleFromSlug(slug) {
	return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function listAllObjects(client, Bucket, Prefix) {
	const keys = [];
	let ContinuationToken;
	do {
		const res = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
		for (const obj of res.Contents ?? []) {
			if (obj.Key && IMAGE_EXTENSIONS.has(path.extname(obj.Key).toLowerCase())) {
				keys.push(obj.Key);
			}
		}
		ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
	} while (ContinuationToken);
	return keys;
}

function groupIntoAlbums(keys) {
	const albums = new Map();

	for (const key of keys) {
		const rest = key.slice(photosPrefix.length);
		const slashIndex = rest.indexOf('/');
		// Ignore images directly under photos/ with no album folder.
		if (slashIndex === -1) continue;

		const slug = rest.slice(0, slashIndex);
		if (!albums.has(slug)) {
			albums.set(slug, { slug, title: albumTitleFromSlug(slug), photos: [] });
		}
		albums.get(slug).photos.push({
			key,
			url: `${publicUrlBase}/${key.split('/').map(encodeURIComponent).join('/')}`,
		});
	}

	for (const album of albums.values()) {
		album.photos.sort((a, b) => a.key.localeCompare(b.key));
	}

	return [...albums.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function main() {
	await mkdir(path.dirname(outFile), { recursive: true });

	if (!bucket) {
		console.warn('[fetch-photos] BUCKET_NAME not set — writing an empty album list.');
		await writeFile(outFile, '[]\n');
		return;
	}

	const client = new S3Client({ region });
	const keys = await listAllObjects(client, bucket, photosPrefix);
	const albums = groupIntoAlbums(keys);

	await writeFile(outFile, JSON.stringify(albums, null, 2) + '\n');
	const photoCount = albums.reduce((n, a) => n + a.photos.length, 0);
	console.log(`[fetch-photos] Wrote ${albums.length} album(s), ${photoCount} photo(s) to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
	console.error('[fetch-photos] Failed to list bucket:', err.message);
	console.error('[fetch-photos] Falling back to an empty album list so the build can continue.');
	writeFile(outFile, '[]\n').finally(() => process.exit(0));
});
