import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addDependency, dependenciesOf, loopThrough, removeDependency } from "../src/card-dependencies";
import { findCard } from "../src/cards";
import { get, grantRole, post, signIn } from "./helpers";

const REPO = "acme/widget";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES ('acme/other', 99, 'admin-one')"),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
  ]);
}

async function card(repo: string, title: string, epic: string | null): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, epic, position, author) VALUES (?, 'feature', 'draft', ?, '', ?, 1, 'pe') RETURNING id")
    .bind(repo, title, epic)
    .first<{ id: number }>();
  return row!.id;
}

describe("Feature dependencies", () => {
  it("shows a dependency on both sides, refuses loops (also through an epic), and logs", async () => {
    await seed();
    const a = await card(REPO, "A", "F9");
    const b = await card(REPO, "B", "F1");
    const c = await card(REPO, "C", null);
    const foreign = await card("acme/other", "X", "Z");
    const A = (await findCard(env.DB, REPO, a))!;
    const B = (await findCard(env.DB, REPO, b))!;
    const C = (await findCard(env.DB, REPO, c))!;

    expect(await addDependency(env.DB, REPO, B, { card: a }, "tess")).toEqual({ ok: true });
    const deps = await dependenciesOf(env.DB, REPO, b);
    expect(deps.dependsOn.map((x) => x.id)).toEqual([a]);
    expect((await dependenciesOf(env.DB, REPO, a)).neededBy.map((x) => x.card.id)).toEqual([b]);

    // Only this project's features and epics.
    expect(await addDependency(env.DB, REPO, B, { card: foreign }, "tess")).toMatchObject({ ok: false });
    expect(await addDependency(env.DB, REPO, B, { epic: "Z" }, "tess")).toMatchObject({ ok: false });

    // A loop, direct and through an epic.
    expect(await addDependency(env.DB, REPO, A, { card: b }, "tess")).toMatchObject({ ok: false, loop: [a, b, a] });
    expect(await addDependency(env.DB, REPO, A, { card: a }, "tess")).toMatchObject({ ok: false });
    expect(await addDependency(env.DB, REPO, C, { epic: "F9" }, "tess")).toEqual({ ok: true });
    const through = await addDependency(env.DB, REPO, A, { card: c }, "tess");
    expect(through).toMatchObject({ ok: false, loop: [a, c, a] });
    expect((await dependenciesOf(env.DB, REPO, a)).neededBy.map((x) => x.viaEpic)).toContain("F9");
    // A card cannot depend on its own epic.
    expect(await addDependency(env.DB, REPO, A, { epic: "F9" }, "tess")).toMatchObject({ ok: false });

    expect(await removeDependency(env.DB, REPO, B, { card: a }, "tess")).toBe(true);
    expect((await dependenciesOf(env.DB, REPO, a)).neededBy.map((x) => x.card.id)).not.toContain(b);
    const log = await env.DB.prepare("SELECT action, actor FROM activity_log WHERE action LIKE 'card_dependency_%' ORDER BY id").all<{ action: string; actor: string }>();
    expect(log.results.map((r) => r.action)).toEqual(["card_dependency_added", "card_dependency_added", "card_dependency_removed"]);
    expect(log.results[0]?.actor).toBe("tess");
  });

  it("finds no loop in a chain", () => {
    expect(loopThrough([], [], 1, { card: 2 })).toBeNull();
  });

  it("lets a tester add a dependency from the page", async () => {
    await seed();
    const a = await card(REPO, "A", null);
    const b = await card(REPO, "B", null);
    await grantRole("tess", "tester");
    const session = await signIn("tess");
    const response = await post(`/projects/${REPO}/cards/${b}`, { csrf: session.csrf, action: "depend_add", on: `C${a}` }, session.cookie);
    expect(response.status).toBe(303);
    const page = await (await get(`/projects/${REPO}/cards/${a}`, session.cookie)).text();
    expect(page).toContain("Needed by");
    const mine = await (await get(`/projects/${REPO}/cards/${b}`, session.cookie)).text();
    expect(mine).toContain("Depends on");
  });
});
