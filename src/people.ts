import {
  configuredSuperAdmins,
  findAccount,
  isRole,
  isValidLogin,
  listAccounts,
  normalizeLogin,
} from "./accounts";
import { activityStatement, recentActivity } from "./activity-log";
import type { Env } from "./env";
import { html, redirect } from "./http";
import { destroySessionsOf } from "./session";
import { peoplePage, type Viewer } from "./views";

const ACCOUNT_ACTIONS = ["account_added", "account_role_changed", "account_removed"] as const;

export async function showPeople(request: Request, env: Env, viewer: Viewer): Promise<Response> {
  const [accounts, changes, requests] = await Promise.all([
    listAccounts(env.DB),
    recentActivity(env.DB, ACCOUNT_ACTIONS, 20),
    env.DB.prepare(
      `SELECT actor AS login, MAX(occurred_at) AS lastRequestedAt FROM activity_log
       WHERE action = 'access_requested'
         AND actor NOT IN (SELECT github_login FROM accounts)
       GROUP BY actor ORDER BY lastRequestedAt DESC LIMIT 20`,
    ).all<{ login: string; lastRequestedAt: string }>(),
  ]);
  const superAdmins = configuredSuperAdmins(env);

  return html(
    peoplePage({
      viewer,
      accounts,
      configuredSuperAdmins: [...superAdmins],
      requests: requests.results.filter((row) => !superAdmins.has(row.login)),
      changes,
      notice: new URL(request.url).searchParams.get("notice") ?? undefined,
    }),
  );
}

function back(notice: string): Response {
  return redirect(`/people?notice=${notice}`);
}

export async function changePeople(form: FormData, env: Env, viewer: Viewer): Promise<Response> {
  const action = form.get("action");
  const login = normalizeLogin(String(form.get("login") ?? ""));
  const role = form.get("role");

  if (!isValidLogin(login)) return back("invalid_login");
  if (configuredSuperAdmins(env).has(login)) return back("configured");

  const existing = await findAccount(env.DB, login);
  const db = env.DB;
  const log = (name: string, details: Record<string, unknown>) =>
    activityStatement(db, { actor: viewer.login, action: name, details: { login, ...details } });

  switch (action) {
    case "add": {
      if (!isRole(role)) return back("invalid_role");
      if (existing) return back("exists");
      await db.batch([
        db.prepare("INSERT INTO accounts (github_login, role) VALUES (?, ?)").bind(login, role),
        log("account_added", { role }),
      ]);
      return back("added");
    }
    case "update": {
      if (!isRole(role)) return back("invalid_role");
      if (!existing) return back("unknown");
      if (existing.role === role) return back("updated");
      await db.batch([
        db
          .prepare(
            "UPDATE accounts SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE github_login = ?",
          )
          .bind(role, login),
        log("account_role_changed", { role, previous_role: existing.role }),
      ]);
      return back("updated");
    }
    case "remove": {
      if (!existing) return back("unknown");
      await db.batch([
        db.prepare("DELETE FROM accounts WHERE github_login = ?").bind(login),
        destroySessionsOf(db, login),
        log("account_removed", { previous_role: existing.role }),
      ]);
      return back("removed");
    }
    default:
      return back("unknown");
  }
}
