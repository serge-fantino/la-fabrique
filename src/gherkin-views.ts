import { featurePath, featureText, type Recorded } from "./gherkin";
import { csrfField, escapeHtml, type Viewer } from "./views";

// The Gherkin scenarios of the criteria a tester recorded, with Copy (the
// page's script) and Propose to the project (a pull request). Empty when
// nothing was recorded.
export function scenarioBlock(viewer: Viewer, base: string, story: number, title: string, recorded: Recorded[], canPropose: boolean, back: "story" | "to-test"): string {
  if (!recorded.length) return "";
  const text = featureText(title, recorded);
  const id = `feature-${story}-${back}`;
  return `<div class="scenario" id="${id}">
      <h4>Recorded as a scenario <span class="muted mono small">${escapeHtml(featurePath(story))}</span></h4>
      <pre class="gherkin" data-copy-source><code>${escapeHtml(text)}</code></pre>
      <div class="test-actions">
        <button type="button" class="button quiet" data-copy="#${id} [data-copy-source]">Copy</button>
        ${
          canPropose
            ? `<form method="post" action="${escapeHtml(base)}/to-test/feature" data-busy="Opening the pull request…">
          ${csrfField(viewer)}
          <input type="hidden" name="issue" value="${story}" />
          <input type="hidden" name="back" value="${back}" />
          <button type="submit" class="button">Propose to the project</button>
        </form>`
            : ""
        }
      </div>
    </div>`;
}
