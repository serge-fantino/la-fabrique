import { clearHostCookie, hostCookie, readCookie } from "./http";
import { isBranchName, productionBranch, type Project } from "./projects";

export const REF_COOKIE = "__Host-lf_ref";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function readRefs(request: Request): Record<string, string> {
  const raw = readCookie(request, REF_COOKIE);
  if (!raw) return {};
  try {
    const data = JSON.parse(decodeURIComponent(raw)) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function refsCookie(refs: Record<string, string>): string {
  return Object.keys(refs).length
    ? hostCookie(REF_COOKIE, encodeURIComponent(JSON.stringify(refs)), ONE_YEAR_SECONDS)
    : clearHostCookie(REF_COOKIE);
}

// The reference branch of a project's screens, like a checkout: `?ref=`
// chooses it and it is remembered per project; null means production.
export function referenceBranch(request: Request, project: Project): { ref: string | null; cookie: string | null } {
  const production = productionBranch(project);
  const key = project.repo.toLowerCase();
  const refs = readRefs(request);
  const asked = new URL(request.url).searchParams.get("ref");
  if (asked === null) {
    const saved = refs[key];
    return { ref: typeof saved === "string" && isBranchName(saved) && saved !== production ? saved : null, cookie: null };
  }
  const wanted = asked.trim();
  const ref = wanted && isBranchName(wanted) && wanted !== production ? wanted : null;
  if (ref) refs[key] = ref;
  else delete refs[key];
  return { ref, cookie: refsCookie(refs) };
}

export function forgetReference(request: Request, project: Project): string {
  const refs = readRefs(request);
  delete refs[project.repo.toLowerCase()];
  return refsCookie(refs);
}
