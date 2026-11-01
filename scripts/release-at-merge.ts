// Used by the merge workflow (.github/workflows/merge.yml):
//   node --experimental-strip-types scripts/release-at-merge.ts <merge-base file> <branch file> <main file> <out file>
// Writes main's release notes with the pull request's own entries on top,
// kept as `next` (no number: the release at the close of the sprint gives it); prints the versions given (none).
import { readFileSync, writeFileSync } from "node:fs";
import { mergeReleaseNotes } from "../src/release-merge.ts";

const [base, branch, main, out] = process.argv.slice(2);
if (!base || !branch || !main || !out) {
  console.error("usage: release-at-merge.ts <merge-base file> <branch file> <main file> <out file>");
  process.exit(2);
}
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date())
    .map((part) => [part.type, part.value]),
);
const merged = mergeReleaseNotes(readFileSync(base, "utf8"), readFileSync(branch, "utf8"), readFileSync(main, "utf8"), {
  date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
  time: `${parts["hour"]}:${parts["minute"]}`,
});
writeFileSync(out, merged.text);
console.log(merged.versions.join(" "));
