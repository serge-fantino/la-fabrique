# The report kit

A **Report a defect** button for a project's own app. The person picks the part of the page that is wrong, writes two lines, and La Fabrique opens the issue in their name: page, version, the part chosen, screen, browser, recent errors and, optionally, a screenshot. It works on any project linked to La Fabrique (*Setup → Connected app*).

The kit has two halves:

- **In the browser**: three files you copy into your app and serve yourself, with no dependency. They talk only to your own server, never to La Fabrique, and hold no token. A strict security policy (`script-src 'self'`, `connect-src 'self'`) is enough.
- **On your server**: a small relay, written once (protocol 2). It keeps the person's La Fabrique token, adds what only the server knows (environment, version, deployment) and passes each call of the kit to La Fabrique.

## 1. Copy the files

| File | What it does |
|---|---|
| [`fabrique-report.js`](/kit/fabrique-report.js) | The kit: picking a part, the form, sending, the queue when offline. About 30 KB, no dependency. |
| [`fabrique-report.css`](/kit/fabrique-report.css) | Its styles, all prefixed `fab-rep-`; colours and shapes in custom properties. |
| [`fabrique-report-early.js`](/kit/fabrique-report-early.js) | Optional: keeps the page's errors from the start, so a report carries those that happened before the kit was loaded. |

Copy them as they are (for instance into `vendor/fabrique/`); each starts with its version.

Keep the names as they are, without a version in them: declare the folder in `.fabrique.json` (`"application": { "kit": "vendor/fabrique" }`) and La Fabrique's *Setup* shows the version the project has against the latest, and proposes the update as a pull request (on the integration branch, under the name of the person who asks; the project reviews it, tries it and merges it). When a version also needs a change in the relay, the pull request says so.

## 2. Load the kit

Where the project opens it in `.fabrique.json` (la-fabrique#209): reporting on the environments whose `signalement` says who may report (`"equipe"`, the accounts with a role; `"comptes"`, any account that sees the repository), production included when it says so; testing on the test environment only (`recette`: int, or production for a project without an integration branch). La Fabrique checks both on each call; the relay may stay closed on an environment where the project does not want the button at all.

The simplest, with its own launcher (kit 1.7.0): a small round button with La Fabrique's mark, shown when the relay says the person can report or test. A tap unfolds it into **Report a defect** and **Test**; the person can drag it elsewhere, and its place is kept on the device:

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
| `button` | `data-button` | `true`: the launcher (1.7.0), shown when the relay answers `can_report` or `can_test`. |
| `environment`, `version`, `deployment` | `data-environment` | Sent with the report; better set by the relay, which knows them. |

API: `FabriqueReport.start()` (picking, then the form; resolves with the result, or `null` if cancelled), `test()` (the Test panel), `launcher(options)` (the launcher, from your own code: it asks the relay what the person may do, then shows itself or not), `status()` (the relay's `GET`), `flush()` (sends the reports kept offline; done at load and when the network is back), `errors()`, `version`.

The Test panel (1.7.0) floats above the app and never blocks it: the person drags it by its head, folds it into a bar (the story and how many criteria are ticked) and closes it; its place and state are kept on the device, and since 1.8.0 it stays open from one page of the app to the next, at the same story, with the feedback being written (la-fabrique#207); closed, it stays closed. Each story says its feature, a link to the card in La Fabrique. On a phone it takes half the screen at most. It goes through the stories waiting on int (Previous, Next), then lists the story's criteria, each a box and its text, with **Record** (the steps) and **Fail**: a feedback written in the panel (what happened instead, a screenshot of the page if wanted). A feedback is not a new issue: La Fabrique writes it as a comment on the story, in the tester's name, quoting the criterion, and the story goes back to development (the rework label, `demandes.etiquettes.retour`); the criterion stays unticked and shows **Failed**, and the story cannot be validated until its code changed and it is tested again. Nothing is launched by itself: a person reworks the story with its feedbacks.

What it is about: the form asks the person what the defect is about (**It is about**): the release notes in detail, the versions on int first, then those released, newest first. Under each version, each of its changes can be chosen, then the stories it declares; a search finds an older one; **I don't know** is always possible. When a single story is on int, it is chosen already.

Picking: the person touches or clicks a part; **Wider** goes to the enclosing part, **This one** confirms, **The whole page**, **Cancel** (or Escape). While picking, the page does not react to presses; it still scrolls.

Styles: change `--fab-rep-ink`, `--fab-rep-paper`, `--fab-rep-muted`, `--fab-rep-line`, `--fab-rep-accent`, `--fab-rep-radius`, `--fab-rep-font`, and `--fab-rep-bottom` (to stay above a bottom bar), on `.fab-rep`.

## 3. The relay on your server

**Write the generic relay (protocol 2, kit 1.6.0 and later, la-fabrique#195).** Written once, it passes every call of the kit to La Fabrique, so a new kit version is only an update of the files from *Setup*: no new route. The former relay, a route per call (protocol 1, described after it), still works.

### The generic relay (protocol 2)

One address (the kit's `endpoint`), for a signed-in person of your app, on the environments `.fabrique.json` opens to reporting or testing.

**`GET {endpoint}`**: what the person can do, from La Fabrique's `GET {FABRIQUE_URL}/api/me` with the person's token.

```json
{ "relay": 2, "linked": true, "login": "octocat", "link_url": "/auth/fabrique/link",
  "can": { "report_defect": true, "test_stories": true } }
```

`"relay": 2` tells the kit to speak protocol 2; `can` is `/api/me`'s `can`, passed as it comes (the kit reads `report_defect` and `test_stories`; `can_report` and `can_test` may be given too). Not linked: `{ "relay": 2, "linked": false, "link_url": "…" }`.

**`GET` or `POST {endpoint}?path={path}`**: passed to `{FABRIQUE_URL}/api/projects/{project}/{path}`, where `{project}` is your project, never the kit's choice:

1. `path` is lowercase words separated by `/`: `^[a-z0-9-]+(/[a-z0-9-]+)*$`, at most 200 characters (no `..`, no query, no other project); anything else is refused (`400`);
2. only `GET` and `POST`; a `POST` body is passed as it comes, up to 3 MB (a screenshot); a `POST` without `path` is a defect (`path=defects`), so a report kept offline by an older kit still arrives;
3. the relay adds the person's access token (`authorization: Bearer …`, renewed with the refresh token when it expires) and three headers only it can say, which La Fabrique trusts over the body: `X-Fabrique-Environment` (the name of this environment in `.fabrique.json`, which its version path answers), `X-Fabrique-Version` and `X-Fabrique-Deployment`, each value URI-encoded (`encodeURIComponent`: a header carries ASCII only, and a version may read `1.171–int`);
4. it answers La Fabrique's status and body as they come; on `401`, the link is no longer valid: forget it (the next `GET` answers `linked: false`);
5. on an environment the project keeps closed (production, unless `.fabrique.json` opens it), it may answer `403 { "error": "reporting_disabled" }` without calling La Fabrique; La Fabrique refuses it anyway.

What the kit calls today, for reference (La Fabrique checks the scopes, the role and the environment of each): `targets` (`GET`, what a report can be about), `defects` (`POST`, a report), `to-test` (`GET`, the stories to test), `to-test/{story}/criteria` and `to-test/{story}/validate` (`POST`). A later kit may call more paths of the same API: the relay does not change.

A generic relay for a Cloudflare Worker, where `link` is what your app keeps of the person's link (tokens on the server only):

```ts
const PATH = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

async function relay(request: Request, env: Env, link: { access: string } | null, project: string): Promise<Response> {
  // Closed where the project does not open reporting nor testing (here, production).
  if (env.ENVIRONMENT === "production") return Response.json({ error: "reporting_disabled" }, { status: 403 });
  const path = new URL(request.url).searchParams.get("path") ?? (request.method === "POST" ? "defects" : null);
  if (request.method === "GET" && path === null) return status(env, link); // { relay: 2, linked, login, link_url, can }
  if (!link) return Response.json({ error: "not_linked" }, { status: 401 });
  if (!path || path.length > 200 || !PATH.test(path) || !["GET", "POST"].includes(request.method)) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const response = await fetch(`${env.FABRIQUE_URL}/api/projects/${project}/${path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${link.access}`,
      "content-type": "application/json",
      "x-fabrique-environment": encodeURIComponent(env.ENVIRONMENT), // e.g. "int"
      "x-fabrique-version": encodeURIComponent(await currentVersion(env)),
      "x-fabrique-deployment": encodeURIComponent(env.CF_VERSION_METADATA?.id ?? ""),
    },
    body: request.method === "POST" ? await request.text() : undefined,
  });
  if (response.status === 401) await forgetLink(env, link);
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
}
```

### The relay route by route (protocol 1)

Before kit 1.6.0, a relay answers each call on its own route. It keeps working with kit 1.6.0 and later (the kit speaks protocol 1 when the relay's `GET` does not say `"relay": 2`), but each new kit version may ask it for a new route.

Two routes at the address you chose, for a signed-in person of your app, outside production only.

**`GET`**: what the person can do.

```json
{ "linked": true, "can_report": true, "login": "octocat", "link_url": "/auth/fabrique/link" }
```

`can_report` is `can.report_defect` of La Fabrique's `GET /api/me`. Not linked: `{ "linked": false, "can_report": false, "can_test": false, "link_url": "…" }`.

**Testing (kit 1.3.0, ticking since 1.4.0).** To let a tester read the stories to test without leaving the app, the relay:

1. asks for the scope `stories:test` next to `defects:report` when it sends the person to `/oauth/authorize` (the consent page says what it allows; *Connected apps* shows it). A link made before keeps only `defects:report`: the person links again;
2. answers `"can_test": true` in its `GET` when `can.test_stories` of `GET /api/me` is true (the scope was allowed, the person's role may validate, and the project has an environment open to the kit); the kit then shows **Test** next to **Report a defect**;
3. answers **`GET ?to-test=1`** with La Fabrique's `GET {FABRIQUE_URL}/api/projects/{project}/to-test` (with the person's token), outside production only:

```json
{ "stories": [
  { "number": 146, "title": "…", "url": "…", "card": { "id": 17, "title": "…", "url": "https://…/cards/17" }, "page": "https://…/sprint/stories/146",
    "criteria": [{ "text": "…", "done": true }, { "text": "…", "done": false }],
    "validated": { "by": "tess", "at": "2026-10-31T09:00:00.000Z", "version": "1.170" } } ] }
```

The stories are those on int that wait to be tested (epics and defects left out); `card` and `validated` are `null` when there is none. `403` when the person may not validate (`not_allowed`), the app was not allowed the scope (`insufficient_scope`) or the environment is closed (`testing_disabled`). Without this route, the panel says the stories could not be read. The panel reads the stories again each time it opens, so what is done from La Fabrique shows too.
4. **Ticking and validating (kit 1.4.0, la-fabrique#166).** The panel shows each criterion as a checkbox, a **Validate** button and **Report a defect on this story**. The relay answers two more `POST`s, passed through (with the person's token) to La Fabrique:
   - `POST ?to-test={story}/criteria` with `{ "index": 1, "done": true }` → `POST {FABRIQUE_URL}/api/projects/{project}/to-test/{story}/criteria`: ticks or unticks the criterion in the issue (written by La Fabrique's App, in the person's name in the log, as *To test* does) and answers `{ "ok": true }`;
   - `POST ?to-test={story}/validate` → `POST {FABRIQUE_URL}/api/projects/{project}/to-test/{story}/validate`: validates the story as *To test* does, `422` (`not_ready`) while a criterion is not ticked.
   Both need the scope `stories:test`, a role that may validate, an environment open to testing, and a story that is one of those to test (`404` otherwise); a refusal is `{ "error": "…", "message": "…" }`, which the panel shows. The defect reported from the panel is the existing `POST` of the relay with `story` set to the story.

5. **Recording (kit 1.5.0, la-fabrique#167).** Next to each criterion, **Record** hides the panel and keeps the steps until **Stop**: the pages visited (path only), the buttons and links pressed and the fields filled, by their accessible name. The panel then shows the steps, which the tester can edit or drop, and **Tick with these steps** sends them: `POST ?to-test={story}/criteria` with `{ "index": 1, "done": true, "steps": [ { "kind": "click", "name": "Save", "page": "/orders" } ] }` (`kind`: `page`, `click`, `fill`, `select` or `check`). The relay passes the body as it comes; La Fabrique keeps the steps in its log with the criterion, the story, the version on int and the tester (`story_test_recorded`).

   **What is never recorded.** No value typed or chosen, in any field (a password, an e-mail, a name: only the field's name is kept), no screenshot, no page query or fragment. La Fabrique drops anything else it is sent. What it keeps is personal only through the tester's login: page addresses, action and field names, the version.

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

`story`, `release` and `change` are what the person chose (all optional; `change` is the index of a change in that version's `changes`).

**A feedback (kit 1.7.0, la-fabrique#201)**: `POST ?path=to-test/{story}/feedback` with `{ "criterion": 1, "text": "…", "screenshot": "data:image/png;base64,…", "page": "/…", "viewport": {…}, "user_agent": "…" }` (`criterion` optional: the story as a whole), passed to `POST {FABRIQUE_URL}/api/projects/{project}/to-test/{story}/feedback` (scope `stories:test`). It answers `201 { ok, comment, rework: true }`. The stories to test then say `rework` and `feedbacks`, and each criterion its `failed` feedback. La Fabrique links the issue to that story, says which version it is about and quotes the change; a change of a version that declares a single story links that story; when the person says nothing, it links the only story the versions on int declare, if there is one.

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
