import { activityStatement } from "./activity-log";
import { randomToken, sha256Hex } from "./crypto";
import { escapeHtml } from "./views";
import { LOGO_SVG } from "./logo";
import { type Doc, renderHtml } from "./preparation";

// Secret links to a frozen copy of the preparation document (la-fabrique#233).

export const EXPIRY_DAYS = [1, 7, 30] as const;
export const DEFAULT_EXPIRY_DAYS = 30;
export const SHARE_PATH = /^\/shared\/([A-Za-z0-9_-]{20,100})$/;

export function readExpiry(value: unknown): number {
  const days = Number(value);
  return (EXPIRY_DAYS as readonly number[]).includes(days) ? days : DEFAULT_EXPIRY_DAYS;
}

export interface ShareLink {
  id: number;
  level: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  openings: number;
}

export function linkState(link: Pick<ShareLink, "expiresAt" | "revokedAt">, now = new Date()): "active" | "expired" | "revoked" {
  if (link.revokedAt) return "revoked";
  return Date.parse(link.expiresAt) <= now.getTime() ? "expired" : "active";
}

export async function createShareLink(
  db: D1Database,
  input: { repo: string; doc: Doc; by: string; days: number; now?: Date },
): Promise<{ id: number; token: string; expiresAt: string }> {
  const token = randomToken(32);
  const expiresAt = new Date((input.now ?? new Date()).getTime() + input.days * 86_400_000).toISOString();
  const row = await db
    .prepare("INSERT INTO share_links (repo, token_hash, level, doc, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(input.repo, await sha256Hex(token), input.doc.level, JSON.stringify(input.doc), input.by, expiresAt)
    .first<{ id: number }>();
  const id = row?.id ?? 0;
  await activityStatement(db, {
    actor: input.by,
    action: "share_link_created",
    repo: input.repo,
    details: { link: id, level: input.doc.level, days: input.days, expires: expiresAt },
  }).run();
  return { id, token, expiresAt };
}

export async function listShareLinks(db: D1Database, repo: string): Promise<ShareLink[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.level, l.created_by, l.created_at, l.expires_at, l.revoked_at,
              (SELECT COUNT(*) FROM share_link_openings o WHERE o.link_id = l.id) AS openings
       FROM share_links l WHERE l.repo = ? ORDER BY l.id DESC LIMIT 50`,
    )
    .bind(repo)
    .all<{ id: number; level: number; created_by: string; created_at: string; expires_at: string; revoked_at: string | null; openings: number }>();
  return results.map((r) => ({ id: r.id, level: r.level, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, openings: r.openings }));
}

export async function revokeShareLink(db: D1Database, repo: string, id: number, by: string): Promise<boolean> {
  const done = await db
    .prepare("UPDATE share_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = ? WHERE id = ? AND repo = ? AND revoked_at IS NULL")
    .bind(by, id, repo)
    .run();
  if (!done.meta.changes) return false;
  await activityStatement(db, { actor: by, action: "share_link_revoked", repo, details: { link: id } }).run();
  return true;
}

function page(title: string, message: string, status: number): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="robots" content="noindex, nofollow" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#18211B"><div style="width:56px">${LOGO_SVG}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return respondShared(body, status);
}

// Own CSP (the document carries its inline style, no script): the common
// one only allows styles from the site itself.
function respondShared(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

// Public: no account. Counts the opening (the date, never who).
export async function showSharedDocument(db: D1Database, token: string, now = new Date()): Promise<Response> {
  const row = await db
    .prepare("SELECT id, doc, expires_at, revoked_at FROM share_links WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: number; doc: string; expires_at: string; revoked_at: string | null }>();
  if (!row) return page("Not found", "There is nothing at this address.", 404);
  const state = linkState({ expiresAt: row.expires_at, revokedAt: row.revoked_at }, now);
  if (state === "revoked") return page("Link revoked", "The person who shared this document has revoked the link.", 410);
  if (state === "expired") return page("Link expired", "This link has expired.", 410);
  await db.prepare("INSERT INTO share_link_openings (link_id) VALUES (?)").bind(row.id).run();
  const html = renderHtml(JSON.parse(row.doc) as Doc).replace("<head>", '<head><meta name="robots" content="noindex, nofollow" />');
  return respondShared(html, 200);
}
