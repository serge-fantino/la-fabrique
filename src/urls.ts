function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function projectUrl(repo: string): string {
  return `/projects/${repo}`;
}

function refQuery(ref: string | null | undefined): string {
  return ref ? `?ref=${encodeURIComponent(ref)}` : "";
}

export function docUrl(repo: string, path: string, ref?: string | null): string {
  return `/projects/${repo}/docs/${encodePath(path)}${refQuery(ref)}`;
}

export function projectRefUrl(repo: string, ref?: string | null): string {
  return `/projects/${repo}${refQuery(ref)}`;
}

export function githubBlobUrl(repo: string, ref: string, path: string): string {
  return `https://github.com/${repo}/blob/${ref}/${encodePath(path)}`;
}

export function githubContentsPath(repo: string, path: string, ref: string): string {
  return `/repos/${repo}/contents/${encodePath(path)}?ref=${ref}`;
}
