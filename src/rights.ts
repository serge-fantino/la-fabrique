import type { Role } from "./accounts";

// What each action needs (la-fabrique#65). Each role has the rights of the
// ones below it: tester, then Product Engineer, tech lead, super admin.
export type Action =
  // Any account with access to the project, a role or not (from the
  // project's app).
  | "report_defect"
  // See int and the stories to validate, tick criteria, validate.
  | "validate"
  // Write and refine requests, prioritize the backlog.
  | "request"
  // Launch Claude, review, change the project's setup.
  | "launch_claude"
  // Go to production, roles, projects, apps.
  | "go";

const RANK: Record<Role, number> = { tester: 1, product_engineer: 2, tech_lead: 3, super_admin: 4 };

const NEEDS: Record<Action, number> = { report_defect: 0, validate: 1, request: 2, launch_claude: 3, go: 4 };

export function can(role: Role | null, action: Action): boolean {
  return (role ? RANK[role] : 0) >= NEEDS[action];
}
