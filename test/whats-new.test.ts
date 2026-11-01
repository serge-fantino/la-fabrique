import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import releaseNotes from "../docs/release-notes.json";
import { get, signIn } from "./helpers";

const latest = releaseNotes.find((note) => note.version !== "next") as { version: string; titre: string; changements: string[] };

describe("What's new", () => {
  it("lists La Fabrique's own release notes, newest first, linked from the (i) of the header", async () => {
    const { cookie } = await signIn("admin-one");
    const page = await (await get("/whats-new", cookie)).text();
    expect(page).toContain("<h1>What's new</h1>");
    expect(page).toContain(`id="v${latest.version.replace(".", "-")}"`);
    expect(page).toContain(latest.titre.replace(/'/g, "&#39;"));
    expect(page.indexOf(`id="v${latest.version.replace(".", "-")}"`)).toBeLessThan(page.indexOf('id="v0-1"'));
    // The link sits in the version's popover, on every page.
    const home = await (await get("/settings", cookie)).text();
    expect(home).toContain(`<a class="button quiet small" href="/whats-new#v${latest.version.replace(".", "-")}">What's new</a>`);
  });

  it("shows the next entries under \"Online, not released yet\", above the last release", async () => {
    const { whatsNewPage } = await import("../src/whats-new");
    const { parseReleases } = await import("../src/roadmap");
    const notes = [
      { version: "next", date: "2026-11-01", titre: "Waiting change", changements: ["It is online."], stories: [139] },
      { version: "0.78", date: "2026-11-01", heure: "00:26", titre: "Last release", changements: ["Released."], stories: [] },
    ];
    const page = whatsNewPage({ login: "x", role: "tester", csrfToken: "" } as never, parseReleases(JSON.stringify(notes)), null);
    expect(page).toContain("Online, not released yet");
    expect(page.indexOf("Online, not released yet")).toBeLessThan(page.indexOf("Waiting change"));
    expect(page.indexOf("Waiting change")).toBeLessThan(page.indexOf('id="v0-78"'));
  });

  it("links the stories to La Fabrique's repository when it is a project here", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES ('owner/fabrique', 99, 'admin-one')"),
      env.DB.prepare(
        "INSERT INTO project_configs (repo, branch, commit_sha, config, errors, doc_pages) VALUES ('owner/fabrique', 'main', 'abc', ?, '[]', '[]')",
      ).bind(JSON.stringify({ nom: "La Fabrique", environnements: { production: { url: "https://la-fabrique.test" } } })),
    ]);
    const page = await (await get("/whats-new", (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('href="https://github.com/owner/fabrique/issues/113">#113</a>');
  });

  it("is for people signed in only", async () => {
    expect((await get("/whats-new")).status).toBe(303);
  });
});
