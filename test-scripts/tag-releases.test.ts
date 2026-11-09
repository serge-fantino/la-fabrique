// Run by `npm test` with node:test (the Workers pool of vitest cannot run git).
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../scripts/tag-releases.ts";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const notes = (...e: [string, string][]) => JSON.stringify(e.map(([version, titre]) => ({ version, titre })));

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "tag-releases-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "user.email", "t@example.com");
  mkdirSync(join(dir, "docs"));
  return dir;
};
const commit = (dir: string, text: string, message: string) => {
  writeFileSync(join(dir, "docs/release-notes.json"), text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "--allow-empty", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
};
const opts = (cwd: string, dryRun = false) => ({ cwd, notes: "docs/release-notes.json", since: "HEAD^", remote: "origin", dryRun });
const quiet = () => {};

test("tags the version a merge brought, on the commit that carries it, with the release title", () => {
  const dir = repo();
  commit(dir, notes(["0.84", "Old"]), "Release 0.84");
  const c = commit(dir, notes(["0.85", "New things"], ["0.84", "Old"]), "Release 0.85");
  commit(dir, notes(["0.85", "New things"], ["0.84", "Old"]), "Unrelated");
  const done = run({ ...opts(dir), since: "HEAD~2" }, quiet);
  assert.deepEqual(done.map((p) => p.tag), ["v0.85"]);
  assert.equal(sh(dir, "rev-list", "-n1", "v0.85"), c);
  assert.equal(sh(dir, "cat-file", "-t", "v0.85"), "tag");
  assert.match(sh(dir, "tag", "-l", "-n1", "v0.85"), /New things/);
  assert.equal(sh(dir, "tag", "-l", "v0.84"), "");
});

test("tags several versions of one merge, each tag once, and leaves an existing tag where it is", () => {
  const dir = repo();
  commit(dir, notes(["0.84", "Old"]), "Release 0.84");
  sh(dir, "tag", "-a", "v0.84", "-m", "Old");
  const first = commit(dir, notes(["0.85", "A"], ["0.84", "Old"]), "Release 0.85");
  commit(dir, notes(["0.86", "B"], ["0.85", "A"], ["0.84", "Old"]), "Release 0.86");
  assert.deepEqual(run(opts(dir), quiet).map((p) => p.tag), ["v0.85", "v0.86"]);
  assert.equal(sh(dir, "rev-list", "-n1", "v0.85"), first);
  const at = sh(dir, "rev-list", "-n1", "v0.84");
  assert.deepEqual(run(opts(dir), quiet), []);
  assert.equal(sh(dir, "rev-list", "-n1", "v0.84"), at);
});

test("a failed push does not fail, and the next run sets the missing tag", () => {
  const dir = repo();
  commit(dir, notes(["0.84", "Old"]), "Release 0.84");
  commit(dir, notes(["0.85", "New"], ["0.84", "Old"]), "Release 0.85");
  const lines: string[] = [];
  run({ ...opts(dir), remote: "nowhere" }, (l) => lines.push(l));
  assert.ok(lines.some((l) => l.startsWith("::warning")));
  assert.equal(sh(dir, "tag", "-l", "v0.85"), "v0.85");
  sh(dir, "tag", "-d", "v0.85");
  assert.deepEqual(run({ ...opts(dir), since: "HEAD" }, quiet).map((p) => p.tag), []);
});

test("recovers a tag missed earlier once a newer one exists is not needed: missing newer versions are set", () => {
  const dir = repo();
  commit(dir, notes(["0.84", "Old"]), "Release 0.84");
  sh(dir, "tag", "-a", "v0.84", "-m", "Old");
  commit(dir, notes(["0.85", "A"], ["0.84", "Old"]), "Release 0.85 (push failed)");
  commit(dir, notes(["0.86", "B"], ["0.85", "A"], ["0.84", "Old"]), "Release 0.86");
  assert.deepEqual(run(opts(dir), quiet).map((p) => p.tag), ["v0.85", "v0.86"]);
});

test("an entry still next gets no tag", () => {
  const dir = repo();
  commit(dir, notes(["0.84", "Old"]), "Release 0.84");
  commit(dir, notes(["next", "Pending"], ["0.84", "Old"]), "A pull request");
  assert.deepEqual(run(opts(dir), quiet), []);
  assert.equal(sh(dir, "tag", "-l"), "");
});

test("--dry-run lists the tags and commits and sets nothing", () => {
  const dir = repo();
  commit(dir, notes(["0.84", "Old"]), "Release 0.84");
  commit(dir, notes(["0.85", "New"], ["0.84", "Old"]), "Release 0.85");
  const lines: string[] = [];
  const planned = run(opts(dir, true), (l) => lines.push(l));
  assert.equal(planned.length, 1);
  assert.match(lines[0]!, /would tag v0\.85 on [0-9a-f]{7}: New/);
  assert.equal(sh(dir, "tag", "-l"), "");
});
