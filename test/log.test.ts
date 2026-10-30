import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { activityStatement } from "../src/activity-log";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify({ nom: "Widget" })),
    activityStatement(env.DB, { actor: "admin-one", action: "project_added", repo: REPO, details: { installation_id: 99 } }),
    activityStatement(env.DB, { actor: "pe", action: "priority_set", repo: REPO, issueNumber: 12, details: { from: null, to: "P1" } }),
    activityStatement(env.DB, { actor: "qa", action: "criterion_checked", repo: REPO, issueNumber: 12, details: { index: 0, text: "Seven <days>" } }),
    activityStatement(env.DB, { actor: "qa", action: "story_validated", repo: REPO, issueNumber: 12, details: { version: "1.169" } }),
    activityStatement(env.DB, { actor: "qa", action: "defect_reported", repo: REPO, issueNumber: 12, details: { defect: 90, title: "Monday missing" } }),
    activityStatement(env.DB, { actor: "admin-one", action: "role_granted", details: { login: "qa" } }),
    activityStatement(env.DB, { actor: "x", action: "priority_set", repo: "acme/other", issueNumber: 1, details: {} }),
  ]);
}

describe("Log", () => {
  it("lists the project's decisions in words, newest first, with links", async () => {
    await seed();
    await grantRole("qa", "tester");
    const page = await (await get(`/projects/${REPO}/log`, (await signIn("qa")).cookie)).text();
    expect(page).toContain('aria-current="page">Log</a>');
    expect(page).toContain(`reported defect <a target="_blank" rel="noopener noreferrer" href="https://github.com/${REPO}/issues/90">#90</a>`);
    expect(page).toContain("validated <a");
    expect(page).toContain("(version <span class=\"mono\">1.169</span>)");
    expect(page).toContain("checked a criterion of");
    expect(page).toContain("“Seven &lt;days&gt;”");
    expect(page).toContain("set the priority of");
    expect(page).toContain(": none → P1");
    expect(page).toContain("added the project to La Fabrique");
    expect(page).not.toContain("role_granted");
    expect(page).not.toContain("acme/other/issues/1\"");
    expect(page.indexOf("reported defect")).toBeLessThan(page.indexOf("added the project"));
  });

  it("filters by kind of decision and by person", async () => {
    await seed();
    const { cookie } = await signIn("admin-one");
    const validation = await (await get(`/projects/${REPO}/log?group=validation`, cookie)).text();
    expect(validation).toContain("validated");
    expect(validation).not.toContain("set the priority");
    const byPe = await (await get(`/projects/${REPO}/log?actor=pe`, cookie)).text();
    expect(byPe).toContain("set the priority");
    expect(byPe).not.toContain("validated <a");
    expect(byPe).toContain('<option value="pe" selected>@pe</option>');
  });

  it("pages through older entries", async () => {
    await env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO).run();
    await env.DB.batch(
      Array.from({ length: 105 }, (_, index) =>
        activityStatement(env.DB, { actor: "pe", action: "priority_set", repo: REPO, issueNumber: index + 1, details: { from: null, to: "P1" } }),
      ),
    );
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/log`, cookie)).text();
    const older = /href="(\/projects\/acme\/widget\/log\?before=\d+)"/.exec(page)?.[1];
    expect(older).toBeTruthy();
    const next = await (await get(older ?? "", cookie)).text();
    expect(next).toContain("issues/5\"");
    expect(next).not.toContain("issues/6\"");
    expect(next).not.toContain(">Older</a>");
  });
});
