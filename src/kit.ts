import { css, script } from "./http";
import reportCss from "../kit/fabrique-report.css";
import reportJs from "../kit/fabrique-report.js";
import earlyJs from "../kit/fabrique-report-early.js";
import reportKitGuide from "../docs/report-kit.md";

// The report kit a project copies into its own app (docs/report-kit.md):
// served for download, from any origin, never run by La Fabrique's pages.
export const KIT_GUIDE_PATH = "/guide/report-kit";
export { reportKitGuide };

const FILES: Record<string, { body: string; serve: typeof css }> = {
  "/kit/fabrique-report.js": { body: reportJs, serve: script },
  "/kit/fabrique-report.css": { body: reportCss, serve: css },
  "/kit/fabrique-report-early.js": { body: earlyJs, serve: script },
};

// The version the kit's files carry in their first line.
export const KIT_VERSION = /FabriqueReport (\d+\.\d+\.\d+)/.exec(reportJs)?.[1] ?? "unknown";

export function isKitFile(path: string): boolean {
  return path in FILES;
}

export function serveKitFile(path: string): Response {
  const file = FILES[path];
  if (!file) return new Response(null, { status: 404 });
  return file.serve(file.body, { "access-control-allow-origin": "*", "cache-control": "no-cache" });
}
