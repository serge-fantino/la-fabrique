import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { findCard, listCards } from "../src/cards";
import { composeEpicBody, parseEpicBody, DEFAULT_EPIC_SECTIONS } from "../src/epic-sections";
import { get, grantRole, post, signIn } from "./helpers";

const REPO = "acme/widget";

async function seed(config: object = { nom: "Widget" }): Promise<{ cookie: string; csrf: string }> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(config)),
  ]);
  await grantRole("pe", "product_engineer");
  return signIn("pe");
}

describe("Epic cards", () => {
  it("round-trips sections through the document", () => {
    const body = composeEpicBody({ why: "Because", scope: "All" }, DEFAULT_EPIC_SECTIONS);
    expect(body).toBe("## Why\n\nBecause\n\n## Scope\n\nAll");
    expect(parseEpicBody(body, DEFAULT_EPIC_SECTIONS).texts).toEqual({ why: "Because", scope: "All" });
  });

  it("offers the type on creation and the default sections", async () => {
    const s = await seed();
    const page = await (await get(`/projects/${REPO}/cards/new`, s.cookie)).text();
    expect(page).toContain('<option value="epic"');
    const form = await (await get(`/projects/${REPO}/cards/new?kind=epic`, s.cookie)).text();
    for (const t of ["Why", "Scope", "Out of scope", "Decisions", "Features", "Dependencies", "Open questions"]) expect(form).toContain(`>${t}</label>`);
  });

  it("uses the project's sections instead", async () => {
    const s = await seed({ nom: "Widget", epiques: { rubriques: [{ cle: "pitch", titre: "Pitch" }] } });
    const form = await (await get(`/projects/${REPO}/cards/new?kind=epic`, s.cookie)).text();
    expect(form).toContain(">Pitch</label>");
    expect(form).not.toContain(">Scope</label>");
  });

  it("writes, versions, hides from the board and keeps its type", async () => {
    const s = await seed();
    const r = await post(`/projects/${REPO}/cards`, { csrf: s.csrf, action: "save", kind: "epic", status: "draft", title: "Refinement", section_why: "Because", release: "Next release" }, s.cookie);
    const id = Number(/cards\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1]);
    const card = await findCard(env.DB, REPO, id);
    expect(card?.kind).toBe("epic");
    expect(card?.release).toBeNull();
    expect(card?.body).toBe("## Why\n\nBecause");

    await post(`/projects/${REPO}/cards/${id}`, { csrf: s.csrf, action: "save", kind: "feature", status: "draft", title: "Refinement", section_why: "Because", section_scope: "More", rev: "1" }, s.cookie);
    const after = await findCard(env.DB, REPO, id);
    expect(after?.kind).toBe("epic");
    expect(after?.rev).toBe(2);

    const page = await (await get(`/projects/${REPO}/cards/${id}`, s.cookie)).text();
    expect(page).toContain("Version 2");
    expect(page).not.toContain("Make one story");
    expect(page).not.toContain("Split into stories");
    expect(page).toContain("<h2>Document</h2>");

    const board = await (await get(`/projects/${REPO}/board`, s.cookie)).text();
    expect(board).not.toContain(`card-${id}"`);
    expect((await listCards(env.DB, REPO)).filter((c) => c.kind === "epic")).toHaveLength(1);
  });

  it("does not offer a feature to become an epic", async () => {
    const s = await seed();
    const r = await post(`/projects/${REPO}/cards`, { csrf: s.csrf, action: "save", kind: "feature", status: "draft", title: "F" }, s.cookie);
    const id = Number(/cards\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1]);
    const form = await (await get(`/projects/${REPO}/cards/${id}/edit`, s.cookie)).text();
    expect(form).not.toContain('<option value="epic"');
    await post(`/projects/${REPO}/cards/${id}`, { csrf: s.csrf, action: "save", kind: "epic", status: "draft", title: "F", body: "x", rev: "1" }, s.cookie);
    expect((await findCard(env.DB, REPO, id))?.kind).toBe("feature");
  });
});

describe("Epic cards as values of the Epic dimension", () => {
  it("lists epic cards as values, keeps links on rename, filters and groups", async () => {
    const s = await seed();
    const mk = async (fields: Record<string, string>) => {
      const r = await post(`/projects/${REPO}/cards`, { csrf: s.csrf, action: "save", status: "draft", ...fields }, s.cookie);
      return Number(/cards\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1]);
    };
    const epic = await mk({ kind: "epic", title: "Refinement" });
    const feat = await mk({ kind: "feature", title: "Feat A" });
    const legacy = await mk({ kind: "feature", title: "Feat B", epic: "Old epic" });
    const { dimensionValues } = await import("../src/cards");
    const values = await dimensionValues(env.DB, REPO, await listCards(env.DB, REPO));
    expect(values.epic).toEqual(expect.arrayContaining(["Refinement", "Old epic"]));

    await post(`/projects/${REPO}/cards/${feat}`, { csrf: s.csrf, action: "set_epic", epic: "Refinement" }, s.cookie);
    expect((await findCard(env.DB, REPO, legacy))?.epic).toBe("Old epic");
    let page = await (await get(`/projects/${REPO}/cards/${epic}`, s.cookie)).text();
    expect(page).toContain("Feat A");
    expect(page).toContain("<h3>Draft");

    const { setFeatureEpic, featureEpicTitles } = await import("../src/card-epics");
    void setFeatureEpic;
    await env.DB.prepare("UPDATE cards SET title = 'Renamed' WHERE id = ?").bind(epic).run();
    expect((await findCard(env.DB, REPO, feat))?.epic).toBe("Refinement");
    expect((await featureEpicTitles(env.DB, REPO)).get(feat)).toBe("Renamed");
    page = await (await get(`/projects/${REPO}/cards/${epic}`, s.cookie)).text();
    expect(page).toContain("Feat A");
    const board = await (await get(`/projects/${REPO}/board?epic=Renamed`, s.cookie)).text();
    expect(board).toContain("Feat A");
    expect(board).not.toContain("Feat B");
  });
});
