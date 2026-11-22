// A GitHub Actions OIDC token, checked (epic F15, la-fabrique#424): a run of
// a project's workflow proves who it is with the token GitHub signs for it
// (`permissions: id-token: write`), so a project's runner can report to La
// Fabrique without any secret of La Fabrique, and La Fabrique never holds a
// key of the project (principle 3).

export const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60 * 1000;
// A little leeway between GitHub's clock and ours.
const LEEWAY_S = 60;

export interface RunClaims {
  repository: string;
  // "owner/repo/.github/workflows/claude.yml@refs/heads/main"
  workflow_ref: string;
  run_id: string;
  actor?: string;
  ref?: string;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let cache: { at: number; keys: Jwk[] } | null = null;

// For the tests: forget the keys read.
export function forgetKeys(): void {
  cache = null;
}

async function keys(force = false): Promise<Jwk[]> {
  if (!force && cache && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
  const response = await fetch(JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GitHub's keys could not be read (${response.status}).`);
  const data = (await response.json()) as { keys?: Jwk[] };
  cache = { at: Date.now(), keys: data.keys ?? [] };
  return cache.keys;
}

function base64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(base64url(part))) as T;
}

export type OidcOutcome = { ok: true; claims: RunClaims } | { ok: false; reason: string };

// The token's signature (RS256, one of GitHub's keys), issuer, audience and
// times; its claims once they hold.
export async function verifyRunToken(token: string, audience: string, now: number = Date.now()): Promise<OidcOutcome> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "Not a token." };
  const [head, body, signature] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = decodePart(head);
    claims = decodePart(body);
  } catch {
    return { ok: false, reason: "Not a token." };
  }
  if (header.alg !== "RS256" || !header.kid) return { ok: false, reason: "Not a token GitHub signs." };
  let key = (await keys()).find((candidate) => candidate.kid === header.kid);
  // GitHub turns its keys: an unknown one, read them again once.
  if (!key) key = (await keys(true)).find((candidate) => candidate.kid === header.kid);
  if (!key) return { ok: false, reason: "Signed by a key GitHub does not publish." };
  const imported = await crypto.subtle.importKey("jwk", { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", imported, base64url(signature), new TextEncoder().encode(`${head}.${body}`));
  if (!valid) return { ok: false, reason: "The signature does not hold." };
  if (claims["iss"] !== ISSUER) return { ok: false, reason: "Not issued by GitHub Actions." };
  const aud = claims["aud"];
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return { ok: false, reason: `Not meant for ${audience}.` };
  const seconds = Math.floor(now / 1000);
  if (typeof claims["exp"] !== "number" || claims["exp"] + LEEWAY_S < seconds) return { ok: false, reason: "Expired." };
  if (typeof claims["nbf"] === "number" && claims["nbf"] - LEEWAY_S > seconds) return { ok: false, reason: "Not valid yet." };
  const repository = claims["repository"];
  const workflowRef = claims["workflow_ref"];
  const runId = claims["run_id"];
  if (typeof repository !== "string" || typeof workflowRef !== "string" || typeof runId !== "string") return { ok: false, reason: "Not a workflow run's token." };
  return {
    ok: true,
    claims: {
      repository,
      workflow_ref: workflowRef,
      run_id: runId,
      ...(typeof claims["actor"] === "string" ? { actor: claims["actor"] } : {}),
      ...(typeof claims["ref"] === "string" ? { ref: claims["ref"] } : {}),
    },
  };
}

// The workflow file of a token's run: ".github/workflows/claude.yml".
export function workflowPath(claims: RunClaims): string {
  const at = claims.workflow_ref.indexOf("@");
  const path = at === -1 ? claims.workflow_ref : claims.workflow_ref.slice(0, at);
  return path.split("/").slice(2).join("/");
}
