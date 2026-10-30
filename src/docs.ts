import type { Env } from "./env";
import { githubFetch, GitHubError, installationToken } from "./github-app";
import { html } from "./http";
import { MAX_MARKDOWN_LENGTH, renderMarkdown } from "./markdown";
import { docPage } from "./project-views";
import {
  checkOtherBranch,
  checkProject,
  describeFailure,
  findProject,
  type ConfigCheck,
  type Project,
} from "./projects";
import { docUrl, githubBlobUrl, githubContentsPath } from "./urls";
import { messagePage, type Viewer } from "./views";
import { forgetReference } from "./reference";
import { projectView } from "./view-context";

// One GitHub read per file and commit; older commits are dropped.
async function readMarkdown(env: Env, project: Project, branch: string | null, sha: string, path: string): Promise<string> {
  const cached = await env.DB.prepare(
    "SELECT markdown FROM doc_cache WHERE repo = ? AND commit_sha = ? AND path = ?",
  )
    .bind(project.repo, sha, path)
    .first<string>("markdown");
  if (cached !== null) return cached;

  const token = await installationToken(env, project.installationId);
  const response = await githubFetch(
    token,
    githubContentsPath(project.repo, path, sha),
    "application/vnd.github.raw+json",
  );
  if (!response.ok) throw new GitHubError(response.status, `Could not read ${path}`);
  const markdown = await response.text();
  if (markdown.length > MAX_MARKDOWN_LENGTH) return markdown;

  await env.DB.batch([
    branch
      ? env.DB.prepare("DELETE FROM doc_cache WHERE repo = ? AND branch = ? AND commit_sha <> ?").bind(project.repo, branch, sha)
      : env.DB.prepare("DELETE FROM doc_cache WHERE repo = ? AND branch IS NULL AND commit_sha <> ?").bind(project.repo, sha),
    env.DB.prepare(
      "INSERT OR REPLACE INTO doc_cache (repo, commit_sha, path, markdown, branch) VALUES (?, ?, ?, ?, ?)",
    ).bind(project.repo, sha, path, markdown, branch),
  ]);
  return markdown;
}

function notFound(viewer: Viewer, message: string): Response {
  return html(messagePage("Not found", message, viewer), { status: 404 });
}

export async function showDoc(request: Request, env: Env, viewer: Viewer, repo: string, path: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer, "There is no such project in La Fabrique extraordinaire.");

  const { view, cookies } = await projectView(request, env, project, viewer);
  const other = view.ref;
  let check: ConfigCheck | null = other ? null : project.check;
  if (other) {
    const outcome = await checkOtherBranch(env, project, other);
    if (!outcome.ok) {
      return html(messagePage("Documentation unavailable", outcome.message, viewer), {
        status: 404,
        cookies: [forgetReference(request, project)],
      });
    }
    check = outcome.check;
  } else if (!check || check.docPages === null) {
    const outcome = await checkProject(env, project);
    if (!outcome.ok) return html(messagePage("Documentation unavailable", outcome.message, viewer), { status: 502 });
    check = outcome.check;
  }
  const pages = check.docPages ?? [];
  if (!pages.includes(path)) {
    return notFound(
      viewer,
      other ? `This page is not part of the project's documentation on ${other}.` : "This page is not part of the project's documentation.",
    );
  }

  let markdown: string;
  try {
    markdown = await readMarkdown(env, project, other, check.commitSha, path);
  } catch (error) {
    return html(messagePage("Documentation unavailable", describeFailure(error), viewer), { status: 502 });
  }

  const sha = check.commitSha;
  const rendered =
    markdown.length > MAX_MARKDOWN_LENGTH
      ? { html: `<p>This file is too large to show here. Open it on GitHub.</p>`, title: null }
      : renderMarkdown(markdown, {
          path,
          isPage: (candidate) => pages.includes(candidate),
          pageUrl: (candidate) => docUrl(project.repo, candidate, other),
          githubUrl: (candidate) => githubBlobUrl(project.repo, sha, candidate),
        });

  return html(docPage(viewer, { ...view, check }, path, rendered, other), { cookies });
}
