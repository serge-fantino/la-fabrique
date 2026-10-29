import type { Env } from "./env";

export const ROLES = ["super_admin", "product_engineer", "tech_lead", "tester"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super admin",
  product_engineer: "Product Engineer",
  tech_lead: "Tech lead",
  tester: "Tester",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// GitHub logins are case-insensitive; they are stored lowercased.
export function normalizeLogin(login: string): string {
  return login.trim().replace(/^@/, "").toLowerCase();
}

const LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/;

export function isValidLogin(login: string): boolean {
  return LOGIN_PATTERN.test(login);
}

export function configuredSuperAdmins(env: Env): Set<string> {
  return new Set(
    (env.SUPER_ADMINS ?? "")
      .split(",")
      .map(normalizeLogin)
      .filter((login) => login.length > 0),
  );
}

export interface AccountRow {
  github_login: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

export async function findAccount(db: D1Database, login: string): Promise<AccountRow | null> {
  return db
    .prepare("SELECT github_login, role, created_at, updated_at FROM accounts WHERE github_login = ?")
    .bind(login)
    .first<AccountRow>();
}

export async function effectiveRole(env: Env, login: string): Promise<Role | null> {
  if (configuredSuperAdmins(env).has(login)) return "super_admin";
  const account = await findAccount(env.DB, login);
  return account?.role ?? null;
}

export async function listAccounts(db: D1Database): Promise<AccountRow[]> {
  const { results } = await db
    .prepare("SELECT github_login, role, created_at, updated_at FROM accounts ORDER BY github_login")
    .all<AccountRow>();
  return results;
}
