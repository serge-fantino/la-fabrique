import releaseNotes from "../docs/release-notes.json";

// The version running (la-fabrique's own release notes) and the commit it
// was deployed from (COMMIT_SHA, set by the deploy workflow): shown under
// the (i) next to the name.
const build = { commit: "dev" };

export function setCommit(commit: string | undefined): void {
  if (commit) build.commit = commit;
}

export interface BuildInfo {
  version: string | null;
  date: string | null;
  time: string | null;
  commit: string;
}

export function buildInfo(): BuildInfo {
  const latest = releaseNotes[0] as { version?: string; date?: string; heure?: string } | undefined;
  return { version: latest?.version ?? null, date: latest?.date ?? null, time: latest?.heure ?? null, commit: build.commit };
}
