import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { forgetKeys, verifyRunToken, workflowPath } from "../src/github-oidc";
import { readEvent, storyLoop } from "../src/loop-events";
import { loopHtml } from "../src/loop-views";
import { get, signIn } from "./helpers";

const REPO = "acme/widget";
const ORIGIN = "https://la-fabrique.test";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

let keys: CryptoKeyPair;
let jwk: JsonWebKey;

const encode = (data: unknown) => btoa(typeof data === "string" ? data : JSON.stringify(data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function token(claims: Record<string, unknown>, kid = "k1", signer: CryptoKey = keys.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: "RS256", kid, typ: "JWT" });
  const body = encode({
    iss: "https://token.actions.githubusercontent.com",
    aud: ORIGIN,
    exp: now + 300,
    nbf: now - 5,
    repository: REPO,
    workflow_ref: `${REPO}/.github/workflows/claude.yml@refs/heads/main`,
    run_id: "9001",
    ...claims,
  });
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${encode(String.fromCharCode(...signature))}`;
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  forgetKeys();
});

function publishKeys(): void {
  fetchMock
    .get("https://token.actions.githubusercontent.com")
    .intercept({ path: "/.well-known/jwks" })
    .reply(200, JSON.stringify({ keys: [{ kid: "k1", kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" }] }), JSON_HEADERS)
    .persist();
}

describe("A GitHub Actions OIDC token", () => {
  it("holds when GitHub signed it for La Fabrique, and says why not otherwise", async () => {
    publishKeys();
    const good = await verifyRunToken(await token({}), ORIGIN);
    expect(good).toMatchObject({ ok: true, claims: { repository: REPO, run_id: "9001" } });
    expect(good.ok && workflowPath(good.claims)).toBe(".github/workflows/claude.yml");
    expect(await verifyRunToken(await token({ aud: "https://elsewhere.test" }), ORIGIN)).toEqual({ ok: false, reason: `Not meant for ${ORIGIN}.` });
    expect(await verifyRunToken(await token({ exp: Math.floor(Date.now() / 1000) - 600 }), ORIGIN)).toEqual({ ok: false, reason: "Expired." });
    expect(await verifyRunToken(await token({ iss: "https://evil.test" }), ORIGIN)).toEqual({ ok: false, reason: "Not issued by GitHub Actions." });
    const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    expect(await verifyRunToken(await token({}, "k1", other.privateKey), ORIGIN)).toEqual({ ok: false, reason: "The signature does not hold." });
    expect(await verifyRunToken("not.a.token", ORIGIN)).toMatchObject({ ok: false });
  });
});

describe("An event of the loop", () => {
  it("is read with its phase, numbers and break, and says what is wrong", () => {
    expect(readEvent({ phase: "review", findings: { blocking: 1, advice: 2 } })).toEqual({
      event: { phase: "review", iteration: 1, summary: null, tests: null, diff: null, findings: { blocking: 1, advice: 2 }, breakKind: null, breakReason: null },
    });
    expect(readEvent({ phase: "break", break: { kind: "spec", reason: "Criteria 2 and 3 contradict each other." } })).toMatchObject({ event: { breakKind: "spec" } });
    expect(readEvent({ phase: "dance" })).toEqual({ errors: ["`phase` must be one of plan, tests, code, review, fix, verify, deliver, break."] });
    expect(readEvent({ phase: "break" })).toMatchObject({ errors: expect.arrayContaining([expect.stringContaining("break.kind")]) });
    expect(readEvent({ phase: "code", break: { kind: "spec", reason: "x" } })).toEqual({ errors: ["`break` goes with the phase `break` only."] });
    expect(readEvent({ phase: "tests", tests: { passed: -1 } })).toEqual({ errors: ["`tests.passed` must be a whole number."] });
  });
});

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(
      REPO,
      JSON.stringify({ nom: "Widget", workflows: { claude: "claude.yml" } }),
    ),
    env.DB.prepare("INSERT INTO runner_runs (run_id, repo, workflow, capability, story, status, started_at) VALUES (9001, ?, 'claude', 'code', 12, 'in_progress', ?)").bind(REPO, new Date().toISOString()),
  ]);
}

const post = (path: string, body: unknown, bearer?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });

describe("The loop's events from a project's runner", () => {
  it("are recorded when signed by GitHub for the project's claude workflow, and shown on the story and in Agents", async () => {
    await seed();
    publishKeys();
    const path = `/api/runner/${REPO}/loops/12/events`;
    const signed = await token({});
    expect((await post(path, { phase: "plan", summary: "Add the menu's week view." }, signed)).status).toBe(201);
    expect((await post(path, { phase: "tests", tests: { new: 3 } }, signed)).status).toBe(201);
    expect((await post(path, { phase: "review", findings: { blocking: 1, advice: 0 } }, signed)).status).toBe(201);
    expect((await post(path, { phase: "fix", iteration: 2 }, signed)).status).toBe(201);
    expect((await post(path, { phase: "break", break: { kind: "decision", reason: "Week starts on Monday or Sunday: ADR 0007 proposed." } }, signed)).status).toBe(201);
    const rows = (await env.DB.prepare("SELECT phase, iteration, run_id FROM loop_events ORDER BY id").all()).results;
    expect(rows.map((row) => row["phase"])).toEqual(["plan", "tests", "review", "fix", "break"]);
    expect(rows[0]).toMatchObject({ run_id: 9001 });
    expect(await env.DB.prepare("SELECT action, issue_number FROM activity_log WHERE action = 'loop_break'").first()).toEqual({ action: "loop_break", issue_number: 12 });

    const { cookie } = await signIn("admin-one");
    const agents = await (await get("/agents", cookie)).text();
    expect(agents).toContain('Running</span> <span class="small">Stopped</span>');

    // The story's page shows the run's phases in order, with the break.
    const html = loopHtml(await storyLoop(env.DB, REPO, 12));
    expect(html).toContain("<h2>The loop</h2>");
    expect(html).toMatch(/<strong>Plan<\/strong>[\s\S]*Add the menu(&#39;|')s week view\.[\s\S]*<strong>Tests first<\/strong> <span class="muted small">tests 0 passed, 3 new<\/span>[\s\S]*<strong>Review<\/strong> <span class="muted small">review: 1 blocking, 0 advice<\/span>[\s\S]*<strong>Fix<\/strong> <span class="pill small">2<\/span>[\s\S]*<strong>Stopped<\/strong> <span class="pill alert small">A decision to take<\/span><br>Week starts on Monday or Sunday/);
  });

  it("are refused without a token, with a token of another repository or workflow, or a wrong body", async () => {
    await seed();
    publishKeys();
    const path = `/api/runner/${REPO}/loops/12/events`;
    expect((await post(path, { phase: "plan" })).status).toBe(401);
    expect((await post(path, { phase: "plan" }, "not.a.token")).status).toBe(401);
    expect((await post(path, { phase: "plan" }, await token({ repository: "acme/other" }))).status).toBe(403);
    expect((await post(path, { phase: "plan" }, await token({ workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/heads/main` }))).status).toBe(403);
    const wrong = await post(path, { phase: "dance" }, await token({}));
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { error: string }).error).toContain("`phase` must be one of");
    expect((await post(`/api/runner/acme/none/loops/12/events`, { phase: "plan" }, await token({ repository: "acme/none" }))).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM loop_events").first<{ n: number }>())?.n).toBe(0);
  });
});
