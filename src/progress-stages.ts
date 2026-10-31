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

const TONES: Record<ProgressStage, string> = { to_prepare: "", ready: "ok", in_sprint: "warn", in_dev: "warn", to_test: "warn", in_production: "ok" };

export interface Progress {
  stage: ProgressStage;
  // How far the stage goes: stories ready, developed, validated, out; of the
  // stories needed (the nice to have count only when all are).
  done: number;
  total: number;
}

// What the count of a stage means.
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

export function progressPill(progress: Progress | null | undefined, since?: string | null): string {
  if (!progress) return "";
  const detail = progressDetail(progress);
  const title = `Progress, from the card's stories${since ? `: since ${since.slice(0, 16).replace("T", " ")} UTC` : ""}`;
  return `<span class="pill progress-${progress.stage}${TONES[progress.stage] ? ` ${TONES[progress.stage]}` : ""}" title="${title}">${PROGRESS_LABELS[progress.stage]}${
    detail ? ` <span class="mono">${detail}</span>` : ""
  }</span>`;
}

