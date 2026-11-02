# Release notes and What's new

How La Fabrique keeps its own release notes, as a component.

- The file: [`docs/release-notes.json`](../../docs/release-notes.json), its format in [`docs/fabrique-json.md`](../../docs/fabrique-json.md#notes-de-version-format-fabrique).
- Numbering at the merge: `scripts/release-at-merge.ts` and `src/release-merge.ts`, run by `.github/workflows/merge.yml`.
- The release of a sprint (the `next` entries grouped into one version): `scripts/publish-release.ts` and `src/release-publish.ts`, run by `.github/workflows/release.yml`.
- The page: `src/whats-new.ts` (`/whats-new`).
- The checks: `test/self.test.ts`.

L'épicerie extraordinaire has its own implementation of the same idea (`site/static/nouveautes.json`, `scripts/dater_version.py`, `scripts/verifier_version.py`), in Python, with entries without time until the go.
