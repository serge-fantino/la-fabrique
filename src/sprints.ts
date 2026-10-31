import { activityStatement } from "./activity-log";

// The sprints of a project (la-fabrique#109): a release, started in La
// Fabrique, one at a time; ended when it ships or is stopped. Every start
// and end is logged.
export interface Sprint {
  id: number;
  repo: string;
  release: string;
  startedAt: string;
  startedBy: string;
  endedAt: string | null;
  endedBy: string | null;
  endReason: "stopped" | "shipped" | null;
}

interface SprintRow {
  id: number;
  repo: string;
  release: string;
  started_at: string;
  started_by: string;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
}

function toSprint(row: SprintRow): Sprint {
  return {
    id: row.id,
    repo: row.repo,
    release: row.release,
    startedAt: row.started_at,
    startedBy: row.started_by,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    endReason: row.end_reason === "stopped" || row.end_reason === "shipped" ? row.end_reason : null,
  };
}

// The newest sprint of a project, running or ended.
export async function latestSprint(db: D1Database, repo: string): Promise<Sprint | null> {
  const row = await db.prepare("SELECT * FROM sprints WHERE repo = ? ORDER BY id DESC LIMIT 1").bind(repo).first<SprintRow>();
  return row ? toSprint(row) : null;
}

export async function activeSprint(db: D1Database, repo: string): Promise<Sprint | null> {
  const sprint = await latestSprint(db, repo);
  return sprint && !sprint.endedAt ? sprint : null;
}

export async function startSprint(db: D1Database, repo: string, release: string, login: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const running = await activeSprint(db, repo);
  if (running) return { ok: false, message: `The sprint ${running.release} is in progress: stop it first.` };
  await db.batch([
    db.prepare("INSERT INTO sprints (repo, release, started_by) VALUES (?, ?, ?)").bind(repo, release, login),
    activityStatement(db, { actor: login, action: "sprint_started", repo, details: { release } }),
  ]);
  return { ok: true };
}

export async function endSprint(db: D1Database, sprint: Sprint, login: string, reason: "stopped" | "shipped"): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE sprints SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ended_by = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
      .bind(login, reason, sprint.id),
    activityStatement(db, { actor: login, action: reason === "shipped" ? "sprint_shipped" : "sprint_stopped", repo: sprint.repo, details: { release: sprint.release } }),
  ]);
}
