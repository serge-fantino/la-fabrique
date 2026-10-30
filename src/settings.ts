import { assetUrl } from "./assets";
import { csrfField, escapeHtml, layout, type Viewer } from "./views";

export const SETTINGS_PATH = "/settings";
export const REFRESH_PATH = "/settings/refresh";
export const SLOW_PATH = "/settings/slow";
const SLOW_MS = 3000;

const NOTICES: Record<string, string> = {
  refreshed: "Everything was reloaded from the server.",
  tried: "Back from a page that took 3 seconds: the red light should have kept sweeping all along.",
};

// This device against what is online: the version, and the stylesheet and
// script the page actually runs (filled in by /fabrique.js).
export function settingsPage(viewer: Viewer, data: { version: string | null; commit: string; notice?: string | null }): string {
  const known = data.notice ? NOTICES[data.notice] : undefined;
  return layout(
    "Settings · La Fabrique extraordinaire",
    `<h1>Settings</h1>
      ${known ? `<p class="notice ok" role="status">${escapeHtml(known)}</p>` : ""}
      <section>
        <h2>Version</h2>
        <dl class="facts">
          <dt>Online</dt><dd><span class="mono">${escapeHtml(data.version ?? "unknown")}</span> · commit <span class="mono">${escapeHtml(data.commit.slice(0, 7))}</span></dd>
          <dt>Stylesheet expected</dt><dd><code>${escapeHtml(assetUrl("/styles.css"))}</code></dd>
          <dt>Script expected</dt><dd><code>${escapeHtml(assetUrl("/fabrique.js"))}</code></dd>
          <dt>On this device</dt><dd data-diagnostic data-expected-script="${escapeHtml(assetUrl("/fabrique.js"))}"><span class="muted">The script did not run: this browser has an old copy, or blocks scripts.</span></dd>
        </dl>
      </section>
      <section>
        <h2>Apps</h2>
        <p>Apps of the projects you allowed to act in your name${viewer.role === "super_admin" ? ", and the apps registered in La Fabrique" : ""}.</p>
        <p><a class="button quiet" href="/apps">Connected apps</a></p>
      </section>
      <section>
        <h2>Reload</h2>
        <p>If a page looks old after an update, reload everything: the browser forgets what it kept of La Fabrique (your session stays), then the page comes back from the server.</p>
        <form method="post" action="${REFRESH_PATH}" data-refresh>${csrfField(viewer)}
          <button type="submit" class="button">Reload everything</button>
        </form>
      </section>
      <section>
        <h2>Loading bar</h2>
        <p>Open a page that takes ${SLOW_MS / 1000} seconds to answer, to see the bar at work.</p>
        <p><a class="button quiet" href="${SLOW_PATH}">Try a slow page</a></p>
      </section>`,
    viewer,
  );
}

// Clear-Site-Data asks the browser to drop its HTTP cache for this site;
// the script also empties any Cache Storage before the form is sent.
export function refreshHeaders(): Record<string, string> {
  return { "clear-site-data": '"cache"' };
}

export async function slowPage(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
}
