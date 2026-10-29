import type { Env } from "./env";

const API = "https://api.github.com";
const USER_AGENT = "la-fabrique";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto only
// imports PKCS#8, so the key is wrapped in a PKCS#8 envelope.
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const octetString = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...octetString];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    isPkcs1 ? pkcs1ToPkcs8(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// GitHub accepts the App's client ID as the JWT issuer.
export async function appJwt(clientId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: clientId,
  })}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

function appCredentials(env: Env): { clientId: string; privateKey: string } {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new GitHubError(0, "The GitHub App private key is not configured on this Worker.");
  }
  return { clientId: env.GITHUB_APP_CLIENT_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
}

export async function githubFetch(token: string, path: string, accept = "application/vnd.github+json"): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
}

export async function githubJson<T>(token: string, path: string): Promise<T> {
  const response = await githubFetch(token, path);
  if (!response.ok) throw new GitHubError(response.status, `GitHub answered ${response.status} for ${path}`);
  return (await response.json()) as T;
}

export async function installationToken(env: Env, installationId: number): Promise<string> {
  const { clientId, privateKey } = appCredentials(env);
  const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await appJwt(clientId, privateKey)}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new GitHubError(response.status, `GitHub refused an installation token (${response.status}).`);
  }
  return ((await response.json()) as { token: string }).token;
}

export interface InstalledRepo {
  repo: string;
  installationId: number;
}

export async function listInstalledRepos(env: Env): Promise<InstalledRepo[]> {
  const { clientId, privateKey } = appCredentials(env);
  const jwt = await appJwt(clientId, privateKey);
  const installations = await githubJson<{ id: number }[]>(jwt, "/app/installations?per_page=100");
  const repos: InstalledRepo[] = [];
  for (const installation of installations) {
    const token = await installationToken(env, installation.id);
    const { repositories } = await githubJson<{ repositories: { full_name: string }[] }>(
      token,
      "/installation/repositories?per_page=100",
    );
    for (const repository of repositories) {
      repos.push({ repo: repository.full_name, installationId: installation.id });
    }
  }
  return repos.sort((a, b) => a.repo.localeCompare(b.repo));
}
