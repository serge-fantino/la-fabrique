const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

const CSP = CSP_DIRECTIVES.join("; ");

export function applySecurityHeaders(headers: Headers): void {
  headers.set("content-security-policy", CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "strict-transport-security",
    "max-age=31536000; includeSubDomains",
  );
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
}
