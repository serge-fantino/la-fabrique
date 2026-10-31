import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { annotations, excerpt, linksOf, rewriteAnnotation } from "../src/cards";
import { BASE, get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')",
    ).bind(REPO, JSON.stringify({ nom: "Widget" })),
  ]);
}

async function writer(): Promise<{ cookie: string; csrf: string }> {
  await grantRole("pe", "product_engineer");
  return signIn("pe");
}

async function newCard(session: { cookie: string; csrf: string }, fields: Record<string, string>): Promise<number> {
  const response = await post(`/projects/${REPO}/cards`, { csrf: session.csrf, action: "save", kind: "feature", status: "draft", ...fields }, session.cookie);
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(new RegExp(`^/projects/${REPO}/cards/\\d+\\?created=1$`));
  return Number(/cards\/(\d+)/.exec(location)?.[1]);
}

function move(session: { cookie: string; csrf: string }, fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}/projects/${REPO}/board`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrf, action: "move", ...fields }).toString(),
  });
}

describe("Card text", () => {
  it("reads annotations, links and a plain excerpt", () => {
    const body = "For {segment: Pro} shops, see #12 with @Octo-Cat about [[Basket]].\n\n- **fast** {release: 2026-Q1}";
    expect(annotations(body)).toEqual({ segment: "Pro", release: "2026-Q1" });
    expect(linksOf(body)).toEqual([
      { kind: "issue", ref: "12" },
      { kind: "person", ref: "octo-cat" },
      { kind: "term", ref: "Basket" },
    ]);
    expect(excerpt(body)).toBe("For shops, see #12 with @Octo-Cat about Basket. fast");
  });

  it("rewrites an annotation when the card moves, and removes it when the value goes", () => {
    expect(rewriteAnnotation("For {segment: pro} shops", "segment", "b2c")).toBe("For {segment: b2c} shops");
    expect(rewriteAnnotation("For {segment: pro} shops", "segment", null)).toBe("For shops");
    expect(rewriteAnnotation("No annotation", "segment", "b2c")).toBe("No annotation");
  });
});

describe("Cards", () => {
  it("writes a card in La Fabrique, its first version and a log line; nothing goes to GitHub", async () => {
    await seed();
    const session = await writer();
    const id = await newCard(session, { title: "Quick reorder", body: "Reorder last week's basket. {segment: pro} See #12 and [[Basket]].", segment: "ignored" });

    const row = await env.DB.prepare("SELECT kind, status, segment, rev, author FROM cards WHERE id = ?").bind(id).first();
    expect(row).toEqual({ kind: "feature", status: "draft", segment: "pro", rev: 1, author: "pe" });
    const revisions = await env.DB.prepare("SELECT rev, title FROM card_revisions WHERE card_id = ?").bind(id).all();
    expect(revisions.results).toEqual([{ rev: 1, title: "Quick reorder" }]);
    expect((await logActions()).map((entry) => entry.action)).toEqual(["card_created"]);

    const page = await (await get(`/projects/${REPO}/cards/${id}?created=1`, session.cookie)).text();
    expect(page).toContain(`Card C${id} written.`);
    expect(page).toContain(`<a target="_blank" rel="noopener noreferrer" href="https://github.com/${REPO}/issues/12">#12</a>`);
    expect(page).toContain('<span class="term" title="Glossary term">Basket</span>');
    expect(page).toContain('<span class="tag"><span class="tag-dim">Segment</span> pro</span>');
  });

  it("refuses a card without a title, and a tester's card", async () => {
    await seed();
    const session = await writer();
    const empty = await post(`/projects/${REPO}/cards`, { csrf: session.csrf, title: "  ", body: "text" }, session.cookie);
    expect(empty.status).toBe(422);
    expect(await empty.text()).toContain("A card needs a title.");

    await grantRole("tess", "tester");
    const tester = await signIn("tess");
    expect((await post(`/projects/${REPO}/cards`, { csrf: tester.csrf, title: "Mine" }, tester.cookie)).status).toBe(403);
    // A tester reads the board, without the handles.
    const board = await (await get(`/projects/${REPO}/board?by=status`, tester.cookie)).text();
    expect(board).not.toContain("New card</a>");
    expect(board).not.toContain("data-grip");
  });

  it("arranges the board by one dimension, then another, and filters it", async () => {
    await seed();
    const session = await writer();
    await newCard(session, { title: "Pro reorder", segment: "pro", domain: "Basket" });
    await newCard(session, { title: "Family menu", segment: "family", domain: "Menu" });
    await newCard(session, { title: "Loose idea", kind: "idea" });

    const byStatus = await (await get(`/projects/${REPO}/board?by=status`, session.cookie)).text();
    expect(byStatus).toContain("<strong>3 cards</strong>");
    expect(byStatus).toContain('data-cell data-set-status="draft"');
    expect(byStatus).toContain('<script src="/board.js?v=');

    const crossed = await (await get(`/projects/${REPO}/board?by=segment&then=domain`, session.cookie)).text();
    expect(crossed).toContain('data-cell data-set-segment="pro" data-set-domain="Basket"');
    // New lanes from the header: a segment for the lanes, a domain for the groups.
    expect(crossed).toContain('<summary class="button quiet">New lane</summary>');
    expect(crossed).toContain('placeholder="New segment"');
    expect(crossed).toContain('<summary class="button quiet">New group</summary>');
    expect(crossed).toContain('placeholder="New domain"');
    expect(crossed).toContain("Lane\n      <select name=\"by\"");
    expect(crossed).toContain("Group by\n      <select name=\"then\"");
    const proCell = crossed.slice(crossed.indexOf('data-set-segment="pro" data-set-domain="Basket"'));
    expect(proCell.slice(0, proCell.indexOf("</div>\n"))).toContain("Pro reorder");

    const filtered = await (await get(`/projects/${REPO}/board?by=none&kind=idea`, session.cookie)).text();
    expect(filtered).toContain("<strong>1 card</strong> of 3");
    expect(filtered).toContain("Loose idea");
    expect(filtered).not.toContain("Family menu");

    const searched = await (await get(`/projects/${REPO}/board?by=none&q=reorder`, session.cookie)).text();
    expect(searched).toContain("Pro reorder");
    expect(searched).not.toContain("Loose idea");
  });

  it("moves a card: it takes the place's values, its text follows, a version and a log line", async () => {
    await seed();
    const session = await writer();
    const first = await newCard(session, { title: "First", body: "For {segment: pro} shops." });
    const second = await newCard(session, { title: "Second" });

    const response = await move(session, { card: String(first), set_segment: "family", set_status: "shaping", after: String(second) });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { ok: boolean; html: string };
    expect(answer.html).toContain('<span class="pill card-shaping">Shaping</span>');
    expect(answer.html).toContain("family");

    const row = await env.DB.prepare("SELECT body, segment, status, rev, position FROM cards WHERE id = ?").bind(first).first<{
      body: string;
      segment: string;
      status: string;
      rev: number;
      position: number;
    }>();
    expect(row).toMatchObject({ body: "For {segment: family} shops.", segment: "family", status: "shaping", rev: 2 });
    const other = await env.DB.prepare("SELECT position FROM cards WHERE id = ?").bind(second).first<{ position: number }>();
    expect(row?.position).toBeGreaterThan(other?.position ?? Infinity);
    const log = await logActions();
    expect(log.at(-1)?.action).toBe("card_moved");
    expect(JSON.parse(log.at(-1)?.details ?? "{}")).toMatchObject({
      card: first,
      changes: [
        { dimension: "status", from: "draft", to: "shaping" },
        { dimension: "segment", from: "pro", to: "family" },
      ],
    });

    // Order only: no new version, no log line.
    expect((await move(session, { card: String(first), set_segment: "family", set_status: "shaping", before: String(second) })).status).toBe(200);
    const reordered = await env.DB.prepare("SELECT rev, position FROM cards WHERE id = ?").bind(first).first<{ rev: number; position: number }>();
    expect(reordered?.rev).toBe(2);
    expect(reordered?.position).toBeLessThan(other?.position ?? -Infinity);
    expect((await logActions()).length).toBe(log.length);
  });

  it("refuses a move from a tester and an unknown card", async () => {
    await seed();
    const session = await writer();
    await grantRole("tess", "tester");
    const id = await newCard(session, { title: "First" });
    expect((await move(await signIn("tess"), { card: String(id), set_status: "validated" })).status).toBe(403);
    expect((await move(session, { card: "9999", set_status: "validated" })).status).toBe(404);
  });

  it("hides the empty lanes when asked: only the columns and rows that hold a card shown", async () => {
    await seed();
    const session = await writer();
    await newCard(session, { title: "Pro reorder", segment: "pro", domain: "Basket" });
    await newCard(session, { title: "Family menu", segment: "family", domain: "Menu" });

    const all = await (await get(`/projects/${REPO}/board?by=status&then=segment`, session.cookie)).text();
    expect(all).toContain('data-set-status="shaping"');
    expect(all).toContain('name="empty" value="hide" data-autosubmit /> Hide empty lanes');

    const hidden = await (await get(`/projects/${REPO}/board?by=status&then=segment&empty=hide&segment=pro`, session.cookie)).text();
    expect(hidden).toContain('name="empty" value="hide" checked');
    expect(hidden).toContain('data-cell data-set-status="draft" data-set-segment="pro"');
    expect(hidden).not.toContain('data-set-status="shaping"');
    expect(hidden).not.toContain('data-set-segment="family"');
    // The new group stays in the header.
    expect(hidden).toContain('placeholder="New segment"');
    expect(hidden).toContain(`board?by=status&amp;then=segment&amp;empty=hide">Clear the filters</a>`);
  });

  it("changes a card's status from its page, never on an archived card, and Claude never moves a dropped one", async () => {
    await seed();
    const session = await writer();
    const id = await newCard(session, { title: "Pro reorder" });
    const page = await (await get(`/projects/${REPO}/cards/${id}`, session.cookie)).text();
    expect(page).toContain('<input type="hidden" name="action" value="status" />');
    expect(page).toContain('<option value="draft" selected>Draft</option>');

    const response = await post(`/projects/${REPO}/cards/${id}`, { csrf: session.csrf, action: "status", status: "dropped" }, session.cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=status`);
    const after = await (await get(`/projects/${REPO}/cards/${id}?notice=status`, session.cookie)).text();
    expect(after).toContain("Status changed.");
    expect(after).toContain('<option value="dropped" selected>Dropped</option>');
    expect((await logActions()).map((entry) => entry.action)).toContain("card_moved");

    const { advanceStatus } = await import("../src/cards");
    expect(await advanceStatus(env.DB, REPO, id, "pe", "shaping", "Claude asked")).toBe(false);
    await post(`/projects/${REPO}/cards/${id}`, { csrf: session.csrf, action: "status", status: "to_validate" }, session.cookie);
    expect(await advanceStatus(env.DB, REPO, id, "pe", "shaping", "Claude asked")).toBe(false);
    expect(await advanceStatus(env.DB, REPO, id, "pe", "validated", "story made")).toBe(true);

    await post(`/projects/${REPO}/cards/${id}`, { csrf: session.csrf, action: "archive" }, session.cookie);
    const archived = await (await get(`/projects/${REPO}/cards/${id}`, session.cookie)).text();
    expect(archived).not.toContain('value="status"');
  });

  it("adds a column before any card uses it", async () => {
    await seed();
    const session = await writer();
    const response = await post(`/projects/${REPO}/board`, { csrf: session.csrf, action: "add_value", dimension: "release", value: "2026-Q1", back: "by=release" }, session.cookie);
    expect(response.headers.get("location")).toBe(`/projects/${REPO}/board?by=release&notice=added`);
    const board = await (await get(`/projects/${REPO}/board?by=release`, session.cookie)).text();
    expect(board).toContain('data-cell data-set-release="2026-Q1"');
    expect((await logActions()).map((entry) => entry.action)).toEqual(["card_value_added"]);
  });

  it("edits a card over the version one read, and keeps every version", async () => {
    await seed();
    const session = await writer();
    const id = await newCard(session, { title: "First" });
    const saved = await post(`/projects/${REPO}/cards/${id}`, { csrf: session.csrf, action: "save", rev: "1", title: "First, better", body: "Now with text.", kind: "feature", status: "draft" }, session.cookie);
    expect(saved.headers.get("location")).toBe(`/projects/${REPO}/cards/${id}?notice=saved`);

    const stale = await post(`/projects/${REPO}/cards/${id}`, { csrf: session.csrf, action: "save", rev: "1", title: "Stale edit", kind: "feature", status: "draft" }, session.cookie);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("Someone changed this card while you were editing it");

    const page = await (await get(`/projects/${REPO}/cards/${id}?rev=1`, session.cookie)).text();
    expect(page).toContain("Version 1 of 2");
    expect(page).toContain("<h1>First</h1>");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM card_revisions WHERE card_id = ?").bind(id).first())?.["n"]).toBe(2);
  });

  it("archives a card off the board, and exports every card with its versions", async () => {
    await seed();
    const session = await writer();
    const id = await newCard(session, { title: "Old idea" });
    await post(`/projects/${REPO}/cards/${id}`, { csrf: session.csrf, action: "archive" }, session.cookie);
    expect(await (await get(`/projects/${REPO}/board?by=status`, session.cookie)).text()).not.toContain("Old idea");
    expect(await (await get(`/projects/${REPO}/board?by=status&all=1`, session.cookie)).text()).toContain("Old idea");

    const exported = await get(`/projects/${REPO}/cards/export`, session.cookie);
    expect(exported.headers.get("content-disposition")).toBe('attachment; filename="acme-widget-cards.json"');
    const data = (await exported.json()) as { cards: { title: string; archivedAt: string | null; revisions: unknown[] }[] };
    expect(data.cards).toHaveLength(1);
    expect(data.cards[0]?.archivedAt).not.toBeNull();
    expect(data.cards[0]?.revisions).toHaveLength(1);
    expect((await logActions()).map((entry) => entry.action)).toEqual(["card_created", "card_archived"]);
  });

  it("shows card decisions in the project's log", async () => {
    await seed();
    const session = await writer();
    const id = await newCard(session, { title: "Logged" });
    const log = await (await get(`/projects/${REPO}/log?group=cards`, session.cookie)).text();
    expect(log).toContain(`wrote card <a class="mono" href="/projects/${REPO}/cards/${id}">C${id}</a> “Logged”`);
  });
});
