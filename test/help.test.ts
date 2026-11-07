import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GUIDES, resolveRef, useCaseRefs } from "../src/help";
import { get, grantRole, signIn } from "./helpers";

async function addProjects(...repos: string[]): Promise<void> {
  for (const repo of repos) {
    await env.DB.prepare("INSERT INTO projects (repo, installation_id, added_by) VALUES (?, 99, 'admin-one')").bind(repo).run();
  }
}

const NO_INLINE_SCRIPT = /<script(?![^>]*\bsrc=)/i;
const PE = GUIDES.find((guide) => guide.slug === "product-engineer")!;

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
    expect(body).not.toMatch(NO_INLINE_SCRIPT);
  });

  it("says a guide not written yet is coming", async () => {
    const response = await get("/help/tester");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("This guide is not written yet");
  });

  it("has nothing at an unknown address", async () => {
    expect((await get("/help/unknown")).status).toBe(404);
    expect((await get("/help/product-engineer/use-cases/unknown")).status).toBe(404);
    expect((await get("/help/product-engineer/reference/unknown")).status).toBe(404);
  });
});

describe("The Product Engineer's guide: user guide and reference (la-fabrique#267)", () => {
  it("gathers the use cases by moment and the reference pages on its home", async () => {
    const response = await get("/help/product-engineer");
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const moment of PE.moments ?? []) {
      if ((PE.useCases ?? []).some((useCase) => useCase.moment === moment.id)) expect(body).toContain(`id="${moment.id}"`);
    }
    for (const useCase of PE.useCases ?? []) expect(body).toContain(`href="/help/product-engineer/use-cases/${useCase.slug}"`);
    for (const page of PE.reference ?? []) expect(body).toContain(`href="/help/product-engineer/reference/${page.slug}"`);
    expect(body).not.toMatch(NO_INLINE_SCRIPT);
  });

  it("covers planning the next sprint, refining in batch and the board", () => {
    const moments = new Set((PE.useCases ?? []).map((useCase) => useCase.moment));
    for (const moment of ["shape", "refine", "plan", "run", "ship", "board"]) expect(moments).toContain(moment);
    for (const page of ["board", "refinement", "sprint", "cards", "stories"]) expect(PE.reference?.some((candidate) => candidate.slug === page)).toBe(true);
  });

  it("leads every step to a reference section that exists, and names no section twice", () => {
    for (const useCase of PE.useCases ?? []) {
      for (const target of useCaseRefs(useCase)) expect(resolveRef(PE, target), `${useCase.slug} → ${target}`).not.toBeNull();
    }
    for (const page of PE.reference ?? []) {
      const ids = page.sections.map((section) => section.id);
      expect(new Set(ids).size, page.slug).toBe(ids.length);
    }
    const slugs = (PE.useCases ?? []).map((useCase) => useCase.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("shows a use case with its steps, what happens next, and links to the reference", async () => {
    const body = await (await get("/help/product-engineer/use-cases/start-sprint")).text();
    expect(body).toContain("<h1>Start the sprint</h1>");
    expect(body).toContain("What happens next.");
    expect(body).toContain('href="/help/product-engineer/reference/sprint#start"');
    // The guide's menu is on every page, the current page marked.
    expect(body).toContain('href="/help/product-engineer/use-cases/start-sprint" aria-current="page"');
    expect(body).toContain('href="/help/product-engineer/reference/board"');
    expect(body).not.toMatch(NO_INLINE_SCRIPT);
  });

  it("shows a reference page whose sections list the use cases that use them", async () => {
    const body = await (await get("/help/product-engineer/reference/refinement")).text();
    expect(body).toContain('<section class="help-ref-section" id="batch">');
    const batch = body.slice(body.indexOf('id="batch"'), body.indexOf('id="queue"'));
    expect(batch).toContain("Used in");
    expect(batch).toContain('href="/help/product-engineer/use-cases/prepare-next-release"');
  });

  it("serves every page without an account, the links to the app going through sign-in", async () => {
    await addProjects("acme/shop");
    const pages = [
      "/help/product-engineer",
      ...(PE.useCases ?? []).map((useCase) => `/help/product-engineer/use-cases/${useCase.slug}`),
      ...(PE.reference ?? []).map((page) => `/help/product-engineer/reference/${page.slug}`),
    ];
    for (const page of pages) {
      const response = await get(page);
      expect(response.status, page).toBe(200);
      const body = await response.text();
      expect(body, page).not.toContain("acme/shop");
      expect(body, page).not.toMatch(NO_INLINE_SCRIPT);
    }
    const body = await (await get("/help/product-engineer/use-cases/new-feature")).text();
    expect(body).toContain(`href="/auth/login?next=${encodeURIComponent("/projects")}"`);
    // Every page of the guide, one after the other.
  }, 30_000);

  it("opens the viewer's project, and keeps the project chosen from page to page", async () => {
    await grantRole("pe-two", "product_engineer");
    await addProjects("acme/alpha", "acme/shop");
    const { cookie } = await signIn("pe-two");

    const first = await (await get("/help/product-engineer/use-cases/new-feature", cookie)).text();
    expect(first).toContain('href="/projects/acme/alpha/board"');
    expect(first).toContain('<select id="help-project" name="project">');
    expect(first).toContain('href="/help/product-engineer/reference/cards#create"');

    const chosen = await (await get("/help/product-engineer/use-cases/new-feature?project=acme%2Fshop", cookie)).text();
    expect(chosen).toContain('href="/projects/acme/shop/board"');
    expect(chosen).not.toContain('href="/projects/acme/alpha/board"');
    expect(chosen).toContain('href="/help/product-engineer/reference/cards?project=acme%2Fshop#create"');
  });

  it("keeps the chosen project in a cookie, and defaults to the project the reader came from", async () => {
    await grantRole("pe-three", "product_engineer");
    await addProjects("acme/alpha", "acme/shop");
    const { cookie } = await signIn("pe-three");
    const path = "/help/product-engineer/use-cases/new-feature";

    const chosen = await get(`${path}?project=acme%2Fshop`, cookie);
    const set = chosen.headers.get("set-cookie") ?? "";
    expect(set).toContain("__Host-help-project=acme%2Fshop");
    const kept = (set.split(";")[0] ?? "");

    const next = await (await get(path, `${cookie}; ${kept}`)).text();
    expect(next).toContain('href="/projects/acme/shop/board"');

    const referred = await get("/help/product-engineer", cookie, { referer: "https://x.test/projects/acme/shop/sprint" });
    expect(await referred.text()).toContain('href="/projects/acme/shop/board"');
  });
});
