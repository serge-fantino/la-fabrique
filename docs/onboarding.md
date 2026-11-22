# Onboarding a project with Claude Code

This guide is for **Claude Code**, open on a project's repository and connected to La Fabrique's MCP server, when someone asks it to bring that project into La Fabrique. A new product, an empty repository or an existing code base all follow it. The aim is for the project's *Setup* tab to turn green while the project keeps its code, its stack and its hosting.

It was first written for roadwise-helper (a Vite/React single-page app built with Lovable, hosted on Netlify), then made general. Epic F13 (C140) is where it is going: La Fabrique will read the repository itself (C176), ask the person through a form (C146), and write this brief for each project.

## The rules

- **One pull request** on the production branch (or on `integration` if the project has one), from a branch `claude/onboarding`. Never push onto the production branch. The person reviews and merges.
- **Keep what is there**: the code, the stack and the hosting. Change only what *Setup* needs. A clean-up (files, lock files, old workflows) only happens after the person says yes.
- **Never ask for a secret's value**, and never write one. The steps that only a person can do go in a checklist at the end of the pull request, with their links.
- **Never skip, disable or weaken a test** to get green. A check that fails is said in the pull request.
- **Ask before you write**, and ask only what the files do not say.

## 1. Read what La Fabrique knows

- `projects`: the project in La Fabrique (repository, production branch, integration branch).
- `setup`: every *Setup* item, with its state (`done`, `missing`, `optional`, `unknown`), what La Fabrique found, why it matters and how to do it, plus this guide and the example workflow that fits the project. With `branch`, it reads another branch, such as your pull request's before its merge.

The format of `.fabrique.json` is in the `setup` items. The whole reference is La Fabrique's `docs/fabrique-json.md`.

## 2. Read what the repository has

Read the files themselves. Note each finding with the file it comes from, for the pull request.

| Look at | To find |
|---|---|
| The tree, `README.md` | Empty (a README at most) or existing; what the product does |
| `package.json`, `pyproject.toml`, `requirements.txt`, `pom.xml`, `go.mod`… | Language, framework, test runner and its script, other checks (types, lint) |
| Lock files | The package manager; two lock files (`package-lock.json` and `bun.lockb`) is a question for the person |
| `wrangler.jsonc`/`.toml`, `netlify.toml`, `vercel.json`, `amplify.yml`, a Pages workflow, addresses in the README | The hosting candidates (see below) |
| `vite.config.*` `base`, `package.json` `homepage`, the PWA manifest's `start_url` and `scope`, the service worker | Where the site is served from, which must match the production hosting |
| A server (Worker, API routes) or a static build (`dist/`, `build/`) | Version path (`/api/version`) or a `version.json` written at build |
| `.github/workflows/` | A CI that runs the tests on pull requests; deployments of branches that no longer exist or of a hosting that is not production |
| `CHANGELOG.md`, "What's new" in the README, tags | Past releases, to move into the release notes |
| `CLAUDE.md`, `docs/` | What to keep and link rather than copy |
| `lovable-tagger` in `package.json`/`vite.config`, lovable.dev links | Built with Lovable (step 4) |
| Large generated files (a code base concatenated into one Markdown file…) | A question for the person |

## 3. Ask the person

Ask in one message, with what you found, so each answer is quick:

1. **Production**: which hosting serves it (when there are several candidates), its address, the branch it deploys, its build command and folder. And whether there is a test environment (int) and its branch.
2. **The product's sentence**: draft it from the README, for `CLAUDE.md` and `.fabrique.json` > `description`.
3. **Language** of what La Fabrique writes in the project (`en`, `fr`): the language of the README by default.
4. **Past releases**: their dates are in the README or the tags. Their time is usually unknown, so propose `12:00`.
5. **Clean-ups** you would make, one by one.

## 4. The pull request

Do what the `setup` items say is missing, in this order. Run each check locally before you push.

1. **Serve from the production hosting's path.** For example, a `base: '/<repo>/'` left from GitHub Pages becomes `/` on Netlify, and the manifest and service worker follow. Build and preview locally to check that the app loads.
2. **Leave Lovable** if the project was built with it:
   - remove `lovable-tagger` (the dependency and its use in `vite.config`), and update the lock file;
   - remove the README's Lovable sections and the lovable.app address;
   - keep the code Lovable generated, which is the project's code now.

   Lovable pushes straight onto the production branch, outside any pull request. Disconnecting its GitHub sync is a step for the person.
3. **Release notes** in the Fabrique format: `docs/release-notes.json`, newest first.
   - Move each past release into it (`version`, `date`, `heure`, `titre`, `changements` in plain words, `stories: []`, `liens: null`).
   - Add one entry for this onboarding, the next version. An entry without `heure` is not released yet. With no integration branch and no merge workflow (`workflows.fusionner`), date this entry as the last commit before the merge.
   - This is temporary. La Fabrique is moving every project to one release-notes tool, the same file copied into each project (`kit/release-notes.js`, declared in `version.outil`). With it, a pull request writes its entry as `next`, the merge workflow numbers it, and the release-notes file is no longer a point of conflict between pull requests. Once it is there, the onboarding pull request copies the tool and the merge workflow instead of dating by hand.
   - Keep the README's "What's new" as a link to the file, not a copy.
4. **The version served**, the same as the first released entry:
   - a server answers its version path (`/api/version`) with `{"numero": "0.3", "environnement": "production"}`;
   - a static site writes `version.json` at its root at build time, from the release notes, without a new dependency (for example a small Vite plugin);
   - `environnement` is `production` only on the production build;
   - showing the same number in the app is a plus.
5. **CI** (`.github/workflows/ci.yml`), on every pull request and push to the production branch:
   - install from the lock file;
   - run the project's own checks (types, lint), its tests and its build;
   - then check that the served version equals the first released entry of the release notes.
6. **The `claude` workflow** (`.github/workflows/claude.yml`), adapted from the example `setup` gives (`examples`): La Fabrique's own for a project without integration, L'épicerie's for a project with one:
   - it runs on `workflow_dispatch` with `issue`, `par` and `pr`, and is named `run-name: "Claude #${{ inputs.issue }}"`;
   - it creates a branch `claude/<issue>-<subject>` linked to the issue, and opens a pull request `Refs #<issue>` with a line per acceptance criterion;
   - it never pushes onto the production branch;
   - it uses the secrets `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) and `FABRIQUE_TOKEN`, and `allowed_bots: la-fabrique-extraordinaire`.
7. **`CLAUDE.md`**, short:
   - the product's sentence, the stack, how to run, test and build;
   - the conventions: every change starts from a card in La Fabrique and its story (an issue); one pull request per story; a release-notes entry that lists its `stories`; never push onto the production branch;
   - links to the existing docs, which are not copied.
8. **`.fabrique.json`** at the root, last, from what is now true:

   ```json
   {
     "nom": "<name>",
     "description": "<the product's sentence>",
     "langue": "en",
     "branches": { "production": "<branch>", "travail": ["claude/*", "feature/*"] },
     "environnements": {
       "production": { "url": "<address>", "version": "/version.json", "type": "production", "signalement": false }
     },
     "workflows": { "ci": "ci.yml", "claude": "claude.yml", "promouvoir": null },
     "version": { "fichier": "docs/release-notes.json", "forme": "0.N" },
     "documentation": [
       { "titre": "The project", "chemin": "CLAUDE.md" },
       { "titre": "Read me", "chemin": "README.md" }
     ],
     "cycle": { "pret": ["criteres"], "priorites": ["P1", "P2", "P3"] },
     "demandes": {
       "etiquettes": { "demande": "request", "prete": "ready-for-claude", "a_valider": "to-validate" },
       "rubriques": [
         { "cle": "context", "titre": "Context", "obligatoire": true, "aide": "What happens today, and why it is not good enough." },
         { "cle": "need", "titre": "Need", "obligatoire": true, "aide": "What the user must be able to do." },
         { "cle": "criteria", "titre": "Acceptance criteria", "obligatoire": true, "aide": "One line per criterion, checkable in the app." },
         { "cle": "questions", "titre": "Open questions", "aide": "What remains to decide." }
       ]
     }
   }
   ```

   A server's version path is `/api/version`. A project with int adds `branches.integration`, the int environment (`"type": "integration"`) and its deployment workflow.

Not in this pull request (later, from *Setup* or the sprint): the merge and release workflows (`fusionner`, `publier`), the report kit, an int environment.

### By hosting

La Fabrique never holds a hosting token. The hosting deploys by itself from the repository, or a workflow of the project does it with the project's own secret.

| Hosting | Deploys | Version |
|---|---|---|
| Cloudflare Workers | Workers Builds, on each push to the production branch | A route of the Worker (`/api/version`) |
| Cloudflare Pages, Netlify, Vercel | Their Git integration, on each push to the production branch | `version.json` written at build |
| AWS Amplify | Its Git integration | `version.json` written at build |
| AWS S3 + CloudFront, a server of your own | A workflow of the project, with its own secret | `version.json`, or a route of the server |
| GitHub Pages | A Pages workflow; the site lives under `/<repo>/` | `/<repo>/version.json` |

## 5. The pull request's description

- What changed, file by file, and the result of each check run locally.
- What you found and what the person answered.
- **What only the person can do**, as a checklist:
  - [ ] in Lovable, if any: disconnect the GitHub sync;
  - [ ] in the hosting: check the branch, the build command and folder, and that `<address><version path>` answers after the merge;
  - [ ] in the repository's secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) and `FABRIQUE_TOKEN` (fine-grained, this repository only: Contents, Pull requests and Issues read and write);
  - [ ] in La Fabrique: open the project's *Setup*.

## 6. Then

- Before the merge, use `setup` with `branch: "claude/onboarding"` to see what your pull request turns green.
- After the merge and the deployment, use `setup` again: what is still missing is said there.
- **The next change starts from a card**: `card_create`, then `card_spec`, then `stories_create`, then Claude on the story. A change without its story cannot be traced. On roadwise-helper, the first change after the onboarding went out as version 0.4 with `"stories": []`.
- Tell the person what this guide did not say, so it can be added.

## Worked example: roadwise-helper

Pull request #4 of `serge-fantino/roadwise-helper` (version 0.3):
- served from `/` instead of `/roadwise-helper/`;
- Lovable left;
- `export.md`, `bun.lockb` and the GitHub Pages workflow removed;
- the README's "What's new" moved into `docs/release-notes.json`;
- `version.json` written by a Vite plugin;
- a CI that runs the type check, lint, tests and build, then compares `dist/version.json` with the release notes;
- `claude.yml`, `CLAUDE.md` and `.fabrique.json`.

Its production stayed on Netlify. The next pull request (#5, version 0.4) showed the same number on the splash screen.
