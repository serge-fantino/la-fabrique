// Where a pull request's review by Claude stands (F14.4, la-fabrique#380), as a
// pill next to the pull request: running, ok, remarks, blocking, failed; for
// an older commit when commits came since.
import type { ReviewState } from "./review";
import { escapeHtml } from "./views";

function link(url: string | null, html: string): string {
  return url?.startsWith("https://github.com/") ? `<a class="review-link" href="${escapeHtml(url)}">${html}</a>` : html;
}

export function reviewPill(review: ReviewState | undefined): string {
  if (!review) return "";
  if (review.state === "running") {
    return ` <span class="pill small" title="Started by @${escapeHtml(review.by)}">Review running</span>`;
  }
  const older = review.stale ? ` <span class="muted small" title="Commits were pushed after this review.">older commit</span>` : "";
  if (review.state === "failed") {
    return ` ${link(review.run, `<span class="pill alert small">Review failed</span>`)}${older}`;
  }
  const label =
    review.state === "ok"
      ? "Review OK"
      : review.state === "remarques"
        ? `Review: ${review.advice} remark${review.advice > 1 ? "s" : ""}`
        : `Review blocking: ${review.blocking}`;
  const tone = review.state === "ok" ? "ok" : review.state === "remarques" ? "" : "alert";
  return ` ${link(review.url, `<span class="pill ${tone} small">${escapeHtml(label)}</span>`)}${older}`;
}
