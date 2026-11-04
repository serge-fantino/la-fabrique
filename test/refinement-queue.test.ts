import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cancelJob, dispatch, ordinal, projectJobs } from "../src/jobs";
import { BASE, get, grantRole, post, signIn } from "./helpers";

const REPO = "acme/widget";
const CONFIG = { nom: "Widget" };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function card(title: string, position: number, data: object = {}): Promise<number> {
  return (await env.DB.prepare("INSERT INTO cards (repo, kind, status, title, body, release, position, author, data) VALUES (?, 'feature', 'shaping', ?, 'Body', 'Next release', ?, 'pe', ?) RETURNING id")
    .bind(REPO, title, position, JSON.stringify(data))
    .first<{ id: number }>())!.id;
}

async function setUp(count: number): Promise<{ cookie: string; csrf: string; ids: number[] }> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare("INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', 'abc', ?, '[]', '[]')").bind(REPO, JSON.stringify(CONFIG)),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', '2000-01-01T00:00:00.000Z')").bind(REPO),
  ]);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(await card(`Feature ${i + 1}`, i + 1));
  await grantRole("pe", "product_engineer");
  return { ...(await signIn("pe")), ids };
}

async function statuses(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT status FROM claude_jobs ORDER BY id").all<{ status: string }>();
  return results.map((row) => row.status);
}

describe("The queue of Claude's jobs", () => {
  it("says ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "21st", "22nd"]);
  });

  it("queues the ticked features: two run at once, the others wait in order, each logged", async () => {
    const { cookie, csrf, ids } = await setUp(3);
    const response = await post(`/projects/${REPO}/refinement`, { csrf, action: "refine_launch", card: String(ids[0]) }, cookie);
    expect(response.headers.get("location")).toContain("notice=launched");
    // Three features, launched one after the other as the form does for three ticks.
    await post(`/projects/${REPO}/refinement`, { csrf, action: "refine_launch", card: String(ids[1]) }, cookie);
    await post(`/projects/${REPO}/refinement`, { csrf, action: "refine_launch", card: String(ids[2]) }, cookie);
    expect(await statuses()).toEqual(["queued", "queued", "waiting"]);
    const log = await env.DB.prepare("SELECT text FROM claude_job_events WHERE job_id = 3 ORDER BY id").all<{ text: string }>();
    expect(log.results[0]?.text).toBe("Asked by @pe.");

    // Each card says its place.
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain("Waiting for its turn: 1st in line");
    expect(page).toContain(`data-job-state="${ids[2]}"`);
    expect(page).toContain("data-refinement-live");
    expect(page).toContain('value="job_cancel"');

    // A job ends: the waiting one is given to Claude.
    await env.DB.prepare("UPDATE claude_jobs SET status = 'done' WHERE id = 1").run();
    await dispatch(env);
    expect(await statuses()).toEqual(["done", "queued", "queued"]);
  });

  it("moves the places up as jobs end", async () => {
    const { ids } = await setUp(5);
    const insert = (cardId: number, status: string) =>
      env.DB.prepare("INSERT INTO claude_jobs (repo, card_id, kind, status, request, login) VALUES (?, ?, 'spec_draft', ?, '{}', 'pe')").bind(REPO, cardId, status);
    await env.DB.batch([insert(ids[0]!, "running"), insert(ids[1]!, "running"), insert(ids[2]!, "waiting"), insert(ids[3]!, "waiting"), insert(ids[4]!, "waiting")]);
    const places = async () => [...(await projectJobs(env.DB, REPO)).values()].map((entry) => entry.place);
    expect(await places()).toEqual([null, null, 1, 2, 3]);
    await env.DB.prepare("UPDATE claude_jobs SET status = 'failed', error = 'busy' WHERE id = 1").run();
    await dispatch(env);
    expect(await statuses()).toEqual(["failed", "running", "queued", "waiting", "waiting"]);
    expect(await places()).toEqual([null, null, null, 1, 2]);
  });

  it("cancels a job that has not started, never a running one", async () => {
    const { cookie, csrf, ids } = await setUp(3);
    for (const id of ids) await post(`/projects/${REPO}/refinement`, { csrf, action: "refine_launch", card: String(id) }, cookie);
    expect(await statuses()).toEqual(["queued", "queued", "waiting"]);
    const cancelled = await post(`/projects/${REPO}/refinement`, { csrf, action: "job_cancel", card: String(ids[2]) }, cookie);
    expect(cancelled.headers.get("location")).toContain("notice=cancelled");
    expect(await statuses()).toEqual(["queued", "queued", "cancelled"]);
    expect((await env.DB.prepare("SELECT text FROM claude_job_events WHERE job_id = 3 ORDER BY id DESC").first<{ text: string }>())?.text).toContain("Cancelled by @pe");
    // The card goes back to its next step: Specify is proposed again.
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain(`name="card" value="${ids[2]}" data-refine-tick`);

    await env.DB.prepare("UPDATE claude_jobs SET status = 'running', attempts = 1 WHERE id = 1").run();
    expect(await cancelJob(env, REPO, ids[0]!, "pe")).toMatchObject({ ok: false, message: expect.stringContaining("never cancelled") });
    expect((await statuses())[0]).toBe("running");
  });

  it("says why a job failed and proposes Try again, the others going on", async () => {
    const { cookie, csrf, ids } = await setUp(2);
    for (const id of ids) await post(`/projects/${REPO}/refinement`, { csrf, action: "refine_launch", card: String(id) }, cookie);
    await env.DB.prepare("UPDATE claude_jobs SET status = 'failed', error = 'Anthropic is busy' WHERE id = 1").run();
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain("Claude could not finish: Anthropic is busy");
    expect(page).toContain('value="job_retry"');
    const retry = await post(`/projects/${REPO}/refinement`, { csrf, action: "job_retry", card: String(ids[0]) }, cookie);
    expect(retry.headers.get("location")).toContain("notice=launched");
    expect(await statuses()).toEqual(["failed", "queued", "queued"]);
  });

  it("says the calls it takes and launches nothing beyond the daily quota", async () => {
    const { cookie, csrf, ids } = await setUp(4);
    const page = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(page).toContain("one call each");
    expect(page).toContain('data-calls-left="3"');
    const form = new URLSearchParams({ csrf, action: "refine_launch" });
    for (const id of ids) form.append("card", String(id));
    const refused = await SELF.fetch(`${BASE}/projects/${REPO}/refinement`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://la-fabrique.test" },
      body: form,
    });
    expect(decodeURIComponent(refused.headers.get("location") ?? "")).toContain("That takes 4 calls and you have 3 left today");
    expect(await statuses()).toEqual([]);
  });

  it("keeps every job where it was when the page comes back", async () => {
    const { cookie, csrf, ids } = await setUp(3);
    for (const id of ids) await post(`/projects/${REPO}/refinement`, { csrf, action: "refine_launch", card: String(id) }, cookie);
    const first = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    const again = await (await get(`/projects/${REPO}/refinement`, cookie)).text();
    expect(again).toContain("Waiting for its turn: 1st in line");
    expect(again.match(/data-job-state="\d+"[^>]*>(?!<\/p>)/g)?.length).toBe(first.match(/data-job-state="\d+"[^>]*>(?!<\/p>)/g)?.length);
    expect(await statuses()).toEqual(["queued", "queued", "waiting"]);
  });
});
