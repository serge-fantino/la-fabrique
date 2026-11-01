# The report kit

A **Report a defect** button for a project's own app. The person picks the part of the page that is wrong, writes two lines, and La Fabrique opens the issue in their name: page, version, the part chosen, screen, browser, recent errors and, optionally, a screenshot. It works on any project linked to La Fabrique (*Setup → Connected app*).

The kit has two halves:

- **In the browser**: three files you copy into your app and serve yourself, with no dependency. They talk only to your own server, never to La Fabrique, and hold no token. A strict security policy (`script-src 'self'`, `connect-src 'self'`) is enough.
- **On your server**: a small relay with two routes. It keeps the person's La Fabrique token, adds what only the server knows (environment, version) and forwards the report to La Fabrique.

## 1. Copy the files

| File | What it does |
|---|---|
| [`fabrique-report.js`](/kit/fabrique-report.js) | The kit: picking a part, the form, sending, the queue when offline. About 30 KB, no dependency. |
| [`fabrique-report.css`](/kit/fabrique-report.css) | Its styles, all prefixed `fab-rep-`; colours and shapes in custom properties. |
| [`fabrique-report-early.js`](/kit/fabrique-report-early.js) | Optional: keeps the page's errors from the start, so a report carries those that happened before the kit was loaded. |

Copy them as they are (for instance into `vendor/fabrique/`); each starts with its version.

Keep the names as they are, without a version in them: declare the folder in `.fabrique.json` (`"application": { "kit": "vendor/fabrique" }`) and La Fabrique's *Setup* shows the version the project has against the latest, and proposes the update as a pull request (on the integration branch, under the name of the person who asks; the project reviews it, tries it and merges it). When a version also needs a change in the relay, the pull request says so.

## 2. Load the kit

Only where reporting makes sense: never in production.

The simplest, with its own floating button, shown when the relay says the person can report:

```html
<link rel="stylesheet" href="/vendor/fabrique/fabrique-report.css" />
<script src="/vendor/fabrique/fabrique-report.js" data-endpoint="/api/fabrique/report" data-button="true" defer></script>
```

Or from your own button, loading the kit only when it is used:

```js
await loadScript("/vendor/fabrique/fabrique-report.js"); // and the stylesheet
FabriqueReport.start({
  endpoint: "/api/fabrique/report",
  lang: "fr",
  headers: () => ({ "X-CSRF": csrfToken }),
  captureScript: "/vendor/html2canvas.min.js",
});
```

Options (`FabriqueReport.configure`, `start`, or the `data-` attributes of the script tag):

| Option | Data attribute | Meaning |
|---|---|---|
| `endpoint` | `data-endpoint` | The relay's address on your server. Required. |
| `lang` | `data-lang` | `en` or `fr`; by default the page's `lang`. |
| `headers` | — | Headers to add to the relay calls (an object, or a function returning one): a CSRF token. |
| `captureScript` | `data-capture-script` | Address of [html2canvas](https://html2canvas.hertzen.com/) on your site (MIT, copy it too). With it, the form offers a screenshot of the part chosen, shown before sending. Without it, the person can attach an image. |
| `capture` | — | Your own screenshot function instead: `(element) => Promise<dataURL>`. |
| `button` | `data-button` | `true`: a floating button, shown when the relay answers `can_report: true`. |
| `environment`, `version`, `deployment` | `data-environment` | Sent with the report; better set by the relay, which knows them. |

API: `FabriqueReport.start()` (picking, then the form; resolves with the result, or `null` if cancelled), `status()` (the relay's `GET`), `flush()` (sends the reports kept offline; done at load and when the network is back), `errors()`, `version`.

What it is about: the form asks the person what the defect is about (**It is about**): the release notes in detail, the versions on int first, then those released, newest first. Under each version, each of its changes can be chosen, then the stories it declares; a search finds an older one; **I don't know** is always possible. When a single story is on int, it is chosen already.

Picking: the person touches or clicks a part; **Wider** goes to the enclosing part, **This one** confirms, **The whole page**, **Cancel** (or Escape). While picking, the page does not react to presses; it still scrolls.

Styles: change `--fab-rep-ink`, `--fab-rep-paper`, `--fab-rep-muted`, `--fab-rep-line`, `--fab-rep-accent`, `--fab-rep-radius`, `--fab-rep-font`, and `--fab-rep-bottom` (to stay above a bottom bar), on `.fab-rep`.

## 3. The relay on your server

Two routes at the address you chose, for a signed-in person of your app, outside production only.

**`GET`**: what the person can do.

```json
{ "linked": true, "can_report": true, "login": "octocat", "link_url": "/auth/fabrique/link" }
```

`can_report` is `can.report_defect` of La Fabrique's `GET /api/me`. Not linked: `{ "linked": false, "can_report": false, "can_test": false, "link_url": "…" }`.

**Testing (kit 1.3.0).** To let a tester read the stories to test without leaving the app, the relay:

1. asks for the scope `stories:test` next to `defects:report` when it sends the person to `/oauth/authorize` (the consent page says what it allows; *Connected apps* shows it). A link made before keeps only `defects:report`: the person links again;
2. answers `"can_test": true` in its `GET` when `can.test_stories` of `GET /api/me` is true (the scope was allowed, the person's role may validate, and the project has an environment open to the kit); the kit then shows **Test** next to **Report a defect**;
3. answers **`GET ?to-test=1`** with La Fabrique's `GET {FABRIQUE_URL}/api/projects/{project}/to-test` (with the person's token), outside production only:

```json
{ "stories": [
  { "number": 146, "title": "…", "url": "…", "card": { "id": 17, "title": "…" },
    "criteria": [{ "text": "…", "done": true }, { "text": "…", "done": false }],
    "validated": { "by": "tess", "at": "2026-10-31T09:00:00.000Z", "version": "1.170" } } ] }
```

The stories are those on int that wait to be tested (epics and defects left out); `card` and `validated` are `null` when there is none. `403` when the person may not validate (`not_allowed`), the app was not allowed the scope (`insufficient_scope`) or the environment is closed (`testing_disabled`). The panel is read only: it shows the stories one at a time with their criteria; ticking and validating stay in La Fabrique. Without this route, the panel says the stories could not be read.

**`GET ?targets=1`**: what a report can be about, passed through from La Fabrique's `GET {FABRIQUE_URL}/api/projects/{project}/targets` (with the person's token).

```json
{ "versions": [
  { "version": "1.170", "title": "Weekly menu", "changes": ["…"], "on_int": true, "date": null,
    "stories": [{ "number": 146, "title": "…", "url": "…" }] },
  { "version": "1.169", "title": "…", "changes": ["…"], "on_int": false, "date": "2026-10-30", "stories": [] } ] }
```

The versions are the project's release notes: the entries on int, then those released. Each carries the stories its entry declares in `stories` ([format](/guide/fabrique-json#notes-de-version-format-fabrique)); an entry that does not declare them has none. Without this route, the kit simply does not ask.

**`POST`**: the report, as the kit sends it.

```json
{ "title": "…", "seen": "…", "expected": "…", "page": "/app/…",
  "component": { "selector": "…", "text": "…", "box": { "x": 0, "y": 0, "w": 0, "h": 0 } },
  "viewport": { "w": 390, "h": 844, "dpr": 3 }, "user_agent": "…", "errors": ["…"],
  "screenshot": "data:image/png;base64,…", "story": 146, "release": "1.170", "change": 2 }
```

`story`, `release` and `change` are what the person chose (all optional; `change` is the index of a change in that version's `changes`). La Fabrique links the issue to that story, says which version it is about and quotes the change; a change of a version that declares a single story links that story; when the person says nothing, it links the only story the versions on int declare, if there is one.

The relay:

1. checks the person is signed in, the request is theirs (CSRF), and the environment is not production;
2. sets `environment` (the name of this environment in `.fabrique.json`, which its version path answers), `version` and `deployment`: the kit's values are never trusted for these;
3. sends it to `POST {FABRIQUE_URL}/api/projects/{project}/defects` with the person's access token (renewed with the refresh token when it expires);
4. answers with La Fabrique's status and body: `201 { issue: { number, url }, story, triage }`, or `400`, `401` (the link is no longer valid: forget it, and answer `link_url`), `403`, `429`.

A request body can reach 3 MB with a screenshot.

A relay for a Cloudflare Worker, where `link` is what your app keeps of the person's link (tokens on the server only):

```ts
async function relay(request: Request, env: Env, link: { access: string }, project: string): Promise<Response> {
  if (env.ENVIRONMENT === "production") return Response.json({ error: "reporting_disabled" }, { status: 403 });
  const report = (await request.json()) as Record<string, unknown>;
  report.environment = env.ENVIRONMENT; // e.g. "int"
  report.version = await currentVersion(env);
  const response = await fetch(`${env.FABRIQUE_URL}/api/projects/${project}/defects`, {
    method: "POST",
    headers: { authorization: `Bearer ${link.access}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
}
```

On Cloudflare, a Worker calling another Worker of the same account through its `workers.dev` address needs the `global_fetch_strictly_public` compatibility flag.

## What La Fabrique checks

The project's `.fabrique.json` declares the environment with `"signalement": true` (read on the branch deployed there), its version path answers the same `environnement`, the person may report on the project, and at most 20 reports a day per account and project. See [the .fabrique.json format](/guide/fabrique-json#signaler-un-défaut-depuis-lapp-du-projet) and the contract in la-fabrique#65.
