import { describe, expect, it } from "vitest";
import releaseNotes from "../docs/release-notes.json";
import { get, post, signIn } from "./helpers";

describe("Settings", () => {
  it("shows the online version and what this device should run", async () => {
    const page = await (await get("/settings", (await signIn("admin-one")).cookie)).text();
    expect(page).toContain('<a href="/settings">Settings</a>');
    expect(page).toContain(`<span class="mono">${releaseNotes.find((note) => note.version !== "next")?.version} + ${releaseNotes.filter((note) => note.version === "next").length} change${releaseNotes.filter((note) => note.version === "next").length === 1 ? "" : "s"}</span>`);
    expect(page).toMatch(/data-expected-script="\/fabrique\.js\?v=[0-9a-f]{8}"/);
    expect(page).toContain('<form method="post" action="/settings/refresh" data-refresh>');
  });

  it("reloads everything: the browser is told to drop its cache for the site", async () => {
    const { cookie, csrf } = await signIn("admin-one");
    const response = await post("/settings/refresh", { csrf }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?notice=refreshed");
    expect(response.headers.get("clear-site-data")).toBe('"cache"');
    expect((await post("/settings/refresh", { csrf: "wrong" }, cookie)).status).toBe(403);
  });

  it("offers a slow page to try the loading bar", async () => {
    const started = Date.now();
    const response = await get("/settings/slow", (await signIn("admin-one")).cookie);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    expect(response.headers.get("location")).toBe("/settings?notice=tried");
  });

  it("is for people signed in only", async () => {
    expect((await get("/settings")).status).toBe(303);
    expect((await get("/settings/slow")).status).toBe(303);
  });
});
