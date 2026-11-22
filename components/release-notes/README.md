# Release notes and What's new

One release-notes file per project, and one tool that writes it, the same for every project La Fabrique pilots,
La Fabrique included.

- The file: [`docs/release-notes.json`](../../docs/release-notes.json), its format in [`docs/fabrique-json.md`](../../docs/fabrique-json.md#notes-de-version-format-fabrique).
- The tool: [`kit/release-notes.js`](../../kit/release-notes.js) (`merge` at each merge, `publish` at the release of a sprint), plain JavaScript without dependency, its version on its first line; served at `/kit/release-notes.js`, how to set it up in [`docs/release-notes-kit.md`](../../docs/release-notes-kit.md). A project copies it as it is and declares where (`.fabrique.json` > `version.outil`): L'épicerie in `scripts/fabrique/release-notes.mjs` (merges into integration, `--mode number`), RoadWise in `scripts/fabrique/release-notes.js` (`--mode next`, then `publish`).
- La Fabrique's workflows, the examples for a project without integration branch: `.github/workflows/merge.yml` (`--mode next`) and `.github/workflows/release.yml` (`publish`); with an integration branch: L'épicerie's `fusionner.yml` (`docs/exemples/fusionner.yml`). `scripts/release-at-merge.ts` and `scripts/publish-release.ts` run the same tool by hand.
- The page: `src/whats-new.ts` (`/whats-new`).
- The checks: `test/self.test.ts`, and the tool's own tests in `test-scripts/release-notes.test.ts`.

L'épicerie makes its release at the go, in its own promotion workflow (`scripts/dater_version.py`: the entries without time become one version); its checks are `scripts/verifier_version.py`.
