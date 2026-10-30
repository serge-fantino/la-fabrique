import { knownBranches } from "./branches";
import type { Env } from "./env";
import type { ProjectView } from "./project-views";
import type { Project } from "./projects";
import { referenceBranch } from "./reference";

// What every project page needs: the reference branch chosen in the header
// (and the cookie remembering it), and the branches the menu starts with.
export async function projectView(
  request: Request,
  env: Env,
  project: Project,
): Promise<{ view: ProjectView; cookies: string[] }> {
  const { ref, cookie } = referenceBranch(request, project);
  return {
    view: { ...project, ref, knownBranches: await knownBranches(env, project, ref), path: new URL(request.url).pathname },
    cookies: cookie ? [cookie] : [],
  };
}
