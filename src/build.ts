import releaseNotes from "../docs/release-notes.json";

// The version running (la-fabrique's own release notes) and the commit it
// was deployed from (COMMIT_SHA, set by the deploy workflow): shown under
// the (i) next to the name.
const build: { commit: string; deployedAt: string | null } = { commit: "dev", deployedAt: null };

export function setCommit(commit: string | undefined, deployedAt?: string): void {
  if (commit) build.commit = commit;
  if (deployedAt) build.deployedAt = deployedAt;
}

export interface BuildInfo {
  version: string | null;
  date: string | null;
  time: string | null;
  // When the running Worker was deployed (Paris), and how many changes are
  // online since the release: then the release's date is not the version's.
  deployedAt: string | null;
  waiting: number;
  commit: string;
}

type Note = { version?: string; date?: string; heure?: string };

// What is online: the last release, plus the `next` entries merged since
// ("0.78 + 3 changes"); the release itself when nothing is waiting.
export function onlineVersion(notes: readonly Note[] = releaseNotes as Note[]): string | null {
  const waiting = notes.findIndex((note) => note.version !== "next");
  const last = notes[waiting === -1 ? 0 : waiting];
  if (!last?.version) return null;
  const count = waiting === -1 ? 0 : waiting;
  return count ? `${last.version} + ${count} ${count === 1 ? "change" : "changes"}` : last.version;
}

export function buildInfo(): BuildInfo {
  const notes = releaseNotes as Note[];
  const latest = notes.find((note) => note.version !== "next");
  const waiting = notes.findIndex((note) => note.version !== "next");
  return {
    version: onlineVersion(notes),
    date: latest?.date ?? null,
    time: latest?.heure ?? null,
    deployedAt: build.deployedAt,
    waiting: waiting === -1 ? notes.length : waiting,
    commit: build.commit,
  };
}
