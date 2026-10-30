const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

const CSP = CSP_DIRECTIVES.join("; ");

// The consent form ends on the app's own address: browsers apply
// `form-action` to the redirect after a form is sent.
export function cspWithFormTarget(origin: string): string {
  return CSP_DIRECTIVES.map((directive) => (directive === "form-action 'self'" ? `form-action 'self' ${origin}` : directive)).join("; ");
}

export function applySecurityHeaders(headers: Headers): void {
  if (!headers.has("content-security-policy")) headers.set("content-security-policy", CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "strict-transport-security",
    "max-age=31536000; includeSubDomains",
  );
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
}
