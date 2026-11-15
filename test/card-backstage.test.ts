import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Story } from "../src/stories";
import { get, grantRole, logActions, post, signIn } from "./helpers";

// A feature behind the scenes (la-fabrique#366): the flag on the card, the
// label on its stories.
const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const CONFIG = { nom: "Widget" };

function story(number: number, labels: string[] = []): Story {
  return {
    number, title: `Story ${number}`, state: "open", url: "", author: null, labels, parent: null, subTotal: 0, subCompleted: 0, createdAt: "", updatedAt: "",
    closedAt: null, pullRequests: [], branches: [], criteria: [{ text: "Works", done: false }],
  };
}

async function seed(): Promise<{ id: number; other: number }> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(REPO, JSON.stringify([story(21), story(22)])),
  ]);
  const card = async (title: string, position: number) =>
    (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author) VALUES (?, 'feature', 'validated', ?, '', 'Next release', ?, 'pe') RETURNING id")
      .bind(REPO, title, position)
      .first<{ id: number }>())!.id;
  const id = await card("Tooling", 1);
  const other = await card("Shared", 2);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '21')").bind(id),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '22')").bind(id),
    env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', '22')").bind(other),
  ]);
  return { id, other };
}

const labels = async () =>
  new Map(
    (JSON.parse((await env.DB.prepare("SELECT data FROM snapshots WHERE repo = ? AND kind = 'stories'").bind(REPO).first<{ data: string }>())!.data) as Story[]).map((s) => [s.number, s.labels]),
  );

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("A feature behind the scenes", () => {
  it("puts the card behind the scenes and labels its stories, then takes it back out, keeping a story another backstage card shares", async () => {
    const { id, other } = await seed();
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const url = `/projects/${REPO}/cards/${id}`;
    expect(await (await get(url, cookie)).text()).toContain(">Public release note</button>");

    const gh = () => fetchMock.get("https://api.github.com");
    gh().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    let created = "";
    gh()
      .intercept({ method: "POST", path: `/repos/${REPO}/labels` })
      .reply(201, (options) => {
        created = JSON.parse(String(options.body)).name;
        return "{}";
      });
    gh().intercept({ method: "POST", path: `/repos/${REPO}/issues/21/labels` }).reply(200, "[]", JSON_HEADERS);
    gh().intercept({ method: "POST", path: `/repos/${REPO}/issues/22/labels` }).reply(200, "[]", JSON_HEADERS);
    const on = await post(url, { csrf, action: "backstage", backstage: "1" }, cookie);
    expect(on.headers.get("location")).toBe(`${url}?notice=backstage`);
    expect(created).toBe("coulisses");
    expect((await env.DB.prepare("SELECT backstage FROM cards WHERE id = ?").bind(id).first<{ backstage: number }>())?.backstage).toBe(1);
    expect(await labels()).toEqual(new Map([[21, ["coulisses"]], [22, ["coulisses"]]]));
    expect((await logActions()).map((entry) => entry.action)).toEqual(expect.arrayContaining(["card_backstage_set", "card_backstage_applied"]));
    const page = await (await get(url, cookie)).text();
    expect(page).toContain('aria-pressed="true"');
    expect(page).toContain(">Behind the scenes</button>");
    expect(await (await get(`/projects/${REPO}/board`, cookie)).text()).toContain(">Behind the scenes</span>");

    // #22 is also in another card behind the scenes: it keeps the label.
    await env.DB.prepare("UPDATE cards SET backstage = 1 WHERE id = ?").bind(other).run();
    gh().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "t" }), JSON_HEADERS);
    gh().intercept({ method: "DELETE", path: `/repos/${REPO}/issues/21/labels/coulisses` }).reply(200, "[]", JSON_HEADERS);
    const off = await post(url, { csrf, action: "backstage", backstage: "0" }, cookie);
    expect(off.headers.get("location")).toBe(`${url}?notice=public`);
    expect(await labels()).toEqual(new Map([[21, []], [22, ["coulisses"]]]));
  });

  it("is not for an epic", async () => {
    await seed();
    const epic = (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, position, author) VALUES (?, 'epic', 'draft', 'F9', '', 9, 'pe') RETURNING id").bind(REPO).first<{ id: number }>())!.id;
    await grantRole("pe", "product_engineer");
    const { cookie, csrf } = await signIn("pe");
    const url = `/projects/${REPO}/cards/${epic}`;
    expect(await (await get(url, cookie)).text()).not.toContain("Public release note");
    await post(url, { csrf, action: "backstage", backstage: "1" }, cookie);
    expect((await env.DB.prepare("SELECT backstage FROM cards WHERE id = ?").bind(epic).first<{ backstage: number }>())?.backstage).toBe(0);
  });
});
