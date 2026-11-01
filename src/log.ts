// La Fabrique's log for one project: what GitHub does not keep (who
// validated, prioritised, proposed a change, gave the go). Read-only.

export const LOG_GROUPS: { id: string; label: string; actions: string[] }[] = [
  { id: "requests", label: "Requests", actions: ["request_created"] },
  { id: "validation", label: "Validation on int", actions: ["criterion_checked", "criterion_unchecked", "story_validated", "defect_reported"] },
  { id: "backlog", label: "Priorities", actions: ["priority_set"] },
  { id: "production", label: "Go to production", actions: ["go_given", "next_release_proposed", "stories_shipped"] },
  { id: "claude", label: "Claude", actions: ["claude_launched", "claude_update_launched", "claude_run_finished", "claude_pr_opened", "claude_pr_updated", "review_requested", "pull_merge_launched", "pull_merge_finished"] },
  { id: "cards", label: "Cards", actions: ["card_created", "card_edited", "card_moved", "card_archived", "card_restored", "card_value_added", "card_spec_written", "card_version_restored", "card_story_created", "card_split_proposed", "card_stories_reviewed", "card_imported", "card_priority_set", "card_progress_changed"] },
  { id: "sprint", label: "Sprint", actions: ["sprint_started", "sprint_stopped", "sprint_shipped", "sprint_close_requested", "release_started", "release_published", "release_failed", "card_versioned", "story_closed", "sprint_card_moved", "sprint_story_moved", "story_nice_set", "story_marked_ready", "sprint_run_started", "sprint_run_paused", "sprint_run_resumed", "sprint_run_stopped", "sprint_run_card_resumed", "sprint_run_story_started", "sprint_run_story_updating", "sprint_run_story_merged", "sprint_run_card_done", "sprint_run_card_stopped", "sprint_run_done", "sprint_run_waiting"] },
  { id: "setup", label: "Project setup", actions: ["project_added", "config_change_proposed"] },
  { id: "assistant", label: "Through Claude (MCP)", actions: ["mcp_write"] },
];

export const PAGE_SIZE = 100;

export interface LogEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  issue: number | null;
  details: Record<string, unknown>;
}

export interface LogFilters {
  group: string | null;
  actor: string | null;
  before: number | null;
}

export async function readLog(
  db: D1Database,
  repo: string,
  filters: LogFilters,
): Promise<{ entries: LogEntry[]; more: boolean; actors: string[] }> {
  const where = ["repo = ?"];
  const binds: unknown[] = [repo];
  const actions = LOG_GROUPS.find((group) => group.id === filters.group)?.actions;
  if (actions) {
    where.push(`action IN (${actions.map(() => "?").join(", ")})`);
    binds.push(...actions);
  }
  if (filters.actor) {
    where.push("actor = ?");
    binds.push(filters.actor);
  }
  if (filters.before) {
    where.push("id < ?");
    binds.push(filters.before);
  }
  const [rows, actors] = await Promise.all([
    db
      .prepare(
        `SELECT id, occurred_at, actor, action, issue_number, details FROM activity_log
         WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
      )
      .bind(...binds, PAGE_SIZE + 1)
      .all<{ id: number; occurred_at: string; actor: string; action: string; issue_number: number | null; details: string | null }>(),
    db
      .prepare("SELECT DISTINCT actor FROM activity_log WHERE repo = ? ORDER BY actor")
      .bind(repo)
      .all<{ actor: string }>(),
  ]);
  const entries = rows.results.slice(0, PAGE_SIZE).map((row) => {
    let details: Record<string, unknown> = {};
    try {
      details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
    } catch {
      // An unreadable detail stays out of the sentence.
    }
    return { id: row.id, at: row.occurred_at, actor: row.actor, action: row.action, issue: row.issue_number, details };
  });
  return { entries, more: rows.results.length > PAGE_SIZE, actors: actors.results.map((row) => row.actor) };
}
