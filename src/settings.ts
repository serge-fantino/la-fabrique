import { assetUrl } from "./assets";
import { callsTable, cardRef, cardUrl, spendLine } from "./card-views";
import { canUseClaude, formatUsd, knownPrice, type ClaudeSettings, type UsageReport } from "./llm";
import { csrfField, escapeHtml, layout, type Viewer } from "./views";

export const SETTINGS_PATH = "/settings";
export const REFRESH_PATH = "/settings/refresh";
export const SLOW_PATH = "/settings/slow";
export const CLAUDE_CHECK_PATH = "/settings/claude-check";
const SLOW_MS = 3000;

const NOTICES: Record<string, string> = {
  refreshed: "Everything was reloaded from the server.",
  tried: "Back from a page that took 3 seconds: the red light should have kept sweeping all along.",
  claude_ok: "Claude answered: the key and the model work.",
};

// Claude in La Fabrique: whether it is set up, who may use it, the quotas,
// and what it costs (the details for the super admin).
function claudeSection(viewer: Viewer, settings: ClaudeSettings, report: UsageReport, failure: string | null): string {
  const isSuperAdmin = viewer.role === "super_admin";
  const budget = settings.monthlyBudgetUsd * 1_000_000;
  const status = settings.configured
    ? `<span class="pill ok">Ready</span>`
    : `<span class="pill alert">Not set up</span> Add La Fabrique's own Anthropic API key as a secret of the Worker: <code>npx wrangler secret put ANTHROPIC_API_KEY</code> (see the setup guide). It is never shown here.`;
  const rows: [string, string][] = [
    ["Status", status],
    ["Model", `<span class="mono">${escapeHtml(settings.model)}</span>${knownPrice(settings.model) ? "" : ` <span class="pill warn">price unknown: its calls are counted, not their cost</span>`}`],
    ["Who may use it", "Product Engineers, tech leads and super admins, on a card: write and revise its spec."],
    ["Quotas", `${settings.dailyCalls} calls per person and day · ${formatUsd(budget)} a month for all of La Fabrique (<code>CLAUDE_DAILY_CALLS</code>, <code>CLAUDE_MONTHLY_BUDGET_USD</code>)`],
    ["This month", `${spendLine(report.month)} of ${formatUsd(budget)}`],
  ];
  if (canUseClaude(viewer.role)) rows.push(["You today", `${report.mineToday.calls} of ${settings.dailyCalls} calls`]);
  const table = (head: string, lines: string[]) =>
    lines.length ? `<table><thead><tr><th>${head}</th><th class="number">Calls</th><th class="number">Cost</th></tr></thead><tbody>${lines.join("")}</tbody></table>` : "";
  const row = (label: string, spend: { calls: number; micros: number }) =>
    `<tr><td>${label}</td><td class="mono number">${spend.calls}</td><td class="mono number">${formatUsd(spend.micros)}</td></tr>`;
  const details = isSuperAdmin
    ? `${
        report.byProject.length
          ? `<h3>This month, by project</h3>${table("Project", report.byProject.map((spend) => row(spend.repo ? `<span class="mono">${escapeHtml(spend.repo)}</span>` : `<span class="muted">La Fabrique</span>`, spend)))}`
          : ""
      }${report.byPerson.length ? `<h3>This month, by person</h3>${table("Person", report.byPerson.map((spend) => row(`<span class="mono">@${escapeHtml(spend.login)}</span>`, spend)))}` : ""}${
        report.byCard.length
          ? `<h3>Cards that cost the most</h3>${table(
              "Card",
              report.byCard.map((spend) =>
                row(`<a class="mono" href="${escapeHtml(cardUrl(spend.repo, spend.cardId))}">${cardRef(spend.cardId)}</a> ${escapeHtml(spend.title ?? "")} <span class="muted small">${escapeHtml(spend.repo)}</span>`, spend),
              ),
            )}`
          : ""
      }${report.recent.length ? `<h3>Last calls</h3>${callsTable(report.recent, true)}` : ""}
      ${
        settings.configured
          ? `<form method="post" action="${CLAUDE_CHECK_PATH}">${csrfField(viewer)}
              <button type="submit" class="button quiet claude">Check the key</button>
              <span class="muted small">One tiny call to the model, counted like the others.</span>
            </form>`
          : ""
      }`
    : "";
  return `<section id="claude">
      <h2>Claude</h2>
      ${failure ? `<p class="notice error" role="alert">${escapeHtml(failure)}</p>` : ""}
      <dl class="facts">${rows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join("")}</dl>
      ${details}
    </section>`;
}

// This device against what is online: the version, and the stylesheet and
// script the page actually runs (filled in by /fabrique.js).
export function settingsPage(
  viewer: Viewer,
  data: {
    version: string | null;
    commit: string;
    notice?: string | null;
    claude: { settings: ClaudeSettings; report: UsageReport; failure: string | null };
  },
): string {
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
      ${claudeSection(viewer, data.claude.settings, data.claude.report, data.claude.failure)}
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
