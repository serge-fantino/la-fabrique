export interface ActivityEntry {
  actor: string;
  action: string;
  repo?: string;
  issueNumber?: number;
  details?: Record<string, unknown>;
}

// Returned as a statement so callers can batch it with the change it records.
export function activityStatement(db: D1Database, entry: ActivityEntry): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO activity_log (actor, action, repo, issue_number, details) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      entry.actor,
      entry.action,
      entry.repo ?? null,
      entry.issueNumber ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    );
}

export interface ActivityRow {
  occurred_at: string;
  actor: string;
  action: string;
  details: string | null;
}

export async function recentActivity(
  db: D1Database,
  actions: readonly string[],
  limit: number,
): Promise<ActivityRow[]> {
  const placeholders = actions.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT occurred_at, actor, action, details FROM activity_log
       WHERE action IN (${placeholders})
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(...actions, limit)
    .all<ActivityRow>();
  return results;
}
