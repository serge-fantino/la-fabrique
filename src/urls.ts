function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function projectUrl(repo: string): string {
  return `/projects/${repo}`;
}

export function docUrl(repo: string, path: string): string {
  return `/projects/${repo}/docs/${encodePath(path)}`;
}

export function githubBlobUrl(repo: string, ref: string, path: string): string {
  return `https://github.com/${repo}/blob/${ref}/${encodePath(path)}`;
}

export function githubContentsPath(repo: string, path: string, ref: string): string {
  return `/repos/${repo}/contents/${encodePath(path)}?ref=${ref}`;
}
