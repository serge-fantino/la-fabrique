import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
