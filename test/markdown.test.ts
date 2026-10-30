import { describe, expect, it } from "vitest";
import { renderMarkdown, type LinkTargets } from "../src/markdown";

const PAGES = ["README.md", "docs/guide/intro.md", "docs/guide/setup.md", "docs/my notes.md"];

function targets(path: string): LinkTargets {
  return {
    path,
    isPage: (candidate) => PAGES.includes(candidate),
    pageUrl: (candidate) => `/docs/${candidate}`,
    githubUrl: (candidate) => `https://github.example/blob/${candidate}`,
  };
}

describe("Markdown rendering", () => {
  it("keeps links between published pages inside La Fabrique", () => {
    const { html } = renderMarkdown(
      "[next](setup.md) [home](../../README.md#top) [root](/docs/guide/intro.md) [notes](../my%20notes.md)",
      targets("docs/guide/intro.md"),
    );
    expect(html).toContain('href="/docs/docs/guide/setup.md"');
    expect(html).toContain('href="/docs/README.md#top"');
    expect(html).toContain('href="/docs/docs/guide/intro.md"');
    expect(html).toContain('href="/docs/docs/my notes.md"');
  });

  it("sends other repository paths to GitHub and leaves absolute links alone", () => {
    const { html } = renderMarkdown(
      "[code](../src/index.ts) [site](https://example.com/a) [mail](mailto:a@example.com) [here](#usage)",
      targets("docs/intro.md"),
    );
    expect(html).toContain('href="https://github.example/blob/src/index.ts" rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com/a" rel="noopener noreferrer"');
    expect(html).toContain('href="mailto:a@example.com"');
    expect(html).toContain('href="#usage"');
  });

  it("gives headings GitHub-style anchors and returns the first title", () => {
    const { html, title } = renderMarkdown(
      "# Refonte technique\n\n## Étape 1 : `store` v2\n\n## Étape 1 : `store` v2",
      targets("README.md"),
    );
    expect(title).toBe("Refonte technique");
    expect(renderMarkdown("# Le fichier `.fabrique.json`", targets("README.md")).title).toBe("Le fichier .fabrique.json");
    expect(html).toContain('<h1 id="refonte-technique">');
    expect(html).toContain('<h2 id="étape-1--store-v2">');
    expect(html).toContain('<h2 id="étape-1--store-v2-1">');
  });

  it("escapes raw HTML and refuses script links", () => {
    const { html } = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[x](javascript:alert(3)) [y](data:text/html;base64,PHNjcmlwdD4=)',
      targets("README.md"),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:text/html');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("turns images into links, since the CSP blocks them", () => {
    const { html } = renderMarkdown("![Schéma](diagram.png)", targets("docs/guide/intro.md"));
    expect(html).toContain(
      '<a class="image-link" href="https://github.example/blob/docs/guide/diagram.png" rel="noopener noreferrer">Image: Schéma</a>',
    );
  });
});
