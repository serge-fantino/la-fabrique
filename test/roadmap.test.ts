import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { epicProgress, monthGrid, parseReleases, shiftMonth, storiesBetween } from "../src/roadmap";
import type { Story } from "../src/stories";
import { get, grantRole, signIn } from "./helpers";

const REPO = "acme/widget";
const SHA = "1111111111111111111111111111111111111111";

const NOTES = JSON.stringify([
  { version: "1.168", date: "2026-10-30", titre: "E-mails", changements: ["Bienvenue."] },
  { version: "1.167", date: "2026-10-29", heure: "23:19", titre: "Recettes", changements: ["Supprimer une recette."], liens: [{ app: "/app/recettes.html" }], stories: [49, "#50", 50, "x"] },
  { version: "1.166", date: "2026-10-29", heure: "21:37", titre: "Placards", changements: [] },
  { version: "1.0", date: "2026-10-22", titre: "Ouverture" },
]);

function story(number: number, extra: Partial<Story> = {}): Story {
  return {
    number,
    title: `Story ${number}`,
    state: "open",
    url: `https://github.com/${REPO}/issues/${number}`,
    author: null,
    labels: [],
    parent: null,
    subTotal: 0,
    subCompleted: 0,
    createdAt: "2026-10-24T08:00:00Z",
    updatedAt: "2026-10-24T08:00:00Z",
    closedAt: null,
    pullRequests: [],
    branches: [],
    ...extra,
  };
}

const STORIES = [
  story(48, { title: "Refonte", subTotal: 3, subCompleted: 2 }),
  story(49, { parent: 48, state: "closed", closedAt: "2026-10-25T16:02:32Z" }),
  story(50, { parent: 48, state: "closed", closedAt: "2026-10-29T22:00:00Z" }),
  story(51, { parent: 48 }),
];

describe("Release notes and roadmap computations", () => {
  it("reads “Quoi de neuf”: entries above the newest one with a time are upcoming", () => {
    const releases = parseReleases(NOTES);
    expect(releases.map((release) => [release.version, release.upcoming])).toEqual([
      ["1.168", true],
      ["1.167", false],
      ["1.166", false],
      ["1.0", false],
    ]);
    expect(releases[1]?.links).toEqual(["/app/recettes.html"]);
    // `stories`: the issues the entry declares; null when it does not say.
    expect(releases[1]?.stories).toEqual([49, 50]);
    expect(releases[0]?.stories).toBeNull();
    expect(parseReleases("{}")).toEqual([]);
  });

  it("lays out a month in weeks starting on Monday", () => {
    const weeks = monthGrid("2026-10");
    expect(weeks[0]?.[0]).toEqual({ day: "2026-09-28", inMonth: false });
    expect(weeks.at(-1)?.at(-1)).toEqual({ day: "2026-11-01", inMonth: false });
    expect(weeks.flat().filter((day) => day.inMonth)).toHaveLength(31);
    expect([shiftMonth("2026-01", -1), shiftMonth("2026-12", 1)]).toEqual(["2025-12", "2027-01"]);
  });

  it("counts an epic's done stories day by day", () => {
    const [progress] = epicProgress(STORIES, "2026-10-30");
    expect(progress?.epic.number).toBe(48);
    expect(progress?.done.find((point) => point.day === "2026-10-24")?.count).toBe(0);
    expect(progress?.done.find((point) => point.day === "2026-10-25")?.count).toBe(1);
    expect(progress?.done.at(-1)).toEqual({ day: "2026-10-30", count: 2 });
  });

  it("matches stories closed between two versions", () => {
    const releases = parseReleases(NOTES);
    const between = storiesBetween(STORIES, releases[2], releases[1] ?? releases[0]!);
    expect(between.map((s) => s.number)).toEqual([50]);
  });
});

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(REPO),
    env.DB.prepare(
      "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES (?, 'main', ?, ?, '[]', '[]')",
    ).bind(
      REPO,
      SHA,
      JSON.stringify({
        nom: "Widget",
        version: { fichier: "site/nouveautes.json" },
        environnements: { production: { url: "https://widget.example" } },
      }),
    ),
    env.DB.prepare("INSERT INTO snapshots (repo, kind, data, fetched_at) VALUES (?, 'stories', ?, '2099-01-01T00:00:00.000Z')").bind(
      REPO,
      JSON.stringify(STORIES),
    ),
  ]);
}

function mockNotes(): void {
  const github = fetchMock.get("https://api.github.com");
  github
    .intercept({ method: "POST", path: "/app/installations/99/access_tokens" })
    .reply(201, JSON.stringify({ token: "ghs_installation" }), { headers: { "content-type": "application/json" } });
  github.intercept({ path: `/repos/${REPO}/contents/site/nouveautes.json?ref=${SHA}` }).reply(200, NOTES);
}

describe("Roadmap and Releases tabs", () => {
  it("puts versions, closed stories and epics on the month's calendar", async () => {
    await seed();
    mockNotes();
    const page = await (await get(`/projects/${REPO}/roadmap?month=2026-10`, (await signIn("admin-one")).cookie)).text();

    expect(page).toContain(`href="/projects/${REPO}/releases?month=2026-10#day-2026-10-29">2 versions</a>`);
    expect(page).toContain("1.166 → 1.167");
    expect(page).toContain("<strong>October 2026</strong>");
    expect(page).toContain(`href="https://github.com/${REPO}/issues/48">#48</a> Refonte`);
    expect(page).toContain("2/3 done");
    expect(page).toContain("<title>2026-10-25: 1/3 done</title>");
  });

  it("lists release notes by day, with their changes, links and the stories they closed", async () => {
    await seed();
    mockNotes();
    const { cookie } = await signIn("admin-one");
    const page = await (await get(`/projects/${REPO}/releases?month=2026-10`, cookie)).text();

    expect(page).toContain('<section id="day-2026-10-29">');
    expect(page).toContain('<article class="release-note" id="v-1.167">');
    expect(page).toContain("<li>Supprimer une recette.</li>");
    expect(page).toContain('href="https://widget.example/app/recettes.html"');
    expect(page).toContain('<span class="pill warn">Upcoming</span>');
    expect(page).toMatch(/id="v-1.167">[\s\S]*#50<\/a> Story 50[\s\S]*id="v-1.166"/);

    expect((await get(`/projects/${REPO}/releases?month=2026-10`, cookie)).status).toBe(200);
  });

  it("is visible to every role", async () => {
    await seed();
    mockNotes();
    await grantRole("qa", "tester");
    expect((await get(`/projects/${REPO}/roadmap`, (await signIn("qa")).cookie)).status).toBe(200);
  });
});
