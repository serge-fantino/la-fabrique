import { css, script } from "./http";
import reportCss from "../kit/fabrique-report.css";
import reportJs from "../kit/fabrique-report.js";
import earlyJs from "../kit/fabrique-report-early.js";
import releaseNotesJs from "../kit/release-notes.js";
import reportKitGuide from "../docs/report-kit.md";
import releaseNotesKitGuide from "../docs/release-notes-kit.md";

// The report kit a project copies into its own app (docs/report-kit.md):
// served for download, from any origin, never run by La Fabrique's pages.
export const KIT_GUIDE_PATH = "/guide/report-kit";
export { reportKitGuide };
// The release-notes tool every project runs at its merges (docs/release-notes-kit.md).
export const RELEASE_NOTES_GUIDE_PATH = "/guide/release-notes-kit";
export { releaseNotesKitGuide };

const FILES: Record<string, { body: string; serve: typeof css }> = {
  "/kit/fabrique-report.js": { body: reportJs, serve: script },
  "/kit/fabrique-report.css": { body: reportCss, serve: css },
  "/kit/fabrique-report-early.js": { body: earlyJs, serve: script },
  // The release-notes tool every project copies (docs/release-notes-kit.md): run by Node in its workflows.
  "/kit/release-notes.js": { body: releaseNotesJs, serve: script },
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
    version: "1.9.0",
    relay: null,
  },
  {
    version: "1.8.0",
    relay: null,
  },
  {
    version: "1.7.0",
    relay:
      "With the generic relay (protocol 2), nothing to change: the feedback on a criterion goes to ?path=to-test/{story}/feedback. A relay route by route cannot pass it. To use the kit's own launcher, load it with data-button=\"true\" or call FabriqueReport.launcher() instead of your own buttons.",
  },
  {
    version: "1.6.0",
    relay:
      "Nothing to change: the kit still speaks to the relay as before. The relay can now be generic, written once (protocol 2, docs/report-kit.md): it answers \"relay\": 2 in its GET, then passes any `?path={path}` to La Fabrique's `/api/projects/{project}/{path}` with the person's token and the headers X-Fabrique-Environment, X-Fabrique-Version and X-Fabrique-Deployment; no new route for the next kit versions.",
  },
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

// The version of the release-notes tool, on its first line.
// The tool itself, as a project copies it (version.outil).
export const RELEASE_NOTES_TOOL: string = releaseNotesJs;
export const RELEASE_NOTES_KIT_VERSION = /FabriqueReleaseNotes (\d+\.\d+\.\d+)/.exec(releaseNotesJs)?.[1] ?? "unknown";

export const KIT_VERSION = /FabriqueReport (\d+\.\d+\.\d+)/.exec(reportJs)?.[1] ?? "unknown";

export function isKitFile(path: string): boolean {
  return path in FILES;
}

export function serveKitFile(path: string): Response {
  const file = FILES[path];
  if (!file) return new Response(null, { status: 404 });
  return file.serve(file.body, { "access-control-allow-origin": "*", "cache-control": "no-cache" });
}
