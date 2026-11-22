// The merge of a pull request's release notes, by hand before merging without the workflow:
//   node --experimental-strip-types scripts/release-at-merge.ts <merge-base file> <branch file> <main file> <out file>
// The same as `node kit/release-notes.js merge … --mode next`, which .github/workflows/merge.yml runs: the code is the
// tool every project copies (kit/release-notes.js); this script only gives it La Fabrique's arguments.
import { readFileSync, writeFileSync } from "node:fs";
import { mergeReleaseNotes, nowIn } from "../kit/release-notes.js";

const [base, branch, main, out] = process.argv.slice(2);
if (!base || !branch || !main || !out) {
  console.error("usage: release-at-merge.ts <merge-base file> <branch file> <main file> <out file>");
  process.exit(2);
}
const merged = mergeReleaseNotes(readFileSync(base, "utf8"), readFileSync(branch, "utf8"), readFileSync(main, "utf8"), nowIn("Europe/Paris"), { mode: "next" });
writeFileSync(out, merged.text);
console.log(merged.versions.join(" "));
