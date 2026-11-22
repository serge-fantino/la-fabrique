// One release-notes entry written as the file writes them: two spaces, arrays of numbers on one line. The same as
// formatEntry of kit/release-notes.js (the tool every project runs at its merges), which the Worker only has as text;
// test-scripts/release-notes.test.ts checks that both write the same. Used to open a project's next release.
export function formatEntry(entry: Record<string, unknown>): string {
  return JSON.stringify(entry, null, 2)
    .replace(/\[\s*((?:-?\d+(?:\.\d+)?\s*,\s*)*-?\d+(?:\.\d+)?)\s*\]/g, (_, numbers: string) => `[${numbers.split(/\s*,\s*/).join(", ")}]`)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
