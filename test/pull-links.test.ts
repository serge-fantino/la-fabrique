import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { heldStories } from "../src/card-lock";
import { cardStories } from "../src/card-stories";
import { stageOf, cycleRules } from "../src/lifecycle";
import { namedStories, NO_LINKS, pullStories, type DevelopmentLinks } from "../src/pull-links";
import { loadStories } from "../src/stories";

const pull = (number: number, title: string, body: string | null, branch: string) => ({ number, title, body, head: { ref: branch } });

describe("Which story a pull request belongs to", () => {
  it("takes GitHub's own links first: the issues it closes, the branch linked to an issue", () => {
    const links: DevelopmentLinks = { closes: new Map([[40, [12]]]), branches: new Map([["fix-login", 15]]) };
    expect(pullStories(pull(40, "Login", "Also see #99", "topic"), links)).toEqual({ stories: [12], guessed: false });
    expect(pullStories(pull(41, "Login", "Story #99", "fix-login"), links)).toEqual({ stories: [15], guessed: false });
  });

  it("then the working branch's number, and ignores the text when it has one", () => {
    expect(pullStories(pull(42, "The go (story #102)", "Unlike #87, this one…", "claude/102-go-blocked"), NO_LINKS)).toEqual({ stories: [102], guessed: false });
  });

  it("falls back on a story named on purpose in the text, marked as guessed; a passing mention is not enough", () => {
    expect(pullStories(pull(43, "Tidy up", "Story #12. Like in #7.", "tidy"), NO_LINKS)).toEqual({ stories: [12], guessed: true });
    expect(pullStories(pull(44, "Tidy up", "As discussed in #7", "tidy"), NO_LINKS)).toEqual({ stories: [], guessed: false });
    expect(namedStories("Closes #1, fixes #2, Resolved #3, refs #4, Story: #5, stories #6, see #7")).toEqual([1, 2, 3, 4, 5, 6]);
    // A list counts whole; a number after the list does not.
    expect(namedStories("Refs #160, #161 (card C16, stories 2 and 3 of 3), see #108")).toEqual([160, 161]);
    expect(namedStories("Closes #3 and #4 & #5")).toEqual([3, 4, 5]);
  });

  it("keeps La Fabrique's own pull requests out of development: a scenario stays with its story, the others with none", () => {
    // "Refs #12" in the body, as Propose to the project writes it.
    expect(pullStories(pull(45, "La Fabrique: tested scenario for #12", "Refs #12\n\nProposed from La Fabrique", "fabrique/feature-12-20261107101500"), NO_LINKS)).toEqual({
      stories: [12],
      guessed: false,
      scenario: true,
    });
    // Even when GitHub links the branch or the pull request to the story.
    const links: DevelopmentLinks = { closes: new Map([[45, [12]]]), branches: new Map([["fabrique/feature-12-20261107101500", 12]]) };
    expect(pullStories(pull(45, "Scenario", "Refs #12", "fabrique/feature-12-20261107101500"), links)).toEqual({ stories: [12], guessed: false, scenario: true });
    expect(pullStories(pull(46, "Report kit 1.9.0", "Refs #220", "fabrique/kit-1.9.0-20261107101500"), NO_LINKS)).toEqual({ stories: [], guessed: false });
  });
});

const REPO = "acme/widget";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("Stories read with their Development links", () => {
  it("attaches a pull request to the issue GitHub links it to, not to the issue its text mentions", async () => {
    await env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO).run();
    const github = () => fetchMock.get("https://api.github.com");
    const issue = (number: number) => ({
      number,
      title: `Story ${number}`,
      state: "open",
      html_url: `https://github.com/${REPO}/issues/${number}`,
      user: { login: "someone" },
      labels: [],
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      closed_at: null,
    });
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${REPO}/issues?state=all&per_page=100&page=1` }).reply(200, JSON.stringify([issue(7), issue(12), issue(15)]), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1` })
      .reply(
        200,
        JSON.stringify([
          { number: 30, title: "Login", body: "Unlike #7", state: "open", merged_at: null, html_url: "https://github.com/pull/30", head: { ref: "login" } },
          { number: 31, title: "Menu", body: "Story #12", state: "open", merged_at: null, html_url: "https://github.com/pull/31", head: { ref: "menu" } },
        ]),
        JSON_HEADERS,
      );
    github().intercept({ path: `/repos/${REPO}/branches?per_page=100&page=1` }).reply(200, JSON.stringify([{ name: "main" }, { name: "login" }]), JSON_HEADERS);
    let query = "";
    github()
      .intercept({ method: "POST", path: "/graphql" })
      .reply(200, (options) => {
        query = String(options.body);
        return JSON.stringify({
          data: {
            repository: {
              pullRequests: { nodes: [{ number: 30, closingIssuesReferences: { nodes: [] } }] },
              issues: { nodes: [{ number: 15, linkedBranches: { nodes: [{ ref: { name: "login" } }] } }] },
            },
          },
        });
      });
    const project = { repo: REPO, installationId: 99, addedAt: "", addedBy: "admin-one", check: null };
    const { stories } = await loadStories(env, project);
    const of = (number: number) => stories.find((story) => story.number === number);
    expect(JSON.parse(query).variables).toEqual({ owner: "acme", name: "widget" });
    expect(of(15)?.pullRequests).toEqual([{ number: 30, url: "https://github.com/pull/30", state: "open" }]);
    expect(of(15)?.branches).toEqual(["login"]);
    expect(of(7)?.pullRequests).toEqual([]);
    expect(of(12)?.pullRequests).toEqual([{ number: 31, url: "https://github.com/pull/31", state: "open", guessed: true }]);
  });
});

describe("A scenario proposed for a story is not its development (la-fabrique#168)", () => {
  it("leaves a story to validate as it is, and its card free", async () => {
    const repo = "acme/scenarios";
    await env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(repo).run();
    const github = () => fetchMock.get("https://api.github.com");
    const issue = (number: number) => ({
      number,
      title: `Story ${number}`,
      state: "open",
      html_url: `https://github.com/${repo}/issues/${number}`,
      user: { login: "someone" },
      labels: [],
      body: "## Acceptance criteria\n- [ ] It works",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      closed_at: null,
    });
    const scenario = "fabrique/feature-12-20261107101500";
    github().intercept({ method: "POST", path: "/app/installations/99/access_tokens" }).reply(201, JSON.stringify({ token: "ghs_installation" }), JSON_HEADERS);
    github().intercept({ path: `/repos/${repo}/issues?state=all&per_page=100&page=1` }).reply(200, JSON.stringify([issue(12), issue(13)]), JSON_HEADERS);
    github()
      .intercept({ path: `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1` })
      .reply(
        200,
        JSON.stringify([
          { number: 50, title: "La Fabrique: tested scenario for #12", body: "Refs #12\n\nProposed from La Fabrique by @tester", state: "open", merged_at: null, html_url: "https://github.com/pull/50", head: { ref: scenario } },
          { number: 40, title: "Story 12", body: "Refs #12", state: "closed", merged_at: "2026-11-06T10:00:00Z", html_url: "https://github.com/pull/40", head: { ref: "claude/12-story" } },
        ]),
        JSON_HEADERS,
      );
    github().intercept({ path: `/repos/${repo}/branches?per_page=100&page=1` }).reply(200, JSON.stringify([{ name: "main" }, { name: scenario }]), JSON_HEADERS);
    github()
      .intercept({ method: "POST", path: "/graphql" })
      .reply(200, JSON.stringify({ data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [{ number: 12, linkedBranches: { nodes: [{ ref: { name: scenario } }] } }] } } } }));
    const project = { repo, installationId: 99, addedAt: "", addedBy: "admin-one", check: null };

    const { stories } = await loadStories(env, project);
    const twelve = stories.find((story) => story.number === 12)!;
    expect(twelve.pullRequests).toEqual([{ number: 40, url: "https://github.com/pull/40", state: "merged" }]);
    expect(twelve.branches).toEqual([]);
    // Still shown with the story, as its scenario.
    expect(twelve.scenarioPulls).toEqual([{ number: 50, url: "https://github.com/pull/50", state: "open" }]);
    // Merged, still open: to validate, the scenario's pull request open or not.
    const rules = { ...cycleRules(null), inCard: new Set([12, 13]) };
    expect(stageOf(twelve, rules, new Set())).toBe("to_validate");

    // Its card: #12 to validate, #13 next; nothing holds #13.
    const states = await cardStories(env, project, [12, 13], "cache");
    expect(states.get(12)?.stage).toBe("to_validate");
    expect(states.get(12)?.pulls.some((pull) => pull.state === "open")).toBe(false);
    const order = new Map([[1, [12, 13]]]);
    expect(heldStories({ cards: new Map(), byStory: new Map(), order, nice: new Set() }, states, new Set()).size).toBe(0);
  });
});
