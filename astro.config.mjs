// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'static',
	site: 'https://photos.vassopoli.com',
	// Flat .html files instead of foo/index.html. CloudFront (with S3 as a
	// REST/OAC origin rather than the S3 website endpoint) only resolves
	// index.html at the distribution root, not for arbitrary subdirectories
	// — flat files sidestep that entirely since every request is an exact
	// object-key match.
	build: {
		format: 'file',
	},
});
