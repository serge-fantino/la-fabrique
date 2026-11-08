import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { findCard } from "../src/cards";
import type { Card } from "../src/cards";
import { epicStateOf } from "../src/epic-status";
import type { Progress } from "../src/progress-stages";
import { get, grantRole, logActions, post, signIn } from "./helpers";

const REPO = "acme/widget";

const feature = (id: number, extra: Partial<Card> = {}): Card => ({ id, kind: "feature", status: "validated", release: null, archivedAt: null, ...extra }) as Card;
const at = (stage: Progress["stage"]): Progress => ({ stage, done: 1, total: 1 });

describe("epicStateOf", () => {
  const epic = { status: "draft" as const };
  it("follows the features", () => {
    expect(epicStateOf(epic, [], new Map(), null).status).toBe("ideation");
    expect(epicStateOf(epic, [feature(1)], new Map([[1, at("ready")]]), null).status).toBe("open");
    expect(epicStateOf(epic, [feature(1), feature(2)], new Map([[1, at("in_production")], [2, at("in_dev")]]), null).status).toBe("active");
    expect(epicStateOf(epic, [feature(1)], new Map(), "Sprint 1").status).toBe("open");
    expect(epicStateOf(epic, [feature(1, { release: "Sprint 1" })], new Map(), "Sprint 1").status).toBe("active");
    expect(epicStateOf(epic, [feature(1), feature(2, { status: "dropped" })], new Map([[1, at("in_production")]]), null).status).toBe("done");
    expect(epicStateOf({ status: "dropped" }, [], new Map(), null).status).toBe("dropped");
  });
});

describe("The Epics tab", () => {
  async function seed(): Promise<{ cookie: string; csrf: string }> {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
      env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify({ nom: "Widget" })),
    ]);
    await grantRole("pe", "product_engineer");
    return signIn("pe");
  }

  it("lists epics with status and count, drops, archives and unarchives", async () => {
    const s = await seed();
    const mk = async (fields: Record<string, string>) => {
      const r = await post(`/projects/${REPO}/cards`, { csrf: s.csrf, action: "save", status: "draft", ...fields }, s.cookie);
      return Number(/cards\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1]);
    };
    const idea = await mk({ kind: "epic", title: "Idea" });
    const busy = await mk({ kind: "epic", title: "Busy" });
    const finished = await mk({ kind: "epic", title: "Finished" });
    const f1 = await mk({ kind: "feature", title: "F1" });
    const f2 = await mk({ kind: "feature", title: "F2", status: "dropped" });
    await post(`/projects/${REPO}/cards/${f1}`, { csrf: s.csrf, action: "set_epic", epic: "Busy" }, s.cookie);
    await post(`/projects/${REPO}/cards/${f2}`, { csrf: s.csrf, action: "set_epic", epic: "Finished" }, s.cookie);

    const tab = await (await get(`/projects/${REPO}/epics`, s.cookie)).text();
    expect(tab).toContain("Idea");
    expect(tab).toContain("Ideation");
    expect(tab).toContain("Open");
    expect(tab).toContain("Done");

    // Dropped only in Ideation; Archive only when Done.
    expect(tab).toContain(`/cards/${idea}"`);
    const busyPage = await (await get(`/projects/${REPO}/cards/${busy}`, s.cookie)).text();
    expect(busyPage).not.toContain('value="epic_drop"');
    expect(busyPage).not.toContain('value="epic_archive"');
    await post(`/projects/${REPO}/cards/${busy}`, { csrf: s.csrf, action: "epic_drop" }, s.cookie);
    expect((await findCard(env.DB, REPO, busy))?.status).not.toBe("dropped");
    await post(`/projects/${REPO}/cards/${busy}`, { csrf: s.csrf, action: "epic_archive" }, s.cookie);
    expect((await findCard(env.DB, REPO, busy))?.archivedAt).toBeNull();

    const ideaPage = await (await get(`/projects/${REPO}/cards/${idea}`, s.cookie)).text();
    expect(ideaPage).toContain('value="epic_drop"');
    await post(`/projects/${REPO}/cards/${idea}`, { csrf: s.csrf, action: "epic_drop" }, s.cookie);
    expect((await findCard(env.DB, REPO, idea))?.status).toBe("dropped");

    await post(`/projects/${REPO}/cards/${finished}`, { csrf: s.csrf, action: "epic_archive", back: "epics" }, s.cookie);
    expect((await findCard(env.DB, REPO, finished))?.archivedAt).not.toBeNull();
    const after = await (await get(`/projects/${REPO}/epics`, s.cookie)).text();
    expect(after).not.toContain("Finished");
    const shown = await (await get(`/projects/${REPO}/epics?archived=1`, s.cookie)).text();
    expect(shown).toContain("Finished");
    expect(shown).toContain('value="epic_unarchive"');

    await post(`/projects/${REPO}/cards/${finished}`, { csrf: s.csrf, action: "epic_unarchive" }, s.cookie);
    expect((await findCard(env.DB, REPO, finished))?.archivedAt).toBeNull();
    expect(await (await get(`/projects/${REPO}/epics`, s.cookie)).text()).toContain("Finished");

    const page = await (await get(`/projects/${REPO}/cards/${finished}`, s.cookie)).text();
    expect(page).toContain("Status history");
    expect(page).toContain("archived");
    expect(page).toContain("unarchived");
    const actions = (await logActions()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["epic_status_changed", "epic_archived", "epic_unarchived"]));
  });

  it("is a tab of the Product perspective", async () => {
    const s = await seed();
    const page = await (await get(`/projects/${REPO}/board`, s.cookie)).text();
    expect(page).toContain(`/projects/${REPO}/epics"`);
  });
});
