import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { get, grantRole, logActions, post, signIn } from "./helpers";

// Into refinement in one go: a feature, or every feature of an epic.
const REPO = "acme/widget";

async function seed(): Promise<{ epic: number; loose: number; next: number; sprint: number; dropped: number }> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
  ]);
  const card = async (kind: string, title: string, release: string | null, status = "draft", epic: string | null = "Checkout") =>
    (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, epic, release, position, author) VALUES (?, ?, ?, ?, '', ?, ?, 1, 'pe') RETURNING id")
      .bind(REPO, kind, status, title, kind === "epic" ? null : epic, release)
      .first<{ id: number }>())!.id;
  const epic = await card("epic", "Checkout", null);
  // The epic already has its GitHub issue: nothing is created on GitHub.
  await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'epic_issue', '500')").bind(epic).run();
  return {
    epic,
    loose: await card("feature", "Pay by card", null),
    next: await card("feature", "Pay later", "Next release"),
    sprint: await card("feature", "Receipt", "Sprint", "validated"),
    dropped: await card("feature", "Pay in cash", null, "dropped"),
  };
}

const releaseOf = async (id: number) => (await env.DB.prepare("SELECT release FROM cards WHERE id = ?").bind(id).first<{ release: string | null }>())?.release ?? null;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Move to refinement", () => {
  it("moves every refinable feature of an epic into Next release, and leaves the others where they are", async () => {
    const ids = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const url = `/projects/${REPO}/cards/${ids.epic}`;
    expect(await (await get(url, cookie)).text()).toContain("Move its 1 feature to refinement</button>");

    const response = await post(url, { csrf, action: "to_refinement" }, cookie);
    expect(response.headers.get("location")).toBe(`${url}?notice=refinement&moved=1`);
    expect(await releaseOf(ids.loose)).toBe("Next release");
    expect(await releaseOf(ids.next)).toBe("Next release");
    expect(await releaseOf(ids.sprint)).toBe("Sprint");
    expect(await releaseOf(ids.dropped)).toBeNull();
    const logged = (await logActions()).filter((entry) => entry.action === "cards_to_refinement");
    expect(logged.map((entry) => JSON.parse(entry.details ?? "{}"))).toEqual([{ cards: [ids.loose], epic: ids.epic }]);

    const after = await (await get(`${url}?notice=refinement&moved=1`, cookie)).text();
    expect(after).toContain("1 feature of this epic moved into refinement");
    expect(after).not.toContain("to refinement</button>");
    expect(after).toContain(">Open Refinement</a>");
  });

  it("moves one feature, then says it is in refinement", async () => {
    const ids = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const url = `/projects/${REPO}/cards/${ids.loose}`;
    expect(await (await get(url, cookie)).text()).toContain(">Move to refinement</button>");
    await post(url, { csrf, action: "to_refinement" }, cookie);
    expect(await releaseOf(ids.loose)).toBe("Next release");
    expect(await (await get(url, cookie)).text()).toContain(">In refinement</span>");
    // Nothing to move: unchanged.
    const again = await post(`/projects/${REPO}/cards/${ids.sprint}`, { csrf, action: "to_refinement" }, cookie);
    expect(again.headers.get("location")).toBe(`/projects/${REPO}/cards/${ids.sprint}?notice=unchanged`);
  });

  it("is not for a tester", async () => {
    const ids = await seed();
    await grantRole("tess", "tester");
    const { cookie, csrf } = await signIn("tess");
    const response = await post(`/projects/${REPO}/cards/${ids.loose}`, { csrf, action: "to_refinement" }, cookie);
    expect(response.status).toBe(403);
    expect(await releaseOf(ids.loose)).toBeNull();
  });
});
