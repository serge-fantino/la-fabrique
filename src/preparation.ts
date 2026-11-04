import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { isNice, type StoryCards } from "./card-groups";
import type { CardStory } from "./card-stories";
import { compareVersions, isFixedLane, type BoardRelease } from "./card-releases";
import { shownStatus, shownStatusLabel, type Card } from "./cards";
import { validationOf } from "./feature-validation";
import { LOGO_SVG } from "./logo";
import { nextStep, releaseProgress, synopsisOf, type NextStep } from "./refinement";
import { scenarioText, type Recorded } from "./gherkin";
import type { Rubrique } from "./requests";
import { escapeHtml } from "./views";

// The preparation document of the next release (la-fabrique#229): what
// Refinement shows, as a file to read or share without La Fabrique. Built on
// demand from La Fabrique's own data and the stories' snapshot; nothing is
// published. One neutral model, written as HTML or as PDF.

export type Level = 1 | 2 | 3;
export type Format = "html" | "pdf";

export function readLevel(value: string | null): Level {
  return value === "2" ? 2 : value === "3" ? 3 : 1;
}
export function readFormat(value: string | null): Format {
  return value === "pdf" ? "pdf" : "html";
}

export const LEVEL_LABELS: Record<Level, string> = {
  1: "Features and their specs",
  2: "Plus their stories",
  3: "Plus their test cases",
};

// A block of a feature: a heading, text, a list item, preformatted text.
export type Block = { t: "h" | "h2" | "p" | "li" | "pre" | "muted"; text: string };

export interface DocFeature {
  ref: string;
  title: string;
  status: string;
  stories: number;
  step: string;
  priority: string | null;
  blocks: Block[];
}

export interface Doc {
  level: Level;
  project: { name: string; description: string };
  preparing: string | null;
  latest: string | null;
  date: string;
  by: string;
  progress: { features: number; ready: number; needed: number; nice: number };
  go: boolean;
  blockers: { ref: string; title: string; reason: string }[];
  features: DocFeature[];
}

export interface DocInput {
  level: Level;
  projectName: string;
  description: string;
  preparing: string | null;
  releases: BoardRelease[];
  by: string;
  now: Date;
  features: Card[];
  links: StoryCards;
  stories: Map<number, CardStory>;
  rubriques: Rubrique[];
  recorded: Map<number, Recorded[]>;
  // Sections of the stories as Claude proposed them (by title), when kept.
  sections: (card: Card, title: string) => Record<string, string> | null;
}

const STEP_LABELS: Record<NextStep["step"], string> = {
  specify: "To specify",
  answer: "Questions waiting",
  refine: "To refine into stories",
  validate: "Stories to make ready",
  approve: "To validate",
  ready: "Ready for the sprint",
};

export function latestReleased(releases: BoardRelease[]): string | null {
  const shipped = releases.filter((release) => release.state === "shipped" && !isFixedLane(release.version));
  return shipped.sort((a, b) => compareVersions(a.version, b.version))[0]?.version ?? null;
}

// Plain text of an answer, as paragraphs and list items.
function textBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-*]\s+(.*)$/.exec(line);
    blocks.push(item ? { t: "li", text: item[1] as string } : { t: "p", text: line });
  }
  return blocks;
}

export function buildDoc(input: DocInput): Doc {
  const progress = releaseProgress(input.features, input.links, input.stories);
  const features = input.features.map((card): DocFeature => {
    const numbers = input.links.order.get(card.id) ?? [];
    const next = nextStep(card, numbers, input.stories);
    const blocks: Block[] = [];
    const synopsis = synopsisOf(card);
    if (synopsis) blocks.push({ t: "p", text: synopsis });
    const spec = card.data.spec;
    if (spec) {
      for (const rubrique of input.rubriques) {
        const answer = spec.answers[rubrique.cle]?.trim();
        if (!answer) continue;
        blocks.push({ t: "h2", text: rubrique.titre }, ...textBlocks(answer));
      }
    } else {
      blocks.push({ t: "muted", text: "No spec yet." });
    }
    const validation = validationOf(card, numbers);
    if (validation.state === "valid") blocks.push({ t: "muted", text: `Validated by @${validation.by} on ${validation.at.slice(0, 10)}.` });
    if (input.level >= 2) {
      blocks.push({ t: "h", text: `Stories (${numbers.length})` });
      if (!numbers.length) blocks.push({ t: "muted", text: "No story yet." });
      for (const number of numbers) {
        const story = input.stories.get(number);
        const nice = isNice(input.links, card.id, number);
        const stage = story ? (story.closed ? "closed" : story.stage === "backlog" ? "not ready" : (story.stage ?? "").replace("_", " ")) : "not read yet";
        blocks.push({ t: "h2", text: `#${number} ${story?.title ?? ""}${nice ? " (nice to have)" : ""}` });
        blocks.push({ t: "muted", text: [stage, story?.priority ? `priority ${story.priority}` : "", story?.missing.length ? `missing: ${story.missing.join(", ")}` : ""].filter(Boolean).join(" · ") });
        const sections = story ? input.sections(card, story.title) : null;
        if (sections) {
          for (const rubrique of input.rubriques) {
            const answer = sections[rubrique.cle]?.trim();
            if (answer) blocks.push({ t: "muted", text: rubrique.titre }, ...textBlocks(answer));
          }
        }
        if (story?.criteria.length) {
          blocks.push({ t: "muted", text: "Acceptance criteria" });
          for (const criterion of story.criteria) blocks.push({ t: "li", text: criterion.text });
        }
        if (input.level >= 3) {
          const scenarios = input.recorded.get(number) ?? [];
          if (story?.criteria.length || scenarios.length) blocks.push({ t: "muted", text: "Test cases" });
          for (const criterion of story?.criteria ?? []) blocks.push({ t: "li", text: `[${criterion.done ? "x" : " "}] ${criterion.text}` });
          for (const scenario of scenarios) blocks.push({ t: "pre", text: scenarioText(scenario) });
        }
      }
    }
    return {
      ref: `C${card.id}`,
      title: card.title,
      status: shownStatusLabel(shownStatus(card)),
      stories: numbers.length,
      step: STEP_LABELS[next.step],
      priority: card.priority,
      blocks,
    };
  });
  return {
    level: input.level,
    project: { name: input.projectName, description: input.description },
    preparing: input.preparing,
    latest: latestReleased(input.releases),
    date: input.now.toISOString().slice(0, 10),
    by: input.by,
    progress: { features: progress.features, ready: progress.ready, needed: progress.needed, nice: progress.nice },
    go: progress.features > 0 && progress.blockers.length === 0,
    blockers: progress.blockers.map((b) => ({ ref: `C${b.card.id}`, title: b.card.title, reason: b.reason })),
    features,
  };
}

export function fileName(doc: Doc, repo: string, format: Format): string {
  const slug = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `preparation-${slug(repo.split("/")[1] ?? repo)}-${slug(doc.preparing ?? "next")}-level${doc.level}.${format}`;
}

// ---- HTML: one file, inline styles and logo, no network ---------------------

const STYLE = `body{font-family:Archivo,Arial,sans-serif;background:#F3F4EE;color:#18211B;margin:0;line-height:1.5}
main{max-width:52rem;margin:0 auto;padding:2rem 1.25rem}
h1,h2,h3,h4{line-height:1.25}.mono{font-family:"IBM Plex Mono",Consolas,monospace}
.cover{padding:3rem 0}.cover svg{width:72px;height:72px}.muted{color:#4a5650}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{color:#4a5650}dd{margin:0}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #cfd3c6;vertical-align:top}
.pill{display:inline-block;border-radius:999px;padding:.05rem .7rem;border:1px solid #18211B;font-weight:700}
.go{background:#1E5A43;color:#fff;border-color:#1E5A43}.nogo{background:#8A2A0F;color:#fff;border-color:#8A2A0F}
article{background:#fff;border-radius:12px;padding:1.25rem 1.5rem;margin:1.5rem 0;page-break-before:always;break-before:page}
pre{background:#F3F4EE;border-radius:8px;padding:.6rem .8rem;overflow-x:auto}
@media print{body{background:#fff}}`;

export function renderHtml(doc: Doc): string {
  const e = escapeHtml;
  const blocks = (list: Block[]) => {
    let out = "";
    let open = false;
    for (const block of list) {
      if (block.t === "li") {
        if (!open) out += "<ul>";
        open = true;
        out += `<li>${e(block.text)}</li>`;
        continue;
      }
      if (open) out += "</ul>";
      open = false;
      out +=
        block.t === "h" ? `<h3>${e(block.text)}</h3>`
        : block.t === "h2" ? `<h4>${e(block.text)}</h4>`
        : block.t === "pre" ? `<pre>${e(block.text)}</pre>`
        : block.t === "muted" ? `<p class="muted">${e(block.text)}</p>`
        : `<p>${e(block.text)}</p>`;
    }
    return out + (open ? "</ul>" : "");
  };
  const title = `Preparation of ${doc.preparing ?? "the next release"} · ${doc.project.name}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${e(title)}</title><style>${STYLE}</style></head>
<body><main>
<section class="cover">
${LOGO_SVG.replace("<svg ", '<svg role="img" aria-label="La Fabrique extraordinaire" ')}
<p class="muted">La Fabrique extraordinaire · release preparation</p>
<h1>${e(doc.project.name)}</h1>
${doc.project.description ? `<p>${e(doc.project.description)}</p>` : ""}
<dl><dt>Version being prepared</dt><dd class="mono">${e(doc.preparing ?? "not set")}</dd>
<dt>Latest released</dt><dd class="mono">${e(doc.latest ?? "none yet")}</dd>
<dt>Level of detail</dt><dd>${doc.level} · ${e(LEVEL_LABELS[doc.level])}</dd>
<dt>Generated on</dt><dd class="mono">${e(doc.date)}</dd>
<dt>Generated by</dt><dd>@${e(doc.by)}</dd></dl>
</section>
<section>
<h2>Summary</h2>
<p><span class="pill ${doc.go ? "go" : "nogo"}">${doc.go ? "GO" : "NO-GO"}</span> ${doc.progress.ready} of ${doc.progress.features} features ready · ${doc.progress.needed} needed stories, ${doc.progress.nice} nice to have</p>
${doc.blockers.length ? `<ul>${doc.blockers.map((b) => `<li><span class="mono">${e(b.ref)}</span> ${e(b.title)}: ${e(b.reason)}</li>`).join("")}</ul>` : ""}
${doc.features.length ? `<table><thead><tr><th>#</th><th>Feature, in priority order</th><th>Status</th><th>Stories</th></tr></thead><tbody>${doc.features.map((f, i) => `<tr><td class="mono">${i + 1}</td><td><span class="mono">${e(f.ref)}</span> ${e(f.title)}${f.priority ? ` <span class="muted">(${e(f.priority)})</span>` : ""}</td><td>${e(f.status)}<br /><span class="muted">${e(f.step)}</span></td><td class="mono">${f.stories}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No feature in Next release.</p>`}
</section>
${doc.features.map((f) => `<article><h2><span class="mono">${e(f.ref)}</span> ${e(f.title)}</h2><p class="muted">${e(f.status)} · ${e(f.step)} · ${f.stories} stor${f.stories === 1 ? "y" : "ies"}</p>${blocks(f.blocks)}</article>`).join("\n")}
</main></body></html>
`;
}

// ---- PDF: built here, with pdf-lib (pure JavaScript) -------------------------

const PAGE = { w: 595.28, h: 841.89, margin: 56 };
const INK = rgb(0x18 / 255, 0x21 / 255, 0x1b / 255);
const GREY = rgb(0.3, 0.34, 0.31);
const ACCENT = rgb(0xc2 / 255, 0x3d / 255, 0x17 / 255);

export async function renderPdf(doc: Doc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Preparation of ${doc.preparing ?? "the next release"} · ${doc.project.name}`);
  pdf.setAuthor(`@${doc.by}`);
  pdf.setCreator("La Fabrique extraordinaire");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  // The standard fonts hold Latin text only: the rest becomes "?".
  const sets = new Map<PDFFont, Set<number>>([regular, bold, mono].map((font) => [font, new Set(font.getCharacterSet())]));
  const clean = (font: PDFFont, text: string) => {
    const known = sets.get(font) as Set<number>;
    let out = "";
    for (const char of text.replace(/\t/g, "  ").replace(/[\r\n]+/g, " ")) {
      const code = char.codePointAt(0) as number;
      out += known.has(code) ? char : code === 0x2192 ? "->" : code === 0x2713 ? "x" : "?";
    }
    return out;
  };

  let page!: PDFPage;
  let y = 0;
  const fresh = () => {
    page = pdf.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.margin;
  };
  const width = PAGE.w - PAGE.margin * 2;
  const wrap = (text: string, font: PDFFont, size: number, max: number): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const word of clean(font, text).split(" ")) {
      let rest = word;
      // A word longer than the line is cut, never lost.
      while (rest && font.widthOfTextAtSize(rest, size) > max) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > max) n--;
        if (line) lines.push(line);
        lines.push(rest.slice(0, n));
        line = "";
        rest = rest.slice(n);
      }
      if (!rest) continue;
      const tried = line ? `${line} ${rest}` : rest;
      if (font.widthOfTextAtSize(tried, size) > max) {
        lines.push(line);
        line = rest;
      } else line = tried;
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  };
  const write = (text: string, opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; indent?: number; gap?: number; bullet?: boolean } = {}) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 10.5;
    const indent = opts.indent ?? 0;
    const lead = size * 1.4;
    const lines = wrap(text, font, size, width - indent);
    for (const [i, line] of lines.entries()) {
      if (y - lead < PAGE.margin) fresh();
      y -= lead;
      if (i === 0 && opts.bullet) page.drawText("-", { x: PAGE.margin + indent - 10, y, size, font, color: opts.color ?? INK });
      if (line) page.drawText(line, { x: PAGE.margin + indent, y, size, font, color: opts.color ?? INK });
    }
    y -= opts.gap ?? 4;
  };

  // The cover.
  fresh();
  y -= 40;
  page.drawSvgPath("M0 0H32V32H0Z", { x: PAGE.margin, y, scale: 2, color: INK, borderWidth: 0 });
  page.drawSvgPath("M5 26V14.5l6 4v-4l6 4v-4l6 4V9h3.5v17z", { x: PAGE.margin, y, scale: 2, color: rgb(0.953, 0.957, 0.933) });
  page.drawSvgPath("M8 22h3v4H8zM14 22h3v4h-3zM20 22h3v4h-3z", { x: PAGE.margin, y, scale: 2, color: INK });
  page.drawCircle({ x: PAGE.margin + 24.75 * 2, y: y - 5.5 * 2, size: 4, color: ACCENT });
  y -= 64 + 30;
  write("La Fabrique extraordinaire - release preparation", { color: GREY, gap: 14 });
  write(doc.project.name, { font: bold, size: 26, gap: 10 });
  if (doc.project.description) write(doc.project.description, { size: 12, gap: 24 });
  for (const [label, value] of [
    ["Version being prepared", doc.preparing ?? "not set"],
    ["Latest released", doc.latest ?? "none yet"],
    ["Level of detail", `${doc.level} - ${LEVEL_LABELS[doc.level]}`],
    ["Generated on", doc.date],
    ["Generated by", `@${doc.by}`],
  ] as const) {
    write(label, { color: GREY, size: 9, gap: 0 });
    write(value, { font: bold, size: 12, gap: 8 });
  }

  // The summary.
  fresh();
  write("Summary", { font: bold, size: 18, gap: 10 });
  write(doc.go ? "GO" : "NO-GO", { font: bold, size: 16, color: doc.go ? rgb(0x1e / 255, 0x5a / 255, 0x43 / 255) : rgb(0x8a / 255, 0x2a / 255, 0x0f / 255), gap: 2 });
  write(`${doc.progress.ready} of ${doc.progress.features} features ready - ${doc.progress.needed} needed stories, ${doc.progress.nice} nice to have`, { gap: 8 });
  for (const b of doc.blockers) write(`${b.ref} ${b.title}: ${b.reason}`, { indent: 14, bullet: true, gap: 2 });
  y -= 10;
  if (!doc.features.length) write("No feature in Next release.", { color: GREY });
  else write("Features, in priority order", { font: bold, size: 12, gap: 6 });
  for (const [i, f] of doc.features.entries()) {
    write(`${i + 1}. ${f.ref} ${f.title}${f.priority ? ` (${f.priority})` : ""}`, { font: bold, gap: 0 });
    write(`${f.status} - ${f.step} - ${f.stories} stor${f.stories === 1 ? "y" : "ies"}`, { color: GREY, size: 9.5, indent: 14, gap: 6 });
  }

  // A feature per page.
  for (const f of doc.features) {
    fresh();
    write(`${f.ref} ${f.title}`, { font: bold, size: 18, gap: 4 });
    write(`${f.status} - ${f.step} - ${f.stories} stor${f.stories === 1 ? "y" : "ies"}`, { color: GREY, gap: 10 });
    for (const block of f.blocks) {
      if (block.t === "h") write(block.text, { font: bold, size: 14, gap: 4 });
      else if (block.t === "h2") write(block.text, { font: bold, size: 11.5, gap: 3 });
      else if (block.t === "li") write(block.text, { indent: 14, bullet: true, gap: 2 });
      else if (block.t === "muted") write(block.text, { color: GREY, size: 9.5, gap: 3 });
      else for (const line of block.text.split("\n")) write(line, { font: mono, size: 9, indent: 8, gap: 0 });
      if (block.t === "pre") y -= 6;
    }
  }

  // Numbers, once the pages are known.
  const pages = pdf.getPages();
  for (const [i, p] of pages.entries()) {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: PAGE.w - PAGE.margin - regular.widthOfTextAtSize(label, 9), y: 28, size: 9, font: regular, color: GREY });
    p.drawText(clean(regular, `${doc.project.name} - ${doc.preparing ?? "next release"}`), { x: PAGE.margin, y: 28, size: 9, font: regular, color: GREY });
  }
  return pdf.save();
}
