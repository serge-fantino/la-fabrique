# Report a defect and test from the app

The report kit of La Fabrique, as a component: the browser half lives in [`/kit`](../../kit) (served by La Fabrique at `/kit/…` for the projects to copy), the server half is the project's own relay, written once.

- How to install it in a project: [`docs/report-kit.md`](../../docs/report-kit.md) (also at `/guide/report-kit`).
- The contract with the projects (addresses, fields, answers): la-fabrique#65 and its amendments.
- La Fabrique's side of the API: `src/defects.ts`, `src/to-test-api.ts`, `src/relay.ts`, `src/defect-targets.ts`.

Taken by L'épicerie extraordinaire in `site/static/vendor/fabrique/` (`application.kit`), with its relay in `worker/fabrique.ts`.
