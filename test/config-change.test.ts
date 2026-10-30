import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cycleJson, readCycleForm, setTopLevelMember } from "../src/config-change";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const FILE = `{
  "nom": "Widget",
  "branches": { "production": "main", "integration": "integration" },
  "demandes": {
    "rubriques": [
      { "cle": "besoin", "titre": "Besoin {important}", "obligatoire": true }
    ]
  }
}
`;

describe("setTopLevelMember", () => {
  it("adds a member last, with the file's indentation, keeping the rest as written", () => {
    const next = setTopLevelMember(FILE, "cycle", cycleJson({ pret: ["criteres"], priorites: ["P1"] }));
    expect(next).toBe(FILE.replace(`    ]\n  }\n}`, `    ]\n  },\n  "cycle": { "pret": ["criteres"], "priorites": ["P1"] }\n}`));
    expect(JSON.parse(next).cycle).toEqual({ pret: ["criteres"], priorites: ["P1"] });
  });

  it("replaces an existing member in place", () => {
    const withCycle = FILE.replace(`"nom": "Widget",`, `"nom": "Widget",\n  "cycle": { "pret": [] },`);
    const next = setTopLevelMember(withCycle, "cycle", cycleJson({ pret: ["epique"], priorites: [] }));
    expect(next).toContain(`"nom": "Widget",\n  "cycle": { "pret": ["epique"], "priorites": [] },\n  "branches"`);
    expect(JSON.parse(next).demandes.rubriques[0].titre).toBe("Besoin {important}");
  });
});

describe("readCycleForm", () => {
  it("keeps known checks and distinct labels", () => {
    const form = new FormData();
    form.append("pret", "criteres");
    form.append("pret", "unknown");
    form.append("priorites", " P1, P2 ,P1,, ");
    expect(readCycleForm(form)).toEqual({ cycle: { pret: ["criteres"], priorites: ["P1", "P2"] } });
  });

  it("refuses a priority required without labels", () => {
    const form = new FormData();
    form.append("pret", "priorite");
    expect(readCycleForm(form)).toEqual({ error: "A priority is required to be ready, but no priority label is given." });
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(JSON.parse(FILE))),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)").bind(REPO, new Date().toISOString()),
  ]);
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("Story lifecycle in Setup", () => {
  it("shows the lifecycle form with the defaults", async () => {
    await seed();
    const page = await (await get(`/projects/${REPO}/setup`, (await signIn("admin-one")).cookie)).text();
    expect(page).toContain("<h2>Story lifecycle</h2>");
    expect(page).toContain('name="pret" value="criteres" checked');
    expect(page).toContain('name="pret" value="priorite" />');
    expect(page).toContain("opens a pull request on <code>integration</code>");
  });

  it("opens a pull request on integration under the person's name, changing only cycle", async () => {
    await seed();
    const github = fetchMock.get("https://api.github.com");
    const seen: { auth: string; body: unknown }[] = [];
    const record = (options: { headers?: unknown; body?: unknown }) => {
      const headers = options.headers as Record<string, string>;
      seen.push({ auth: headers["authorization"] ?? "", body: options.body ? JSON.parse(String(options.body)) : null });
    };
    github.intercept({ path: `/repos/${REPO}/contents/.fabrique.json?ref=integration` }).reply(200, (options) => {
      record(options);
      return JSON.stringify({ content: toBase64(FILE), sha: "filesha" });
    });
    github.intercept({ path: `/repos/${REPO}/git/ref/heads/integration` }).reply(200, JSON.stringify({ object: { sha: "headsha" } }), JSON_HEADERS);
    github.intercept({ method: "POST", path: `/repos/${REPO}/git/refs` }).reply(201, (options) => {
      record(options);
      return "{}";
    });
    github.intercept({ method: "PUT", path: `/repos/${REPO}/contents/.fabrique.json` }).reply(200, (options) => {
      record(options);
      return "{}";
    });
    github.intercept({ method: "POST", path: `/repos/${REPO}/pulls` }).reply(201, (options) => {
      record(options);
      return JSON.stringify({ number: 77, html_url: `https://github.com/${REPO}/pull/77` });
    });

    await grantRole("lead", "tech_lead");
    const { cookie, csrf } = await signIn("lead");
    const form = new URLSearchParams({ csrf, priorites: "P1, P2" });
    form.append("pret", "criteres");
    form.append("pret", "priorite");
    const response = await SELF.fetch(`${BASE}/projects/${REPO}/setup`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: form.toString(),
    });
    expect(response.status).toBe(303);
    expect(seen[0]?.auth).toBe("Bearer gho_session_token");
    const ref = seen[1]?.body as { ref: string; sha: string };
    expect(ref.sha).toBe("headsha");
    expect(ref.ref).toMatch(/^refs\/heads\/fabrique\/cycle-\d{14}$/);
    const put = seen[2]?.body as { content: string; sha: string; branch: string };
    const written = new TextDecoder().decode(Uint8Array.from(atob(put.content), (char) => char.charCodeAt(0)));
    expect(JSON.parse(written).cycle).toEqual({ pret: ["criteres", "priorite"], priorites: ["P1", "P2"] });
    expect(written.startsWith(FILE.slice(0, FILE.indexOf("\n  }\n}")))).toBe(true);
    expect(put.sha).toBe("filesha");
    expect((seen[3]?.body as { base: string }).base).toBe("integration");
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/setup?notice=proposed&pull=77&base=integration#lifecycle`);
    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "lead", action: "config_change_proposed" }));
  });

  it("says what to do when GitHub refuses the change", async () => {
    await seed();
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: `/repos/${REPO}/contents/.fabrique.json?ref=integration` })
      .reply(403, JSON.stringify({ message: "Resource not accessible by integration" }), JSON_HEADERS);
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post(`/projects/${REPO}/setup`, { csrf, pret: "criteres", priorites: "" }, cookie);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Contents and Pull requests write permission");
  });

  it("lets a tester read the lifecycle but not change it", async () => {
    await seed();
    await grantRole("qa", "tester");
    const { cookie, csrf } = await signIn("qa");
    const page = await (await get(`/projects/${REPO}/setup`, cookie)).text();
    expect(page).toContain("Super admins and tech leads change it.");
    expect((await post(`/projects/${REPO}/setup`, { csrf, pret: "criteres" }, cookie)).status).toBe(403);
  });
});
