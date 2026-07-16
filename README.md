# photos.vassopoli.com

Photography portfolio. An Astro static site pulls its photo list from a
private S3 bucket at build time; GitHub Actions builds and deploys the site
to another S3 bucket that serves it as a static website.

## How it works

- **Site bucket** — public, hosts the built static site (S3 static website
  hosting, optionally behind CloudFront for HTTPS/custom domain).
- **Photos bucket** — holds the source images. In this first version it has
  a public-read bucket policy (`s3:GetObject` only) so the built pages can
  link straight to object URLs; no auth in front of it yet.
- **Build** — `scripts/fetch-photos.mjs` lists the photos bucket
  (`s3:ListBucket`) and writes `src/data/photos.json`, which the homepage
  renders as a grid. This runs automatically before both `npm run dev` and
  `npm run build`.
- **Deploy** — [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  builds the site and runs `aws s3 sync` to the site bucket on every push to
  `main`. It authenticates to AWS via GitHub's OIDC provider assuming an IAM
  role — no long-lived AWS keys stored in the repo.

## Local development

Requires Node 22+.

```sh
cp .env.example .env   # fill in PHOTOS_BUCKET_NAME etc.
npm install
npm run dev
```

If `PHOTOS_BUCKET_NAME` is unset, or AWS credentials aren't available
locally, the fetch script logs a warning and falls back to an empty gallery
instead of failing the build.

## AWS setup (one-time)

### 1. Photos bucket

```sh
aws s3 mb s3://<photos-bucket-name>
```

Bucket policy (public read of objects only — no listing, no writes):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<photos-bucket-name>/*"
    }
  ]
}
```

Disable "Block all public access" for this bucket only (needed for the
policy above to take effect), and upload photos into it however you like
(console, `aws s3 sync`, etc).

> This is the v1, no-auth setup. To make the bucket actually private later,
> remove the public policy, put CloudFront in front of it with an Origin
> Access Control, and switch `PHOTOS_PUBLIC_URL_BASE` to the CloudFront
> domain plus signed URLs/cookies.

### 2. Site bucket

```sh
aws s3 mb s3://<site-bucket-name>
aws s3 website s3://<site-bucket-name> --index-document index.html --error-document index.html
```

Bucket policy (public read, needed for S3 static website hosting):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<site-bucket-name>/*"
    }
  ]
}
```

For HTTPS and a custom domain, put a CloudFront distribution in front of
this bucket and point DNS at it — S3 website endpoints alone only serve
plain HTTP.

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

Attach a policy granting only what the deploy needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::<photos-bucket-name>",
        "arn:aws:s3:::<photos-bucket-name>/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::<site-bucket-name>",
        "arn:aws:s3:::<site-bucket-name>/*"
      ]
    }
  ]
}
```

(Add `cloudfront:CreateInvalidation` on the distribution ARN if you set up
CloudFront and want cache invalidation on deploy.)

### 4. GitHub repository variables

Settings → Secrets and variables → Actions → **Variables** tab:

| Variable                     | Example                                             |
| ----------------------------- | ---------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`         | `arn:aws:iam::123456789012:role/photos-site-deploy`  |
| `AWS_REGION`                  | `us-east-1`                                          |
| `SITE_BUCKET_NAME`            | `photos.vassopoli.com`                               |
| `PHOTOS_BUCKET_NAME`          | `photos.vassopoli.com-originals`                     |
| `PHOTOS_PUBLIC_URL_BASE`      | (optional) CloudFront domain for photos, if used     |
| `CLOUDFRONT_DISTRIBUTION_ID`  | (optional) enables cache invalidation on deploy       |

Push to `main` and the workflow builds and deploys automatically.

## Project structure

```text
/
├── .github/workflows/deploy.yml   # CI build + deploy to S3
├── scripts/fetch-photos.mjs       # lists the photos bucket -> src/data/photos.json
├── src/
│   ├── data/photos.json           # generated, gitignored
│   ├── layouts/Layout.astro
│   └── pages/index.astro          # gallery
└── astro.config.mjs
```

## Commands

| Command           | Action                                          |
| ------------------ | ------------------------------------------------ |
| `npm install`       | Install dependencies                             |
| `npm run dev`       | Fetch photo list, start dev server on `:4321`    |
| `npm run build`     | Fetch photo list, build static site to `./dist/` |
| `npm run preview`   | Preview the production build locally             |
