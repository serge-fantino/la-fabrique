import { formatEntry } from "./release-merge.ts";

// The release made when the sprint closes (la-fabrique#137), on a project
// without an integration branch: the `next` entries that declare a story
// done become one entry (the version, the date and time, the title, every
// change, the stories done); an entry with a story not done yet goes out
// marked partial, with a caveat naming them; the other `next` entries stay
// on top, still to release. Run by the project's release workflow
// (.github/workflows/release.yml, scripts/publish-release.ts); no import
// but the entry's format.

type Entry = Record<string, unknown>;

export interface PublishInput {
  version: string;
  title: string;
  // The stories done, released now.
  stories: number[];
  now: { date: string; time: string };
  // Titles of the stories not done, for the caveat; "#N" alone without.
  titles?: Record<string, string>;
}

export interface Published {
  text: string;
  // How many `next` entries the release took, and how many stay.
  taken: number;
  kept: number;
}

const storiesOf = (entry: Entry): number[] =>
  Array.isArray(entry["stories"]) ? entry["stories"].map((value) => Number(String(value).replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0) : [];

export function publishRelease(text: string, input: PublishInput): Published {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("The release notes are not a JSON array");
  const entries = data.filter((entry): entry is Entry => typeof entry === "object" && entry !== null);
  if (entries.some((entry) => String(entry["version"] ?? "") === input.version)) throw new Error(`Version ${input.version} is already in the release notes`);
  const done = new Set(input.stories);
  const drafts = entries.filter((entry) => entry["version"] === "next");
  const released = entries.filter((entry) => entry["version"] !== "next");
  const taken = drafts.filter((entry) => storiesOf(entry).some((number) => done.has(number)));
  const kept = drafts.filter((entry) => !taken.includes(entry));
  if (!taken.length) throw new Error("No `next` entry declares a story done: nothing to release");
  const changes = taken.flatMap((entry) => {
    const own = Array.isArray(entry["changements"]) ? entry["changements"].filter((change): change is string => typeof change === "string") : [];
    const missing = storiesOf(entry).filter((number) => !done.has(number));
    if (!missing.length) return own;
    const named = missing.map((number) => (input.titles?.[String(number)] ? `#${number} ${input.titles[String(number)]}` : `#${number}`)).join("; ");
    return [...own, `Partial: not done yet, ${named}.`];
  });
  const release: Entry = {
    version: input.version,
    date: input.now.date,
    heure: input.now.time,
    titre: input.title,
    changements: changes,
    stories: [...done].sort((a, b) => a - b),
    liens: null,
  };
  // The released entries keep their text as it is: only the head changes.
  const starts = [...text.matchAll(/^ {2}\{\s*$/gm)].map((match) => match.index ?? 0);
  if (starts.length !== entries.length) throw new Error("The release notes are not written one entry per block (two spaces, then {)");
  const head = [...kept, release].map(formatEntry).join(",\n");
  const rest = released.length ? text.slice(starts[drafts.length]) : "]\n";
  return { text: `[\n${head}${released.length ? ",\n" : "\n"}${rest}`, taken: taken.length, kept: kept.length };
}
