import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compareVersions, nextVersion, plannedSpelling, planningProblem, versionPattern, type BoardRelease } from "../src/card-releases";
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

  it("spells a planned release as the project's release notes do, whatever the prefix", () => {
    // The épicerie: "v1.N" in .fabrique.json, "1.169" in its release notes.
    const releases: BoardRelease[] = [{ version: "1.169", title: null, state: "in_progress" }];
    expect(versionPattern("v1.N")?.test("1.169")).toBe(true);
    expect(nextVersion("v1.N", releases)).toBe("1.170");
    expect(plannedSpelling("v1.N", releases, "v1.171")).toBe("1.171");
    expect(plannedSpelling("v1.N", [], "v1.2")).toBe("v1.2");
    expect(plannedSpelling("v1.N", releases, "Later")).toBe("Later");
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
    // Not set first, then Next release, then the versions; no release
    // planned by number from the board any more.
    expect(all.indexOf('aria-label="Not set"')).toBeLessThan(all.indexOf('aria-label="Next release"'));
    expect(all.indexOf('aria-label="Next release"')).toBeLessThan(order[0] ?? 0);
    expect(all).not.toContain("Plan a release");

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

  it("shows the release on int as On int with its branch, and drops a release planned by number once it is there", async () => {
    await seed();
    await env.DB.batch([
      env.DB.prepare("UPDATE project_configs SET config = ? WHERE repo = ?").bind(JSON.stringify({ ...CONFIG, branches: { production: "main", integration: "integration" } }), REPO),
      // Planned before the sprints, now the release on int ("v1.11" too).
      env.DB.prepare("INSERT INTO card_values (repo, dimension, value, position, created_by) VALUES (?, 'release', 'v1.11', 1, 'pe')").bind(REPO),
      env.DB.prepare("INSERT INTO card_values (repo, dimension, value, position, created_by) VALUES (?, 'release', '1.10', 2, 'pe')").bind(REPO),
    ]);
    await grantRole("pe", "product_engineer");
    const page = await (await get(`/projects/${REPO}/board?by=release`, (await signIn("pe")).cookie)).text();
    expect(page).toContain('title="On the integration branch, waiting for the go: Being built">v1.11 <span class="pill warn small">On int</span> <code class="small">integration</code>');
    expect(page.match(/aria-label="v1\.11"/g)).toHaveLength(1);
    expect(page).not.toContain('aria-label="1.10"');
    expect(page).not.toContain('<span class="pill kind small">Planned</span>');

    // A sprint runs: one lane, the Sprint's, says the release it builds on int.
    await env.DB.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, 'Sprint', 'pe')").bind(REPO).run();
    const sprint = await (await get(`/projects/${REPO}/board?by=release`, (await signIn("pe")).cookie)).text();
    expect(sprint).toContain(
      'title="The sprint in progress; v1.11 on the integration branch, waiting for the go">Sprint <span class="pill warn small">In progress</span> <span class="mono small">v1.11 (int)</span>',
    );
    expect(sprint).not.toContain('aria-label="v1.11"');
  });
});
