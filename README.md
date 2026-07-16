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
  and writes `src/data/albums.json`, which the pages render statically.
  This runs automatically before both `npm run dev` and `npm run build`.
- **Deploy** — [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  builds the site and runs `aws s3 sync --delete --exclude "photos/*"` on
  every push to `main`. The `--exclude` is what makes sharing one bucket
  safe: the deploy only ever touches the site files, never the photos
  folder. Auth is via GitHub's OIDC provider assuming an IAM role — no
  long-lived AWS keys stored in the repo.
- **Access** — v1 has no auth: the whole bucket is public-read
  (`s3:GetObject`), so pages link straight to object URLs. Fine for now,
  since you asked for the simpler single-bucket setup.

> If you later want the photos private, splitting them into their own
> bucket behind CloudFront + signed URLs is the cleanest path — the
> `PHOTOS_PREFIX`/`PUBLIC_URL_BASE` env vars exist so that split doesn't
> require rewriting the album logic, just pointing them at a different
> bucket/domain.

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

### 1. Bucket

```sh
aws s3 mb s3://<bucket-name>
aws s3 website s3://<bucket-name> --index-document index.html --error-document index.html
```

Bucket policy (public read of everything in the bucket — required both for
S3 static website hosting to serve the site and for photo URLs to work):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<bucket-name>/*"
    }
  ]
}
```

Disable "Block all public access" for this bucket (needed for the policy
above to take effect).

For HTTPS and a custom domain, put a CloudFront distribution in front of
the bucket and point DNS at it — the S3 website endpoint alone only serves
plain HTTP.

### 2. GitHub OIDC role for deploys

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

Attach a policy granting only what the deploy needs — note it does **not**
include `s3:DeleteObject` on the `photos/*` path, so a broken workflow run
can't wipe your photos even if the `--exclude` were ever removed by mistake:

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
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<bucket-name>/*",
      "Condition": {
        "StringNotLike": {
          "s3:prefix": "photos/*"
        }
      }
    }
  ]
}
```

(Add `cloudfront:CreateInvalidation` on the distribution ARN if you set up
CloudFront and want cache invalidation on deploy.)

### 3. GitHub repository variables

Settings → Secrets and variables → Actions → **Variables** tab:

| Variable                     | Example                                             |
| ----------------------------- | ---------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`         | `arn:aws:iam::123456789012:role/photos-site-deploy`  |
| `AWS_REGION`                  | `us-east-1`                                          |
| `BUCKET_NAME`                 | `photos.vassopoli.com`                               |
| `PHOTOS_PREFIX`               | `photos/` (optional, this is the default)            |
| `PUBLIC_URL_BASE`             | (optional) CloudFront domain, if you add one         |
| `CLOUDFRONT_DISTRIBUTION_ID`  | (optional) enables cache invalidation on deploy       |

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
