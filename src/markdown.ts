import MarkdownIt from "markdown-it";

// Raw HTML is escaped, and markdown-it refuses javascript:, vbscript:, file:
// and non-image data: links. Linkify and smart quotes stay off: both had
// quadratic-time inputs in the past.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

export const MAX_MARKDOWN_LENGTH = 512 * 1024;

export interface LinkTargets {
  // Repository path of the page being rendered.
  path: string;
  isPage(path: string): boolean;
  pageUrl(path: string): string;
  githubUrl(path: string): string;
  // An image this site serves itself (allowed by its CSP): its address, or
  // null to show a link instead.
  imageUrl?(src: string): string | null;
}

interface RenderEnv {
  targets: LinkTargets;
  slugs: Map<string, number>;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Relative links between published pages stay in La Fabrique; any other
// repository path opens on GitHub; absolute links are left as written.
function resolveLink(href: string, targets: LinkTargets): { href: string; external: boolean } {
  if (SCHEME.test(href) || href.startsWith("//")) return { href, external: true };
  if (href.startsWith("#") || href === "") return { href, external: false };

  const hashAt = href.indexOf("#");
  const pathPart = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const folder = href.startsWith("/") ? "" : targets.path.slice(0, targets.path.lastIndexOf("/") + 1);
  let resolved: string;
  try {
    resolved = decodeURIComponent(new URL(pathPart, `https://repo.invalid/${folder}`).pathname.slice(1));
  } catch {
    return { href: targets.githubUrl(""), external: true };
  }
  return targets.isPage(resolved)
    ? { href: `${targets.pageUrl(resolved)}${hash}`, external: false }
    : { href: `${targets.githubUrl(resolved)}${hash}`, external: true };
}

function inlineText(inline: { children: { type: string; content: string }[] | null } | undefined): string {
  return (inline?.children ?? [])
    .filter((child) => child.type === "text" || child.type === "code_inline")
    .map((child) => child.content)
    .join("");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

md.renderer.rules.link_open = (tokens, idx, options, env: RenderEnv, self) => {
  const token = tokens[idx];
  const href = token?.attrGet("href");
  if (token && href !== null && href !== undefined) {
    const link = resolveLink(href, env.targets);
    token.attrSet("href", link.href);
    if (link.external) token.attrSet("rel", "noopener noreferrer");
  }
  return self.renderToken(tokens, idx, options);
};

// Images from the repository or elsewhere are blocked by the CSP; they
// become links to the image instead, unless the site serves them.
md.renderer.rules.image = (tokens, idx, _options, env: RenderEnv) => {
  const token = tokens[idx];
  const src = token?.attrGet("src") ?? "";
  const alt = token?.children?.map((child) => child.content).join("") || "image";
  const own = env.targets.imageUrl?.(src);
  if (own) return `<img src="${md.utils.escapeHtml(own)}" alt="${md.utils.escapeHtml(alt)}" loading="lazy" />`;
  const link = resolveLink(src, env.targets);
  return `<a class="image-link" href="${md.utils.escapeHtml(link.href)}" rel="noopener noreferrer">Image: ${md.utils.escapeHtml(alt)}</a>`;
};

md.renderer.rules.heading_open = (tokens, idx, options, env: RenderEnv, self) => {
  const token = tokens[idx];
  const inline = tokens[idx + 1];
  if (token && inline) {
    const base = slugify(inlineText(inline)) || "section";
    const seen = env.slugs.get(base) ?? 0;
    env.slugs.set(base, seen + 1);
    token.attrSet("id", seen ? `${base}-${seen}` : base);
  }
  return self.renderToken(tokens, idx, options);
};

export function renderMarkdown(source: string, targets: LinkTargets): { html: string; title: string | null } {
  const env: RenderEnv = { targets, slugs: new Map() };
  const tokens = md.parse(source, env);
  const h1 = tokens.findIndex((token) => token.type === "heading_open" && token.tag === "h1");
  const title = h1 === -1 ? null : inlineText(tokens[h1 + 1]) || null;
  return { html: md.renderer.render(tokens, md.options, env), title };
}
