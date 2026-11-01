import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { featurePath, featureText, recordedCriteria, scenarioText } from "../src/gherkin";
import { get, grantRole, logActions, post, signIn } from "./helpers";
import { addProject, CONFIG, REPO } from "./oauth-helpers";

const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const github = () => fetchMock.get("https://api.github.com");

const STEPS = [
  { kind: "page", name: "", page: "/orders" },
  { kind: "fill", name: "Quantity", page: "/orders" },
  { kind: "click", name: "Save", page: "/orders" },
  { kind: "page", name: "", page: "/orders/1" },
];

async function record(index: number, text: string, done: boolean, steps: unknown[], story = 146): Promise<void> {
  await env.DB.prepare("INSERT INTO activity_log (actor, action, repo, issue_number, details) VALUES ('mona', 'story_test_recorded', ?, ?, ?)")
    .bind(REPO, story, JSON.stringify({ index, text, done, version: "1.0", steps }))
    .run();
}

describe("A recorded criterion as a Gherkin scenario (la-fabrique#168)", () => {
  it("writes Given from the first page, When/And from the steps, Then from the criterion", () => {
    const text = scenarioText({ index: 0, text: 'It saves "fast"', steps: STEPS as never });
    expect(text).toBe(
      [
        "  Scenario: It saves \"fast\"",
        '    Given I am on "/orders"',
        '    When I fill in "Quantity"',
        '    And I click "Save"',
        '    And I go to "/orders/1"',
        "    Then It saves \"fast\"",
      ].join("\n"),
    );
    expect(featureText("Orders", [{ index: 0, text: "It saves", steps: STEPS as never }])).toMatch(/^Feature: Orders\n\n  Scenario: It saves\n/);
    expect(featurePath(146)).toBe("features/story-146.feature");
  });

  it("keeps the latest recording of a criterion that ticked it and kept steps", async () => {
    await record(0, "Old", true, STEPS);
    await record(0, "It saves", true, STEPS);
    await record(1, "Unticked", false, STEPS);
    await record(2, "No steps", true, []);
    await record(0, "It saves", true, [], 147);
    const found = await recordedCriteria(env.DB, REPO, 146);
    expect(found.map((item) => item.text)).toEqual(["It saves"]);
  });

  it("shows it on the story's page, with Copy and Propose", async () => {
    await addProject(CONFIG);
    await record(0, "It saves", true, STEPS);
    await grantRole("tess", "tester");
    const { cookie } = await signIn("tess");
    await env.DB.prepare("INSERT OR REPLACE INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)").bind(REPO, new Date().toISOString()).run();
    const page = await (await get(`/projects/${REPO}/sprint/stories/146`, cookie)).text();
    expect(page).toContain("Scenario: It saves");
    expect(page).toContain("Given I am on &quot;/orders&quot;");
    expect(page).toContain("data-copy=");
    expect(page).toContain("Propose to the project");
  });

  it("proposes features/story-N.feature as a pull request on the integration branch, in the person's name, and logs it", async () => {
    await addProject({ ...CONFIG, branches: { production: "main", integration: "integration" } } as never);
    await record(0, "It saves", true, STEPS);
    await env.DB.prepare("INSERT OR REPLACE INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', '[]', ?)").bind(REPO, new Date().toISOString()).run();
    await grantRole("tess", "tester");
    const { cookie, csrf } = await signIn("tess");
    github().intercept({ path: `/repos/${REPO}/git/ref/heads/integration` }).reply(200, JSON.stringify({ object: { sha: "abc" } }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/contents/features/story-146.feature?ref=integration` }).reply(404, "{}", JSON_HEADERS);
    github().intercept({ method: "POST", path: `/repos/${REPO}/git/refs` }).reply(201, "{}", JSON_HEADERS);
    let commit = null as { content: string; branch: string } | null;
    github()
      .intercept({ method: "PUT", path: `/repos/${REPO}/contents/features/story-146.feature` })
      .reply(201, (options) => {
        commit = JSON.parse(String(options.body));
        return "{}";
      });
    let pull = null as { base: string; body: string } | null;
    github()
      .intercept({ method: "POST", path: `/repos/${REPO}/pulls` })
      .reply(201, (options) => {
        pull = JSON.parse(String(options.body));
        return JSON.stringify({ number: 77, html_url: `https://github.com/${REPO}/pull/77` });
      });
    const response = await post(`/projects/${REPO}/to-test/feature`, { csrf, issue: "146" }, cookie);
    expect(response.headers.get("location")).toContain(`/sprint/stories/146?feature=77`);
    expect(pull?.base).toBe("integration");
    expect(pull?.body).toContain("@tess");
    expect(pull?.body.startsWith("Refs #146")).toBe(true);
    expect(new TextDecoder().decode(Uint8Array.from(atob(commit?.content ?? ""), (c) => c.charCodeAt(0)))).toContain("Scenario: It saves");
    expect(commit?.branch.startsWith("fabrique/feature-146-")).toBe(true);
    expect(await logActions()).toContainEqual(expect.objectContaining({ actor: "tess", action: "feature_proposed" }));
  });
});
