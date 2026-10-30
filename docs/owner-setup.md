# Owner setup

One-time steps to run the La Fabrique extraordinaire Worker in production. Only the
repository owner (or someone with Cloudflare and GitHub admin rights) does
this. Code never carries any identifier or secret &mdash; everything lives in
Cloudflare secrets and GitHub Actions secrets.

## 1. Create the Cloudflare resources

Prerequisite: a Cloudflare account and `wrangler` logged in locally
(`npx wrangler login`).

```bash
# From the repo root.
npx wrangler d1 create la-fabrique-db
```

Copy the `database_id` printed by that command and paste it into
`wrangler.jsonc`, replacing the placeholder `00000000-0000-0000-0000-000000000000`
on the `d1_databases[0].database_id` line.

The Worker itself (`la-fabrique`) is created on the first deploy; no manual
step is required.

## 2. Add the GitHub Actions secrets

The deploy workflow (`.github/workflows/deploy.yml`) needs two secrets on
the repository (`Settings &rarr; Secrets and variables &rarr; Actions`):

| Name                   | Where to find it                                  |
| ---------------------- | ------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard &rarr; My Profile &rarr; API Tokens. |
| `CLOUDFLARE_ACCOUNT_ID`| Cloudflare dashboard &rarr; any domain &rarr; right sidebar. |

Minimum token scope: *Account &rarr; Workers Scripts &rarr; Edit*,
*Account &rarr; D1 &rarr; Edit*.

## 3. First deploy

Every push to `main` runs the `deploy` workflow:

1. `npm ci`, typecheck, tests.
2. `wrangler d1 migrations apply la-fabrique-db --remote` &mdash; applies
   pending migrations first, so new code never runs on an old schema
   (migrations must stay additive).
3. `wrangler deploy` &mdash; publishes the Worker with the commit SHA.

Visit `https://la-fabrique.<your-subdomain>.workers.dev/api/version`; it
should answer with the deployed commit SHA.

## 4. GitHub sign-in (F0.2)

### Create the GitHub App

GitHub &rarr; Settings &rarr; Developer settings &rarr; GitHub Apps &rarr;
*New GitHub App*:

| Field | Value |
| --- | --- |
| GitHub App name | `La Fabrique extraordinaire` (must be unique on GitHub; renaming it later changes nothing else) |
| Homepage URL | `https://la-fabrique.<your-subdomain>.workers.dev` |
| Callback URL | `https://la-fabrique.<your-subdomain>.workers.dev/auth/callback` (add one line per address you use, e.g. a custom domain later) |
| Expire user authorization tokens | checked |
| Request user authorization (OAuth) during installation | unchecked |
| Enable Device Flow | unchecked |
| Webhook &rarr; Active | unchecked for now (webhooks arrive with F0.3) |
| Where can this GitHub App be installed? | Only on this account |

Repository permissions (the minimum, from `CLAUDE.md`): Metadata read,
Contents read, Issues read and write, Pull requests read, Actions read and
write, Checks read. No account or organization permission.

After creating it, on the App page: note the **Client ID**, then
*Generate a new client secret*. Then *Install App* on the pilot repository
(`epicerie-extraordinaire`); sign-in itself does not need it, F0.3 does.

### Give the Worker its secrets

```bash
npx wrangler secret put GITHUB_APP_CLIENT_ID      # the Client ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET  # the client secret
npx wrangler secret put SUPER_ADMINS              # your GitHub login(s), comma-separated
```

Secrets survive deploys. Until the two GitHub App secrets are set,
*Sign in with GitHub* answers "Sign-in unavailable".

### Grant roles

Sign in with an account listed in `SUPER_ADMINS`, open **People**, and add
GitHub logins with a role. Someone who signs in without a role sees "No
access yet"; their request appears under **Access requests** on the People
page. Every change is written to the activity log.

## 5. Projects (F0.3)

La Fabrique reads a project's repository as the GitHub App itself
(installation tokens), so it needs the App's private key, and it listens
to pushes through the App's webhook.

On the GitHub App's settings page:

1. **Private key**: *Generate a private key*; a `.pem` file downloads.
2. **Webhook**: tick *Active*, set the URL to
   `https://la-fabrique.<your-subdomain>.workers.dev/api/github/webhook`,
   and set a *Webhook secret* (any long random string, for example
   `openssl rand -hex 32`).
3. **Permissions & events &rarr; Subscribe to events**: tick *Push*, and for
   the stories board (F0.5) *Issues*, *Sub issues*, *Pull request*, *Create*
   and *Delete*.
4. Make sure the App is installed on the repositories to pilot.

Then give the Worker the two new secrets:

```bash
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < path/to/la-fabrique.private-key.pem
npx wrangler secret put GITHUB_APP_WEBHOOK_SECRET   # the webhook secret
```

The key is used as GitHub gives it (PKCS#1); nothing to convert. Delete
the downloaded `.pem` once the secret is set.

Then, as a super admin: **Projects &rarr; Add a project**, pick the
repository. Its page shows the `.fabrique.json` status; every push to its
production branch re-checks the file.

## 6. Later

A custom domain (for example `fabrique.epicerieextraordinaire.com`) is
attached from the Workers dashboard; add its `/auth/callback` to the GitHub
App's callback URLs.

## Local development

```bash
cp .dev.vars.example .dev.vars        # fill in only what you need locally
npm install
npm run migrations:local              # applies migrations to a local D1
npm run dev                            # http://localhost:8787
npm run typecheck                      # strict TypeScript
npm test                               # Vitest with the Workers pool
```
