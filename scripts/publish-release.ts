// Used by the release workflow (.github/workflows/release.yml), when the sprint closes:
//   node --experimental-strip-types scripts/publish-release.ts <notes file> <version> <title> <stories, comma-separated> [titles.json]
// Rewrites the release notes: the `next` entries that declare a story done become one entry, dated now (Paris);
// prints how many entries it took and kept.
import { readFileSync, writeFileSync } from "node:fs";
import { publishRelease } from "../src/release-publish.ts";

const [file, version, title, stories, titles] = process.argv.slice(2);
if (!file || !version || !title || stories === undefined) {
  console.error("usage: publish-release.ts <notes file> <version> <title> <stories, comma-separated> [titles.json]");
  process.exit(2);
}
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date())
    .map((part) => [part.type, part.value]),
);
const published = publishRelease(readFileSync(file, "utf8"), {
  version,
  title,
  stories: stories.split(",").map((value) => Number(value.trim().replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0),
  now: { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` },
  ...(titles ? { titles: JSON.parse(readFileSync(titles, "utf8")) as Record<string, string> } : {}),
});
writeFileSync(file, published.text);
console.log(`taken ${published.taken}, kept ${published.kept}`);
