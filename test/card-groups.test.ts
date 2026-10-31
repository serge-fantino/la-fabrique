import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const story = (number: number, title: string) => ({
  number, title, state: "open", labels: [], url: `https://github.com/${REPO}/issues/${number}`, author: null, parent: null,
  subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "", closedAt: null, pullRequests: [], branches: [], criteria: [],
});

// Stories #7, #8, #9; C1 made #7 and #8, C2 made #8 too; #9 from no card.
async function seed(): Promise<{ c1: number; c2: number }> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify([story(7, "Keep my data less long"), story(8, "Warn before deleting"), story(9, "Loose story")]),
    ),
  ]);
  const card = async (title: string, release: string | null, position: number) =>
    (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', ?, '', ?, ?, 'pe') RETURNING id")
      .bind(REPO, title, release, position)
      .first<{ id: number }>())?.id ?? 0;
  const c1 = await card("Data retention", "1.169", 1);
  const c2 = await card("Account e-mails", "1.170", 2);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '7')").bind(c1),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '8')").bind(c1),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '8')").bind(c2),
  ]);
  return { c1, c2 };
}

describe("Stories and backlog grouped by card", () => {
  it("groups the stories by card, newest release first; shared stories under each; the rest under No card", async () => {
    const { c1, c2 } = await seed();
    await grantRole("pe", "product_engineer");
    const session = await signIn("pe");

    const page = await (await get(`/projects/${REPO}/stories?group=card`, session.cookie)).text();
    expect(page).toContain('<option value="card" selected>Card</option>');
    const heads = [`>C${c2}</a> Account e-mails`, `>C${c1}</a> Data retention`, "<h2>No card"].map((head) => page.indexOf(head));
    expect(heads.every((at) => at > 0)).toBe(true);
    expect([...heads].sort((a, b) => a - b)).toEqual(heads);
    // #8 under both cards, saying where else it is.
    expect(page).toContain(`Warn before deleting</a> <span class="muted small">also in C${c1}</span>`);
    expect(page).toContain(`Warn before deleting</a> <span class="muted small">also in C${c2}</span>`);
    expect(page.slice(heads[2])).toContain("Loose story");
    expect(page.slice(heads[2])).not.toContain("Warn before deleting");

    const backlog = await (await get(`/projects/${REPO}/backlog?group=card`, session.cookie)).text();
    expect(backlog).toContain('href="/projects/acme/widget/backlog?group=card" aria-current="true">Card</a>');
    expect(backlog).toContain(`>C${c1}</a> Data retention`);
    expect(backlog.indexOf(`>C${c2}</a>`)).toBeLessThan(backlog.indexOf(`>C${c1}</a>`));
    expect(backlog).toContain("<h2>No card");
    // By priority, as before.
    expect(await (await get(`/projects/${REPO}/backlog`, session.cookie)).text()).not.toContain("<h2>No card");
  });
});
