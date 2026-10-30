import type { Role } from "./accounts";
import { can } from "./rights";

// What a person sees (la-fabrique#75): a perspective is named after an
// activity, not a role. It hides tabs, it never forbids anything: rights
// stay in src/rights.ts.
export const PERSPECTIVES = ["product", "administration", "all"] as const;
export type Perspective = (typeof PERSPECTIVES)[number];

export const PERSPECTIVE_LABELS: Record<Perspective, string> = {
  product: "Product",
  administration: "Administration",
  all: "All",
};

// The project tabs of each perspective, in their order (null: every tab).
export const PERSPECTIVE_TABS: Record<Perspective, string[] | null> = {
  product: ["overview", "board", "stories", "backlog", "to_test", "defects", "roadmap", "releases", "requests"],
  administration: ["overview", "production", "to_test", "defects", "in_dev", "delivery", "activity", "releases", "log", "setup"],
  all: null,
};

export function isPerspective(value: unknown): value is Perspective {
  return typeof value === "string" && (PERSPECTIVES as readonly string[]).includes(value);
}

// The perspectives follow the role, along the same ladder as rights.
export function availablePerspectives(role: Role): Perspective[] {
  return PERSPECTIVES.filter((perspective) => {
    if (perspective === "product") return can(role, "request");
    if (perspective === "administration") return role === "super_admin";
    return true;
  });
}

// Product Engineers start in Product; the others keep the whole view.
export function defaultPerspective(role: Role): Perspective {
  return role === "product_engineer" ? "product" : "all";
}

export async function currentPerspective(db: D1Database, login: string, role: Role): Promise<Perspective> {
  const row = await db
    .prepare("SELECT perspective FROM perspective_choices WHERE github_login = ?")
    .bind(login)
    .first<{ perspective: string }>();
  const chosen = row?.perspective;
  return isPerspective(chosen) && availablePerspectives(role).includes(chosen) ? chosen : defaultPerspective(role);
}

export async function choosePerspective(db: D1Database, login: string, perspective: Perspective): Promise<void> {
  await db
    .prepare(
      `INSERT INTO perspective_choices (github_login, perspective) VALUES (?, ?)
       ON CONFLICT (github_login) DO UPDATE SET perspective = excluded.perspective,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(login, perspective)
    .run();
}
