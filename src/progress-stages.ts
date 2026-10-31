// The stages of a card's progress (src/card-progress.ts), in their order;
// no import, so the views can use them.
export const PROGRESS_STAGES = ["to_prepare", "ready", "in_sprint", "in_dev", "to_test", "in_production"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export const PROGRESS_LABELS: Record<ProgressStage, string> = {
  to_prepare: "Stories to prepare",
  ready: "Ready for dev",
  in_sprint: "In sprint",
  in_dev: "In development",
  to_test: "To test",
  in_production: "In production",
};

export function isProgressStage(value: unknown): value is ProgressStage {
  return typeof value === "string" && (PROGRESS_STAGES as readonly string[]).includes(value);
}

export interface Progress {
  stage: ProgressStage;
  // How far the stage goes: stories ready, developed, validated, out; of the
  // stories needed (the nice to have count only when all are).
  done: number;
  total: number;
  // All the counts, for the pill's title: "3 stories: 3 ready, 2 developed…".
  counts?: { ready: number; developed: number; validated: number; out: number };
}

// What the count of a stage means: "1/3 developed".
export function progressDetail(progress: Progress): string {
  const of = `${progress.done}/${progress.total}`;
  switch (progress.stage) {
    case "to_prepare":
    case "in_sprint":
      return progress.done === progress.total ? "" : `${of} ready`;
    case "ready":
      return "";
    case "in_dev":
      return `${of} developed`;
    case "to_test":
      return `${of} validated`;
    case "in_production":
      return progress.total > 1 ? `${of}` : "";
  }
}

// The card's status pill once its stories carry it: the stage and its
// count; the title says all the counts.
export function progressPill(progress: Progress | null | undefined, since?: string | null): string {
  if (!progress) return "";
  const detail = progressDetail(progress);
  const counts = progress.counts;
  const breakdown = counts
    ? `${progress.total} stor${progress.total === 1 ? "y" : "ies"}: ${counts.ready} ready, ${counts.developed} developed, ${counts.validated} validated, ${counts.out} in production`
    : `${progress.total} stor${progress.total === 1 ? "y" : "ies"}`;
  const title = `Status from the card's stories. ${breakdown}${since ? `. Since ${since.slice(0, 16).replace("T", " ")} UTC` : ""}.`;
  return `<span class="pill card-${progress.stage}" title="${title}">${PROGRESS_LABELS[progress.stage]}${detail ? ` <span class="mono">${detail}</span>` : ""}</span>`;
}
