import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { epicFeatures, findEpicByTitle } from "../src/card-epics";
import { findCard, listCards } from "../src/cards";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";

async function seed(): Promise<{ cookie: string; csrf: string }> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
  ]);
  await grantRole("pe", "product_engineer");
  return signIn("pe");
}

async function card(s: { cookie: string; csrf: string }, kind: string, title: string): Promise<number> {
  const r = await post(`/projects/${REPO}/cards`, { csrf: s.csrf, action: "save", kind, status: "draft", title }, s.cookie);
  return Number(/cards\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1]);
}

const act = (s: { cookie: string; csrf: string }, id: number, fields: Record<string, string>) =>
  post(`/projects/${REPO}/cards/${id}`, { csrf: s.csrf, ...fields }, s.cookie);

async function epicOf(id: number): Promise<string | null> {
  return (await findCard(env.DB, REPO, id))?.epic ?? null;
}
async function members(epic: number): Promise<number[]> {
  const e = await findCard(env.DB, REPO, epic);
  return e ? (await epicFeatures(env.DB, e)).map((c) => c.id) : [];
}

describe("A feature's epic", () => {
  it("lists the epic cards on the feature page", async () => {
    const s = await seed();
    await card(s, "epic", "Refinement");
    const f = await card(s, "feature", "A feature");
    const page = await (await get(`/projects/${REPO}/cards/${f}`, s.cookie)).text();
    expect(page).toContain('<option value="Refinement">');
  });

  it("picks an existing epic by title, never a second one, and lists the feature in its document", async () => {
    const s = await seed();
    const e = await card(s, "epic", "Refinement");
    const f = await card(s, "feature", "A feature");
    await act(s, f, { action: "set_epic", epic: "refinement" });
    expect((await listCards(env.DB, REPO)).filter((c) => c.kind === "epic")).toHaveLength(1);
    expect(await epicOf(f)).toBe("Refinement");
    expect(await members(e)).toEqual([f]);
    const page = await (await get(`/projects/${REPO}/cards/${e}`, s.cookie)).text();
    expect(page).toContain("A feature");
  });

  it("creates an empty draft epic from a new name, with the feature attached", async () => {
    const s = await seed();
    const f = await card(s, "feature", "A feature");
    await act(s, f, { action: "set_epic", epic: "Les recettes" });
    const epic = findEpicByTitle(await listCards(env.DB, REPO), "Les recettes");
    expect(epic?.status).toBe("draft");
    expect(epic?.body).toBe("");
    expect(await members(epic?.id ?? 0)).toEqual([f]);
    expect((await logActions()).map((l) => l.action)).toContain("epic_created");
  });

  it("moves a feature to a second epic, never in two, from either side", async () => {
    const s = await seed();
    const a = await card(s, "epic", "A");
    const b = await card(s, "epic", "B");
    const f = await card(s, "feature", "F");
    await act(s, f, { action: "set_epic", epic: "A" });
    await act(s, b, { action: "attach_feature", feature: String(f) });
    expect(await epicOf(f)).toBe("B");
    expect(await members(a)).toEqual([]);
    expect(await members(b)).toEqual([f]);
    // Leaving B asks first, and nothing moves until confirmed.
    const ask = await act(s, f, { action: "set_epic", epic: "A" });
    expect(await (ask as Response).text()).toContain("leaves B and goes to A");
    expect(await epicOf(f)).toBe("B");
    await act(s, f, { action: "set_epic", epic: "A", confirm: "1" });
    expect(await members(a)).toEqual([f]);
    expect(await members(b)).toEqual([]);
  });

  it("removes the epic from either side", async () => {
    const s = await seed();
    const a = await card(s, "epic", "A");
    const f = await card(s, "feature", "F");
    await act(s, a, { action: "attach_feature", feature: String(f) });
    expect(await epicOf(f)).toBe("A");
    await act(s, f, { action: "set_epic", epic: "", confirm: "1" });
    expect(await epicOf(f)).toBeNull();
    expect(await members(a)).toEqual([]);
    await act(s, f, { action: "set_epic", epic: "A" });
    await act(s, a, { action: "detach_feature", feature: String(f) });
    expect(await epicOf(f)).toBeNull();
    expect(await members(a)).toEqual([]);
    expect((await logActions()).map((l) => l.action)).toContain("feature_detached");
  });
});

describe("Converting typed Epic values", () => {
  it("offers, reviews, then converts once", async () => {
    const s = await seed();
    const existing = await card(s, "epic", "Famille");
    const f1 = await card(s, "feature", "One");
    const f2 = await card(s, "feature", "Two");
    await env.DB.prepare("UPDATE cards SET epic = ? WHERE id = ?").bind("Famille", f1).run();
    await env.DB.prepare("UPDATE cards SET epic = ? WHERE id = ?").bind("Recettes", f2).run();
    await env.DB.prepare("DELETE FROM card_links").run();
    const board = await (await get(`/projects/${REPO}/board`, s.cookie)).text();
    expect(board).toContain("2 epics to create from the Epic values");
    const review = await (await get(`/projects/${REPO}/cards/epics`, s.cookie)).text();
    expect(review).toContain("Recettes");
    expect((await listCards(env.DB, REPO)).filter((c) => c.kind === "epic")).toHaveLength(1);
    await post(`/projects/${REPO}/cards/epics`, { csrf: s.csrf }, s.cookie);
    const epics = (await listCards(env.DB, REPO)).filter((c) => c.kind === "epic");
    expect(epics).toHaveLength(2);
    expect(await members(existing)).toEqual([f1]);
    expect(await epicOf(f2)).toBe("Recettes");
    const actions = (await logActions()).map((l) => l.action);
    expect(actions).toContain("epic_conversion_confirmed");
    expect(actions).toContain("feature_attached");
    await post(`/projects/${REPO}/cards/epics`, { csrf: s.csrf }, s.cookie);
    expect((await listCards(env.DB, REPO)).filter((c) => c.kind === "epic")).toHaveLength(2);
    expect(await (await get(`/projects/${REPO}/board`, s.cookie)).text()).not.toContain("to create from the Epic values");
  });

  it("is not offered to a tester", async () => {
    const s = await seed();
    const f = await card(s, "feature", "One");
    await env.DB.prepare("UPDATE cards SET epic = ? WHERE id = ?").bind("X", f).run();
    await grantRole("tt", "tester");
    const t = await signIn("tt");
    expect(await (await get(`/projects/${REPO}/board`, t.cookie)).text()).not.toContain("to create from the Epic values");
  });
});
