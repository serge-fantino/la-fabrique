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
// The kit's files by name, as a project keeps them.
export const KIT_SOURCES: Record<string, string> = {
  "fabrique-report.js": reportJs,
  "fabrique-report.css": reportCss,
  "fabrique-report-early.js": earlyJs,
};

// What a project's relay must do for each version, beyond copying the files.
export const KIT_CHANGES: { version: string; relay: string | null }[] = [
  {
    version: "1.5.0",
    relay:
      "The relay passes `steps` (a list) on `POST ?to-test={story}/criteria` to La Fabrique's criteria call, as it comes.",
  },
  {
    version: "1.4.0",
    relay:
      "To show the stories to test, the relay asks for the scope `stories:test` when linking, answers `can_test` in its `GET`, and answers `GET ?to-test=1` with La Fabrique's `GET /api/projects/{project}/to-test`.",
  },
  {
    version: "1.2.0",
    relay: "The relay passes `change` on `POST` (the index of the change chosen in the version's release note).",
  },
  {
    version: "1.1.0",
    relay:
      "The relay answers `GET ?targets=1` with La Fabrique's `GET /api/projects/{project}/targets`, and passes `story` and `release` on `POST`.",
  },
  { version: "1.0.0", relay: null },
];

export const KIT_VERSION = /FabriqueReport (\d+\.\d+\.\d+)/.exec(reportJs)?.[1] ?? "unknown";

export function isKitFile(path: string): boolean {
  return path in FILES;
}

export function serveKitFile(path: string): Response {
  const file = FILES[path];
  if (!file) return new Response(null, { status: 404 });
  return file.serve(file.body, { "access-control-allow-origin": "*", "cache-control": "no-cache" });
}
