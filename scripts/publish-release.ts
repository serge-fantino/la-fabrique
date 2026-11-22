// The release of a sprint, by hand: node --experimental-strip-types scripts/publish-release.ts <notes file> <version>
// <title> <stories, comma-separated> [titles.json]. The same as `node kit/release-notes.js publish …`, which
// .github/workflows/release.yml runs: the code is the tool every project copies (kit/release-notes.js).
import { readFileSync, writeFileSync } from "node:fs";
import { nowIn, publishRelease } from "../kit/release-notes.js";

const [file, version, title, stories, titles] = process.argv.slice(2);
if (!file || !version || !title || stories === undefined) {
  console.error("usage: publish-release.ts <notes file> <version> <title> <stories, comma-separated> [titles.json]");
  process.exit(2);
}
const published = publishRelease(readFileSync(file, "utf8"), {
  version,
  title,
  stories: stories.split(",").map((value) => Number(value.trim().replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0),
  now: nowIn("Europe/Paris"),
  ...(titles ? { titles: JSON.parse(readFileSync(titles, "utf8")) as Record<string, string> } : {}),
});
writeFileSync(file, published.text);
console.log(`taken ${published.taken}, kept ${published.kept}`);
