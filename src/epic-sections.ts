import type { Project } from "./projects";
import type { Rubrique } from "./requests";

// An epic card is a document written in sections. The sections come from the
// project's `.fabrique.json` (`epiques.rubriques`), else these. The document
// is the card's Markdown body, one `## Title` heading per section, so every
// version, the log, the export and the MCP work as for any card.
export const DEFAULT_EPIC_SECTIONS: Rubrique[] = [
  { cle: "why", titre: "Why", aide: "The problem or the opportunity, and for whom." },
  { cle: "scope", titre: "Scope", aide: "What the epic covers." },
  { cle: "out_of_scope", titre: "Out of scope", aide: "What it deliberately leaves out." },
  { cle: "decisions", titre: "Decisions", aide: "What is decided, and why." },
  { cle: "features", titre: "Features", aide: "The features that make it up." },
  { cle: "dependencies", titre: "Dependencies", aide: "What it needs, what needs it." },
  { cle: "open_questions", titre: "Open questions", aide: "What remains to decide." },
];

export function epicSections(project: Project): Rubrique[] {
  const declared = project.check?.config?.epiques?.rubriques ?? [];
  return declared.length ? declared : DEFAULT_EPIC_SECTIONS;
}

export function epicFieldName(rubrique: Rubrique): string {
  return `section_${rubrique.cle}`;
}

// The sections' texts, as a document.
export function composeEpicBody(texts: Record<string, string>, sections: Rubrique[]): string {
  return sections
    .map((section) => ({ section, text: (texts[section.cle] ?? "").replace(/\r\n/g, "\n").trim() }))
    .filter((entry) => entry.text)
    .map((entry) => `## ${entry.section.titre}\n\n${entry.text}`)
    .join("\n\n");
}

export const EPIC_REST_FIELD = "epic_rest";

export function readEpicForm(form: FormData, sections: Rubrique[]): string {
  const texts: Record<string, string> = {};
  for (const section of sections) texts[section.cle] = String(form.get(epicFieldName(section)) ?? "");
  const rest = String(form.get(EPIC_REST_FIELD) ?? "").replace(/\r\n/g, "\n").trim();
  const document = composeEpicBody(texts, sections);
  return [rest, document].filter(Boolean).join("\n\n");
}

// A document back into its sections. Text before the first heading, or under
// a heading the project does not declare, is kept in `rest`.
export function parseEpicBody(body: string, sections: Rubrique[]): { texts: Record<string, string>; rest: string } {
  const texts: Record<string, string> = {};
  const byTitle = new Map(sections.map((section) => [section.titre.toLowerCase(), section.cle]));
  let current: string | null = null;
  const rest: string[] = [];
  const buffers = new Map<string, string[]>();
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const key = byTitle.get((heading[1] ?? "").toLowerCase());
      current = key ?? null;
      if (!key) rest.push(line);
      continue;
    }
    if (current) {
      const buffer = buffers.get(current) ?? [];
      buffer.push(line);
      buffers.set(current, buffer);
    } else rest.push(line);
  }
  for (const [key, lines] of buffers) texts[key] = lines.join("\n").trim();
  return { texts, rest: rest.join("\n").trim() };
}
