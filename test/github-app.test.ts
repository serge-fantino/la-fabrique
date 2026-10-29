import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appJwt } from "../src/github-app";

function fromBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

describe("GitHub App JWT", () => {
  it("signs with the App's PKCS#1 key, issued by the client ID", async () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const jwt = await appJwt("Iv1.test-client", env.GITHUB_APP_PRIVATE_KEY ?? "", now);
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(new TextDecoder().decode(fromBase64url(header ?? "")))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload ?? "")));
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "Iv1.test-client" });

    const spki = Uint8Array.from(
      atob(env.TEST_APP_PUBLIC_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
      (c) => c.charCodeAt(0),
    );
    const publicKey = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromBase64url(signature ?? ""),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });
});
