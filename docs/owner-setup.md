# Owner setup

One-time steps to run the La Fabrique Worker in production. Only the
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

Merge the F0.1 PR into `main`. The `deploy` workflow runs:

1. `npm ci`, typecheck, tests.
2. `wrangler deploy` &mdash; publishes the Worker with the merge-commit SHA.
3. `wrangler d1 migrations apply la-fabrique-db --remote` &mdash; applies the
   initial schema.

Visit `https://la-fabrique.<your-subdomain>.workers.dev/api/version`; it
should answer with the deployed commit SHA.

## 4. Later lots

- **F0.2 (GitHub login, roles).** Create the GitHub App *La Fabrique* with
  the permissions listed in `CLAUDE.md`, install it on the pilot repository,
  and add its credentials to the Worker as secrets (`wrangler secret put`
  for each entry listed in `.dev.vars.example`).
- A custom domain (for example `fabrique.epicerieextraordinaire.com`) is
  attached from the Workers dashboard once the first deploy succeeds.

## Local development

```bash
cp .dev.vars.example .dev.vars        # fill in only what you need locally
npm install
npm run migrations:local              # applies migrations to a local D1
npm run dev                            # http://localhost:8787
npm run typecheck                      # strict TypeScript
npm test                               # Vitest with the Workers pool
```
