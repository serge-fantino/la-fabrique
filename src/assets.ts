import { css, script } from "./http";
import stylesCss from "../site/styles.css";
import requestDraftJs from "../site/request-draft.js";
import fabriqueJs from "../site/fabrique.js";
import boardJs from "../site/board.js";

// FNV-1a: enough to tell two versions of a file apart.
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const FILES: Record<string, { body: string; serve: typeof css }> = {
  "/styles.css": { body: stylesCss, serve: css },
  "/fabrique.js": { body: fabriqueJs, serve: script },
  "/request-draft.js": { body: requestDraftJs, serve: script },
  "/board.js": { body: boardJs, serve: script },
};

const VERSIONS = new Map(Object.entries(FILES).map(([path, file]) => [path, fingerprint(file.body)]));

// Pages link to a file by its content's fingerprint: a new deploy changes
// the address, so no browser keeps an old stylesheet or script.
export function assetUrl(path: string): string {
  const version = VERSIONS.get(path);
  return version ? `${path}?v=${version}` : path;
}

export function isAsset(path: string): boolean {
  return VERSIONS.has(path);
}

// The fingerprinted address never changes content: cached for a year. The
// bare address (old pages, bookmarks) is checked again on every use.
export function serveAsset(request: Request, path: string): Response {
  const file = FILES[path];
  const version = VERSIONS.get(path);
  if (!file || !version) return new Response(null, { status: 404 });
  const etag = `"${version}"`;
  const current = new URL(request.url).searchParams.get("v") === version;
  const cacheControl = current ? "public, max-age=31536000, immutable" : "no-cache";
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } });
  }
  return file.serve(file.body, { etag, "cache-control": cacheControl });
}
