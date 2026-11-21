// Run by `npm test` with node:test. The pages' security policy
// (style-src 'self') drops every inline style: a `style="…"` in a page is
// silently ignored (seen on Refinement's gauges, all drawn full). Widths and
// proportions go through classes (growClass) or SVG attributes (gaugeSvg).
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Documents served with their own policy, outside the app's pages.
const OWN_POLICY = new Set(["share-links.ts", "preparation.ts"]);

test("no page of the app carries an inline style", () => {
  const found: string[] = [];
  for (const dir of ["src", "site"]) {
    for (const file of readdirSync(dir)) {
      if (!/\.(ts|js)$/.test(file) || OWN_POLICY.has(file)) continue;
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\sstyle=\\?["']/.test(line)) found.push(`${dir}/${file}:${i + 1}`);
        });
    }
  }
  assert.deepEqual(found, []);
});
