# photos.vassopoli.com

Photography portfolio, organized by albums. An Astro static site pulls its
album/photo list from an S3 bucket at build time; GitHub Actions builds and
deploys the site to that same bucket.

## How it works

One bucket serves both the built site and the photos, kept apart by key
prefix ("folder"):

```text
s3://<bucket>/
├── index.html, _astro/, ...        <- built site (deployed by CI)
└── photos/
    ├── analog-camera/
    │   ├── roll-01-01.jpg          <- upload photos directly here
    │   └── roll-01-02.jpg
    └── <another-album>/
        └── ...
```

Each immediate subfolder under `photos/` is one album. There's no config
file for albums — the folder name *is* the album (slugified for the URL,
title-cased for display: `analog-camera` → "Analog Camera").

- **Build** — `scripts/fetch-photos.mjs` lists the bucket under the
  `photos/` prefix (`s3:ListBucket`), groups objects by their album folder,
  reads a small byte range of each photo to pull its EXIF date
  (`s3:GetObject`, via [exifr](https://github.com/MikeKovarik/exifr)), and
  writes `src/data/albums.json`, which the pages render statically. This
  runs automatically before both `npm run dev` and `npm run build`. Scanned
  film has no `DateTimeOriginal`/`CreateDate` (the camera never wrote
  EXIF) — the fallback is `ModifyDate`, which is a scan/export date, not a
  true capture date; the UI shows it as a plain "Date", not "Date taken".
- **Deploy** — [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  builds the site and runs `aws s3 sync --delete --exclude "photos/*"` on
  every push to `main`. The `--exclude` is what makes sharing one bucket
  safe: the deploy only ever touches the site files, never the photos
  folder. Auth is via GitHub's OIDC provider assuming an IAM role — no
  long-lived AWS keys stored in the repo.
- **Access** — the bucket itself is fully private (Block Public Access on,
  no bucket policy); a CloudFront distribution with Origin Access Control
  is the only thing allowed to read it, and serves both the site and the
  photos. `PUBLIC_URL_BASE` in `.env` / CI vars must point at the
  CloudFront domain (e.g. `https://xxxxxxxxxxxxxx.cloudfront.net`) — object
  URLs built from the raw S3 endpoint will 403. There's no auth in front of
  CloudFront itself yet, so anyone with a photo's URL can view it; that's
  the "v1, no real auth" state.

> **Note on routing:** `astro.config.mjs` sets `build.format: 'file'`, so
> pages build as flat `albums/<slug>.html` instead of
> `albums/<slug>/index.html`. This matters because CloudFront is using the
> bucket as a REST/OAC origin (not the S3 website endpoint), which only
> resolves `index.html` at the distribution root — a request for
> `/albums/<slug>/` 403s. Flat files sidestep that: every request is an
> exact object-key match. If you ever switch the origin to the S3 website
> endpoint, `build.format` could go back to the default `'directory'`.

## Local development

Requires Node 22.15.0 (`nvm use 22.15.0`).

```sh
cp .env.example .env   # fill in BUCKET_NAME etc.
npm install
npm run dev
```

If `BUCKET_NAME` is unset, or AWS credentials aren't available locally, the
fetch script logs a warning and falls back to an empty album list instead
of failing the build.

## Uploading photos / adding an album

No console clicking needed — just upload into a folder named after the
album:

```sh
aws s3 cp my-photo.jpg s3://<bucket>/photos/analog-camera/my-photo.jpg
```

or sync a whole local folder as one album:

```sh
aws s3 sync ./analog-camera-scans s3://<bucket>/photos/analog-camera/
```

The album shows up automatically next time the site is built — nothing
else to configure. A brand-new album folder with no photos in it yet just
won't appear on the homepage until the first image lands in it.

## AWS setup (one-time)

This is deployed with the bucket kept **fully private** and a CloudFront
distribution (with Origin Access Control) as the only thing that can read
it — rather than a public-read bucket policy + S3 website hosting. Slightly
more setup, but the bucket never has to be exposed directly.

### 1. Bucket

```sh
aws s3 mb s3://<bucket-name>
```

Leave "Block all public access" **on** (the default) — no bucket policy is
needed. Access is granted narrowly to CloudFront's Origin Access Control
instead, via the OAC bucket policy CloudFront generates when you attach it
to the distribution in the console (Origin settings → "Create OAC" → it
offers to update the bucket policy for you).

### 2. CloudFront distribution

- Origin: the bucket, using OAC (not the S3 website endpoint, and not
  "public bucket" access).
- Default root object: `index.html`.
- For HTTPS + a custom domain, attach an ACM certificate and your domain
  as an alternate domain name (CNAME), then point DNS at the distribution.

Because the origin is the bucket's REST API (via OAC) rather than the S3
website endpoint, CloudFront only auto-resolves `index.html` at the
distribution root — it will *not* resolve `/albums/foo/` to
`/albums/foo/index.html`. That's why this project builds flat `.html`
files (see the note in "How it works" above) instead of relying on
directory-index resolution.

After a deploy, cached pages won't reflect the new content until either
their cache TTL expires or you invalidate:

```sh
aws cloudfront create-invalidation --distribution-id <distribution-id> --paths "/*"
```

### 3. GitHub OIDC role for deploys

Create an IAM OIDC identity provider for `token.actions.githubusercontent.com`
(skip if one already exists in the account), then a role trusting it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<github-org>/<repo-name>:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

Attach a policy granting what the deploy needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<bucket-name>"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::<bucket-name>/photos/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<bucket-name>/*"
    }
  ]
}
```

The `GetObject` grant is scoped to `photos/*` only — the build reads a
small byte range of each photo to extract its EXIF date. `PutObject`/
`DeleteObject` are necessarily bucket-wide (IAM's `s3:prefix` condition key
only constrains `ListBucket` requests, not `PutObject`/`DeleteObject` — it
can't express "write anywhere except this folder"), so the guarantee that
a deploy never touches uploaded photos comes entirely from the workflow's
`--exclude "photos/*"` flag, not from IAM. Don't remove that flag from
`.github/workflows/deploy.yml`.

(Add `cloudfront:CreateInvalidation` on the distribution ARN if you set up
CloudFront and want cache invalidation on deploy.)

### 4. GitHub repository variables

Settings → Secrets and variables → Actions → **Variables** tab:

| Variable                     | Example                                                    |
| ----------------------------- | ------------------------------------------------------------ |
| `AWS_DEPLOY_ROLE_ARN`         | `arn:aws:iam::123456789012:role/photos-site-deploy`         |
| `AWS_REGION`                  | `us-east-1`                                                  |
| `BUCKET_NAME`                 | `photos.vassopoli.com`                                       |
| `PHOTOS_PREFIX`               | `photos/` (optional, this is the default)                    |
| `PUBLIC_URL_BASE`             | `https://xxxxxxxxxxxxxx.cloudfront.net` (your CloudFront domain — required, since the bucket itself isn't publicly readable) |
| `CLOUDFRONT_DISTRIBUTION_ID`  | enables cache invalidation on deploy (recommended, otherwise deploys can take a while to show up behind CloudFront's cache) |

Push to `main` and the workflow builds and deploys automatically.

## Project structure

```text
/
├── .github/workflows/deploy.yml     # CI build + deploy to S3
├── scripts/fetch-photos.mjs         # lists photos/ prefix -> src/data/albums.json
├── src/
│   ├── data/albums.json             # generated, gitignored
│   ├── layouts/Layout.astro
│   └── pages/
│       ├── index.astro              # album grid
│       └── albums/[slug]/index.astro  # one album's gallery
└── astro.config.mjs
```

## Commands

| Command           | Action                                          |
| ------------------ | ------------------------------------------------ |
| `npm install`       | Install dependencies                             |
| `npm run dev`       | Fetch albums, start dev server on `:4321`        |
| `npm run build`     | Fetch albums, build static site to `./dist/`     |
| `npm run preview`   | Preview the production build locally             |
