import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { epicAbstract, ensureEpicIssue, fileUnderEpic } from "../src/epic-github";
import { findCard } from "../src/cards";
import { epicHistory } from "../src/epic-status";
import { findProject } from "../src/projects";
import { grantRole, post, signIn } from "./helpers";

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const github = () => fetchMock.get("https://api.github.com");

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function make(s: { cookie: string; csrf: string }, fields: Record<string, string>): Promise<number> {
  const r = await post(`/projects/${REPO}/cards`, { csrf: s.csrf, action: "save", status: "draft", ...fields }, s.cookie);
  return Number(/cards\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1]);
}

describe("Epic GitHub issue", () => {
  it("abstracts the Why section, not the document", () => {
    expect(epicAbstract("## Why\n\nBecause.\nReally.\n\n## Scope\n\nSecret scope")).toBe("Because. Really.");
    expect(epicAbstract("")).toBe("");
  });

  it("creates the epique issue once, on entering Next release, then files stories under it", async () => {
    await env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO).run();
    await grantRole("pe", "product_engineer");
    const s = await signIn("pe");
    const epicId = await make(s, { kind: "epic", title: "Big", section_why: "A reason.", section_scope: "FULL DOCUMENT" });
    const featureId = await make(s, { kind: "feature", title: "Part", epic: "Big" });
    const project = (await findProject(env.DB, REPO))!;
    const feature = (await findCard(env.DB, REPO, featureId))!;

    // Not in refinement yet: nothing created.
    expect(await ensureEpicIssue(env, project, feature, "pe", "https://x.test")).toBeNull();

    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS).persist();
    let sent: { title: string; body: string; labels: string[] } | null = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues` })
      .reply(201, (opts) => {
        sent = JSON.parse(String(opts.body));
        return JSON.stringify({ number: 40, html_url: `https://github.com/${REPO}/issues/40` });
      }, JSON_HEADERS);
    const inNext = { ...feature, release: "Next release" };
    expect(await ensureEpicIssue(env, project, inNext, "pe", "https://x.test")).toBe(40);
    expect(sent!.labels).toEqual(["epique"]);
    expect(sent!.body).toContain("A reason.");
    expect(sent!.body).toContain("https://x.test/c/" + epicId);
    expect(sent!.body).not.toContain("FULL DOCUMENT");
    // Once only.
    expect(await ensureEpicIssue(env, project, inNext, "pe", "https://x.test")).toBeNull();
    const actions = (await epicHistory(env.DB, REPO, epicId)).map((e) => e.action);
    expect(actions).toContain("epic_issue_created");
    expect(actions).toContain("card_created");

    github().intercept({ path: `/repos/${REPO}/issues/55` }).reply(200, JSON.stringify({ id: 9055 }), JSON_HEADERS);
    let sub: unknown = null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/issues/40/sub_issues` })
      .reply(201, (opts) => {
        sub = JSON.parse(String(opts.body));
        return "{}";
      }, JSON_HEADERS);
    expect(await fileUnderEpic(env, project, inNext, 55)).toBe(true);
    expect(sub).toEqual({ sub_issue_id: 9055 });
  });
});
