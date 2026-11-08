import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { epicIssueView, startFromIssue, takenEpicIssues } from "../src/epic-issue";
import { epicIssueSectionForTest } from "../src/card-views";
import { findCard } from "../src/cards";
import { post, grantRole, signIn } from "./helpers";
import type { Story } from "../src/stories";

const REPO = "acme/widget";
const story = (number: number, extra: Partial<Story> = {}): Story =>
  ({ number, title: `Story ${number}`, state: "open", url: `https://github.com/${REPO}/issues/${number}`, labels: [], parent: null, ...extra }) as unknown as Story;

async function make(s: { cookie: string; csrf: string }, kind: string, title: string, epic = ""): Promise<number> {
  const r = await post(`/projects/${REPO}/cards`, { csrf: s.csrf, action: "save", kind, status: "draft", title, epic }, s.cookie);
  return Number(/cards\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1]);
}

describe("Epic card from an existing epic issue", () => {
  it("links the issue, attaches the features of its stories, keeps other epics, lists the rest under No feature", async () => {
    await env.DB.batch([env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO)]);
    await grantRole("pe", "product_engineer");
    const s = await signIn("pe");
    const epicId = await make(s, "epic", "Refinement");
    const f1 = await make(s, "feature", "One");
    const f2 = await make(s, "feature", "Two", "Other");
    for (const [card, n] of [[f1, 11], [f2, 12]] as const) await env.DB.prepare("INSERT INTO card_links (card_id, kind, ref) VALUES (?, 'story', ?)").bind(card, String(n)).run();
    const stories = [story(10, { labels: ["epique"], title: "The epic" }), story(11, { parent: 10 }), story(12, { parent: 10 }), story(13, { parent: 10 }), story(14, { parent: 99 })];
    const epic = (await findCard(env.DB, REPO, epicId))!;
    const result = await startFromIssue(env.DB, epic, 10, stories, "pe");
    expect(result).toMatchObject({ linked: true, attached: [f1], kept: [[f2, "Other"]] });
    expect((await findCard(env.DB, REPO, f1))?.epic).toBe("Refinement");
    expect((await findCard(env.DB, REPO, f2))?.epic).toBe("Other");
    expect((await findCard(env.DB, REPO, epicId))?.body).not.toContain("epic");
    const view = await epicIssueView(env.DB, REPO, 10, stories);
    expect(view.noFeature.map((x) => x.number)).toEqual([13]);
    expect(view.url).toContain("/issues/10");
    // One epic card per issue.
    const other = (await findCard(env.DB, REPO, await make(s, "epic", "Second")))!;
    expect(await startFromIssue(env.DB, other, 10, stories, "pe")).toMatchObject({ linked: false, reason: "taken" });
    expect(await startFromIssue(env.DB, other, 11, stories, "pe")).toMatchObject({ linked: false, reason: "unknown" });
    expect((await takenEpicIssues(env.DB, REPO)).get(10)).toBe(epicId);
    const html = epicIssueSectionForTest({ epicIssue: view, keptFeatures: 1 });
    expect(html).toContain("No feature");
    expect(html).toContain(`href="https://github.com/${REPO}/issues/13"`);
  });
});
