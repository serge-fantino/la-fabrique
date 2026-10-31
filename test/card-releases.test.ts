import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compareVersions, nextVersion, planningProblem, versionPattern, type BoardRelease } from "../src/card-releases";
import type { Project } from "../src/projects";
import { get, grantRole, post, signIn } from "./helpers";

const REPO = "acme/widget";
const CONFIG = { nom: "Widget", version: { fichier: "site/nouveautes.json", forme: "v1.N" } };

// The project's release notes as last read (production's commit), and what
// integration brings as the Production page last saw it.
async function seed(): Promise<void> {
  const release = (version: string, time: string | null) => ({ version, date: "2026-10-01", time, title: `Title ${version}`, changes: [], links: [], stories: null, upcoming: false });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'releases', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify({ commitSha: "abc", releases: [release("v1.10", "10:00"), release("v1.9", "09:00"), release("v1.2", "08:00"), release("v1.1", null)] }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'production', ?, '2000-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify({ waiting: [{ version: "v1.11", title: "Being built", changes: [] }] }),
    ),
  ]);
}

describe("Versions", () => {
  it("orders newest first, reads the project's numbering and the next version", () => {
    expect(["v1.9", "v1.10", "Later", "v1.2"].sort(compareVersions)).toEqual(["Later", "v1.10", "v1.9", "v1.2"]);
    expect(versionPattern("v1.N")?.test("v1.215")).toBe(true);
    expect(versionPattern("v1.N")?.test("v2.1")).toBe(false);
    expect(versionPattern("0.N")?.test("0.54")).toBe(true);
    expect(versionPattern(undefined)).toBeNull();
    const releases: BoardRelease[] = [
      { version: "v1.11", title: null, state: "in_progress" },
      { version: "v1.10", title: null, state: "shipped" },
    ];
    expect(nextVersion("v1.N", releases)).toBe("v1.12");
    const project = { check: { config: CONFIG } } as unknown as Project;
    expect(planningProblem(project, "v1.12", releases)).toBeNull();
    expect(planningProblem(project, "2.0", releases)).toBe("A release follows the project's numbering, v1.N: the next one is v1.12.");
    expect(planningProblem(project, "v1.11", releases)).toBe("v1.11 is not ahead of v1.11, already in progress: the next one is v1.12.");
    expect(planningProblem(project, "v1.3", releases)).toBe("v1.3 is not ahead of v1.11, already in progress: the next one is v1.12.");
  });
});

describe("The board's releases", () => {
  it("shows the project's releases newest first; hiding empty lanes keeps the open ones", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");
    await post(`/projects/${REPO}/cards`, { csrf: session.csrf, action: "save", title: "Shipped one", kind: "feature", status: "validated", release: "v1.9" }, session.cookie);

    const planned = await post(`/projects/${REPO}/board`, { csrf: session.csrf, action: "add_value", dimension: "release", value: "v1.13", back: "by=release" }, session.cookie);
    expect(planned.headers.get("location")).toBe(`/projects/${REPO}/board?by=release&notice=added`);

    const all = await (await get(`/projects/${REPO}/board?by=release`, session.cookie)).text();
    const order = ["v1.13", "v1.11", "v1.10", "v1.9", "v1.2"].map((version) => all.indexOf(`aria-label="${version}"`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(all).toContain('title="Being built">v1.11 <span class="pill warn small">In progress</span>');
    expect(all).toContain('v1.13 <span class="pill kind small">Planned</span>');
    // Older than the first entry with a time: shipped before times were written.
    expect(all).toContain('v1.1 <span class="pill ok small">Shipped</span>');
    expect(all).toContain('<summary class="button quiet">Plan a release</summary>');
    expect(all).toContain('placeholder="v1.14" value="v1.14"');
    // Not set first, so what is not placed yet stays in sight.
    expect(all.indexOf('aria-label="Not set"')).toBeLessThan(order[0] ?? 0);

    const hidden = await (await get(`/projects/${REPO}/board?by=release&empty=hide`, session.cookie)).text();
    expect(hidden).toContain("/> Hide closed lanes</label>");
    expect(hidden).toContain('aria-label="v1.13"');
    expect(hidden).toContain('aria-label="v1.11"');
    expect(hidden).toContain('aria-label="v1.9"');
    expect(hidden).not.toContain('aria-label="v1.10"');
    expect(hidden).not.toContain('aria-label="v1.2"');
    expect(hidden).not.toContain('aria-label="v1.1"');
  });

  it("plans a release only ahead, in the project's numbering", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");
    for (const value of ["v1.4", "2.0"]) {
      const refused = await post(`/projects/${REPO}/board`, { csrf: session.csrf, action: "add_value", dimension: "release", value, back: "by=release" }, session.cookie);
      expect(refused.headers.get("location")).toBe(`/projects/${REPO}/board?by=release&failure=release&value=${encodeURIComponent(value)}`);
    }
    const page = await (await get(`/projects/${REPO}/board?by=release&failure=release&value=v1.4`, session.cookie)).text();
    expect(page).toContain("v1.4 is not ahead of v1.11, already in progress: the next one is v1.12.");
    // Only the reason worked out again is shown, never text from the address.
    expect(await (await get(`/projects/${REPO}/board?by=release&failure=release&value=v1.12`, session.cookie)).text()).not.toContain("notice error");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM card_values WHERE dimension = 'release'").first<{ n: number }>())?.n).toBe(0);
  });
});
