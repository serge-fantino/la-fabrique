import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, grantRole, signIn } from "./helpers";

async function addProjects(...repos: string[]): Promise<void> {
  for (const repo of repos) {
    await env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(repo).run();
  }
}

describe("Help (la-fabrique#264)", () => {
  it("is linked from the signed-out home page", async () => {
    const body = await (await get("/")).text();
    expect(body).toContain('href="/help/product-engineer"');
    expect(body).toContain('href="/help"');
  });

  it("is in the menu once signed in", async () => {
    await grantRole("pe-one", "product_engineer");
    const { cookie } = await signIn("pe-one");
    const response = await get("/settings", cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/<nav class="nav">[\s\S]*href="\/help"[\s\S]*<\/nav>/);
  });

  it("lists the four profiles, the guides not written yet marked as coming", async () => {
    const response = await get("/help");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('href="/help/product-engineer"');
    for (const profile of ["Product Engineer", "Tester", "Tech lead", "Super admin"]) expect(body).toContain(`<strong>${profile}</strong>`);
    expect(body.match(/help-profile coming/g)).toHaveLength(3);
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  });

  it("serves the Product Engineer's guide without an account, its links going through sign-in", async () => {
    await addProjects("acme/shop");
    const response = await get("/help/product-engineer");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("The life of a card");
    for (const stage of ["Draft", "Shaping", "To validate", "Validated", "In development", "To test", "In production"]) {
      expect(body).toContain(`<span class="pill">${stage}</span>`);
    }
    expect((body.match(/class="help-case"/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(body).toContain(`href="/auth/login?next=${encodeURIComponent("/projects")}"`);
    // Nothing about the projects is shown to someone signed out.
    expect(body).not.toContain("acme/shop");
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  });

  it("opens the tabs of the viewer's project, the one chosen when there are several", async () => {
    await grantRole("pe-two", "product_engineer");
    await addProjects("acme/alpha", "acme/shop");
    const { cookie } = await signIn("pe-two");

    const first = await (await get("/help/product-engineer", cookie)).text();
    expect(first).toContain('href="/projects/acme/alpha/board"');
    expect(first).toContain('<select id="help-project" name="project">');

    const chosen = await (await get("/help/product-engineer?project=acme%2Fshop", cookie)).text();
    expect(chosen).toContain('href="/projects/acme/shop/board"');
    expect(chosen).toContain('href="/projects/acme/shop/to-test"');
    expect(chosen).not.toContain('href="/projects/acme/alpha/board"');
  });

  it("says a guide not written yet is coming", async () => {
    const response = await get("/help/tester");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("This guide is not written yet");
  });

  it("has nothing at an unknown guide's address", async () => {
    const response = await get("/help/unknown");
    expect(response.status).not.toBe(200);
  });
});
