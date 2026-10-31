import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
  ]);
}

const CARDS = {
  cards: [
    {
      title: "Choisir combien de temps on garde mes données",
      body: "Mes repas, courses et tickets : gardés tant que le compte vit, ou 6 mois à 3 ans. {domain: Compte}",
      kind: "feature",
      status: "validated",
      release: "v1.169",
      data: { spec: { answers: { besoin: "Choisir la durée." }, questions: [], source: "person", at: "2026-10-30T00:00:00Z" }, split: { stories: [] } },
      links: [{ kind: "story", ref: "138" }, { kind: "issue", ref: "999" }],
    },
    { title: "Mes e-mails", kind: "nonsense", status: "nonsense", links: [{ kind: "story", ref: "#140" }] },
    { body: "no title" },
  ],
};

describe("Importing cards", () => {
  it("creates each card with its tags, spec and stories; skips those already there; logs it", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");
    expect(await (await get(`/projects/${REPO}/board`, session.cookie)).text()).toContain(`/cards/import">Import cards (JSON)</a>`);
    expect(await (await get(`/projects/${REPO}/cards/import`, session.cookie)).text()).toContain('enctype="multipart/form-data"');

    const response = await post(`/projects/${REPO}/cards/import`, { csrf: session.csrf, text: JSON.stringify(CARDS) }, session.cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/board?notice=imported&created=2&skipped=0`);
    const rows = (await env.DB.prepare("SELECT id, kind, status, release, domain, data FROM cards ORDER BY id").all<Record<string, string>>()).results;
    expect(rows.map((row) => [row["kind"], row["status"], row["release"], row["domain"]])).toEqual([
      ["feature", "validated", "v1.169", null],
      ["feature", "draft", null, null],
    ]);
    // The spec comes along, a pending split does not.
    expect(JSON.parse(rows[0]?.["data"] ?? "{}")).toEqual({ spec: CARDS.cards[0]?.data?.spec });
    const links = (await env.DB.prepare("SELECT card_id, kind, ref FROM card_links ORDER BY card_id, kind, ref").all()).results;
    expect(links).toEqual([
      { card_id: rows[0]?.["id"], kind: "story", ref: "138" },
      { card_id: rows[1]?.["id"], kind: "story", ref: "140" },
    ]);
    expect((await logActions()).filter((entry) => entry.action === "card_imported")).toHaveLength(2);

    // Twice: nothing new.
    const again = await SELF.fetch(`${BASE}/projects/${REPO}/cards/import`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: session.cookie },
      body: (() => {
        const form = new FormData();
        form.set("csrf", session.csrf);
        form.set("file", new File([JSON.stringify(CARDS)], "cards.json", { type: "application/json" }));
        return form;
      })(),
    });
    expect(again.headers.get("location")).toBe(`/projects/${REPO}/board?notice=imported&created=0&skipped=2`);
    const board = await (await get(again.headers.get("location") ?? "", session.cookie)).text();
    expect(board).toContain("0 cards imported; 2 skipped, already on the board.");
  });

  it("says what is wrong, and is not for a tester", async () => {
    await seed();
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");
    const bad = await post(`/projects/${REPO}/cards/import`, { csrf: session.csrf, text: "{not json" }, session.cookie);
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain("This is not JSON.");
    const empty = await post(`/projects/${REPO}/cards/import`, { csrf: session.csrf, text: "{}" }, session.cookie);
    expect(await empty.text()).toContain("No card found");
    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    expect((await get(`/projects/${REPO}/cards/import`, tester.cookie)).status).toBe(403);
  });
});
