import type { Env } from "./env";
import { githubFetch, GitHubError, installationToken } from "./github-app";
import { html } from "./http";
import { MAX_MARKDOWN_LENGTH, renderMarkdown } from "./markdown";
import { docPage } from "./project-views";
import { checkProject, describeFailure, findProject, type ConfigCheck, type Project } from "./projects";
import { docUrl, githubBlobUrl, githubContentsPath } from "./urls";
import { messagePage, type Viewer } from "./views";

// One GitHub read per file and commit; older commits are dropped.
async function readMarkdown(env: Env, project: Project, sha: string, path: string): Promise<string> {
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
    env.DB.prepare("DELETE FROM doc_cache WHERE repo = ? AND commit_sha <> ?").bind(project.repo, sha),
    env.DB.prepare(
      "INSERT OR REPLACE INTO doc_cache (repo, commit_sha, path, markdown) VALUES (?, ?, ?, ?)",
    ).bind(project.repo, sha, path, markdown),
  ]);
  return markdown;
}

function notFound(viewer: Viewer, message: string): Response {
  return html(messagePage("Not found", message, viewer), { status: 404 });
}

export async function showDoc(env: Env, viewer: Viewer, repo: string, path: string): Promise<Response> {
  const project = await findProject(env.DB, repo);
  if (!project) return notFound(viewer, "There is no such project in La Fabrique extraordinaire.");

  let check: ConfigCheck | null = project.check;
  if (!check || check.docPages === null) {
    const outcome = await checkProject(env, project);
    if (!outcome.ok) return html(messagePage("Documentation unavailable", outcome.message, viewer), { status: 502 });
    check = outcome.check;
  }
  const pages = check.docPages ?? [];
  if (!pages.includes(path)) return notFound(viewer, "This page is not part of the project's documentation.");

  let markdown: string;
  try {
    markdown = await readMarkdown(env, project, check.commitSha, path);
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
          pageUrl: (candidate) => docUrl(project.repo, candidate),
          githubUrl: (candidate) => githubBlobUrl(project.repo, sha, candidate),
        });

  return html(docPage(viewer, { ...project, check }, path, rendered));
}
