import { knownBranches } from "./branches";
import type { Env } from "./env";
import type { ProjectView } from "./project-views";
import { listProjects, type Project } from "./projects";
import { referenceBranch } from "./reference";
import type { Viewer } from "./views";

// What every project page needs: the reference branch chosen in the header
// (and the cookie remembering it), and the branches the menu starts with.
export async function projectView(
  request: Request,
  env: Env,
  project: Project,
  viewer: Viewer,
): Promise<{ view: ProjectView; cookies: string[] }> {
  const { ref, cookie } = referenceBranch(request, project);
  const [branches, projects] = await Promise.all([knownBranches(env, project, ref), listProjects(env.DB)]);
  return {
    view: {
      ...project,
      ref,
      knownBranches: branches,
      path: new URL(request.url).pathname,
      ...(viewer.perspective ? { perspective: viewer.perspective } : {}),
      projects: projects.map((other) => ({ repo: other.repo, name: other.check?.config?.nom || other.repo })),
    },
    cookies: cookie ? [cookie] : [],
  };
}
