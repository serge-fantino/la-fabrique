import type { Guide, Helpers, RefPage, UseCase } from "./help";

// The Product Engineer's guide (la-fabrique#265, la-fabrique#267): a user
// guide made of use cases, and a reference, page by page. The buttons are
// named as in the app; a change to a page named here changes this text in
// the same pull request.

const b = (label: string): string => `<strong class="help-key">${label}</strong>`;

const MOMENTS = [
  { id: "shape", title: "Shape a feature", summary: "From a need to a validated spec and its stories." },
  { id: "refine", title: "Refine in batch", summary: "Several features of the next release at once, up to GO / NO-GO." },
  { id: "plan", title: "Plan the next sprint", summary: "Choose what goes in, in which order, and start it." },
  { id: "run", title: "Run the sprint", summary: "Claude Code builds the stories one after another; you follow and unblock." },
  { id: "ship", title: "Test and ship", summary: "Check the work, send it back, triage defects, give the go." },
  { id: "board", title: "Keep the board in order", summary: "Arrange, filter, find, clean up, import." },
  { id: "claude", title: "Work from Claude", summary: "La Fabrique as a connector in claude.ai or Claude Code." },
];

const USE_CASES: UseCase[] = [
  // Shape a feature
  {
    slug: "new-feature",
    moment: "shape",
    title: "A new feature, from the idea to its stories",
    situation: "The shop's customers ask to be told when a recipe they saved changes.",
    steps: [
      { text: (h) => `On the ${h.app("/board", "Board")}, ${b("New card")}. Type <em>Feature</em>, a title, then the text: what happens today, for whom, and what they must be able to do. Not the technical solution.`, ref: "cards#create" },
      { text: `Annotate as you write: <code>{segment: Families}</code> for a value, <code>#12</code> for an issue, <code>@login</code> for a person, <code>[[Recipe]]</code> for a term.`, ref: "cards#annotations" },
      { text: `${b("Write the card")}, then, on its page, ${b("Write the spec with Claude")} and ${b("Ask Claude")}. The card goes <em>Shaping</em>. You can leave: Claude works in the background and the page updates live when you come back.`, ref: "claude-spec#background" },
      { text: `Under <em>Claude asks</em>, at most five questions, each with its field. Answer what you can, ${b("Send my answers to Claude")}; it never asks twice. When it has enough for you, ${b("Enough questions")}.`, ref: "claude-spec#questions" },
      { text: `The card is <em>To validate</em>. Read the spec section by section. Something is wrong: ${b("Ask Claude for a change")}, in your words. It holds: ${b("Validate the feature")}.`, ref: "claude-spec#change" },
      { text: `${b("Split into stories with Claude")}. Each proposed story has its acceptance criteria; Claude marks some <em>nice to have</em>.`, ref: "stories#split" },
      { text: `${b("Review and create the stories")}: in the editor, untick what you leave out, rewrite titles and sections, reorder the criteria (one per line, <em>When I…, I see…</em>), tick <em>Nice to have</em>. <em>What GitHub will receive</em> shows the result. ${b("Create the checked stories on GitHub")}.`, ref: "stories#editor" },
      { text: `When every story is ready, ${b("Validate the feature")}.`, ref: "refinement#validate" },
    ],
    after: "Each story is an issue on GitHub, signed with your login, with a permanent link to the exact version of the spec (“story 2 of 3”). The card lists them with their stage, and its status now follows them.",
    see: ["cards#statuses"],
  },
  {
    slug: "small-change",
    moment: "shape",
    title: "A small change that needs one story",
    situation: "A label is wrong on the order page.",
    steps: [
      { text: (h) => `${h.app("/board", "New card")}: the need in two lines and the criterion that proves it is fixed.`, ref: "cards#create" },
      { text: `${b("Write the spec with Claude")}; answer its question, or close with ${b("Enough questions")}. A spec this small can also be written by hand: ${b("Write the spec by hand")}.`, ref: "claude-spec#questions" },
      { text: `${b("Make one story on GitHub")}: check the title and <em>What GitHub will receive</em>, then ${b("Create the story on GitHub")}. One card, one story.`, ref: "stories#one-story" },
    ],
    after: (h) => `The story goes into the next release like any other. A defect seen by a user is not a card: it is reported from the app and triaged in ${h.app("/defects", "Defects")}.`,
  },
  {
    slug: "feature-changes",
    moment: "shape",
    title: "The feature changes after it was validated",
    situation: "The customers want the notification by e-mail too, and the stories already exist.",
    steps: [
      { text: `Edit the card's text, or ${b("Ask Claude for a change")} of the spec. The card goes back to <em>To validate</em>.`, ref: "cards#reopen" },
      { text: `${b("Review the stories with Claude")}: it reads each story against the new spec and says which hold, which to change (a comment on their issue, which you read before it is sent) and which are missing.`, ref: "stories#review" },
      { text: `${b("Review and apply")}: tick the comments to send (<em>To change</em>) and the new stories to create, then ${b("Send the checked to GitHub")}. Nothing to change: ${b("Confirm: the stories still fit")}.`, ref: "stories#review" },
      { text: `The card says <em>To validate again</em>: ${b("Validate the feature")}.`, ref: "refinement#validate" },
    ],
    after: "The card is Validated again and its status follows its stories. Every version of the spec stays readable on the card.",
    see: ["claude-spec#versions"],
  },
  {
    slug: "park-an-idea",
    moment: "shape",
    title: "Park an idea or a question",
    situation: "In a meeting someone suggests a loyalty programme. Not now, but not lost.",
    steps: [
      { text: (h) => `${h.app("/board", "New card")}, type <em>Idea</em> (or <em>Question</em> for something to decide). A few lines are enough.`, ref: "cards#kinds" },
      { text: `Leave it without a release: it stays in <em>Not set</em>, out of the next release.`, ref: "board#releases" },
      { text: `When it matures, ${b("Edit")} it into a <em>Feature</em> and shape it; when it is decided against, set its status to <em>Dropped</em>.`, ref: "cards#statuses" },
    ],
    after: "An idea is never assigned, estimated or put in a sprint by itself. Refinement lists the ideas and questions of the next release apart from its features.",
  },

  // Refine in batch
  {
    slug: "prepare-next-release",
    moment: "refine",
    title: "Specify and refine several features at once",
    situation: "Five features sit in Next release; you want their specs and stories this week.",
    steps: [
      { text: (h) => `Open ${h.app("/refinement", "Refinement")}. Each feature shows its next step: <em>Specify</em>, answer Claude, <em>Then refine</em>, <em>Validate</em>.`, ref: "refinement#page" },
      { text: `Tick the features at Specify or Refine. The card <em>Launch Claude on the ticked features</em> says the cost first: one call each, what you have left today, the month's budget. ${b("Launch the next step")}.`, ref: "refinement#batch" },
      { text: `Claude takes two jobs at a time; each card shows its place in line (“Waiting for its turn: 2nd in line”). ${b("Cancel")} a job that has not started yet.`, ref: "refinement#queue" },
      { text: `Answer Claude's questions in each card, without leaving the page, and ${b("Send my answers to Claude")}. Then tick again and launch the next step.`, ref: "claude-spec#questions" },
    ],
    after: "The features move from Specify to Refine, then Validate. The meters at the top count them; Claude's proposed stories open in each card's editor.",
    see: ["claude-costs#quota"],
  },
  {
    slug: "validate-in-batch",
    moment: "refine",
    title: "Validate a batch of features",
    situation: "Claude has refined the features; you review them one after the other before Friday.",
    steps: [
      { text: (h) => `On ${h.app("/refinement", "Refinement")}, the features whose next step is <em>Validate</em> are ready for you.`, ref: "refinement#page" },
      { text: `In each card, review Claude's proposed stories in the editor: keep, rewrite, mark <em>nice to have</em>, create them on GitHub.`, ref: "stories#editor" },
      { text: `A story says it is not ready: ${b("Mark ready")} on its line, or complete it on GitHub.`, ref: "stories#ready" },
      { text: `${b("Validate the feature")}, in the card. It shows <em>Ready for the sprint</em>.`, ref: "refinement#validate" },
      { text: `Watch the meters: Features, Specified, Refined, Ready, and the stories, needed and nice to have.`, ref: "refinement#progress" },
    ],
    after: "A feature validated and then changed must be validated again: Refinement shows it back at Validate.",
    see: ["cards#reopen"],
  },
  {
    slug: "share-preparation",
    moment: "refine",
    title: "Share the release's preparation with someone without access",
    situation: "The sponsor wants to read what the next release will contain.",
    steps: [
      { text: (h) => `On ${h.app("/refinement", "Refinement")}, Choose the <em>Level of detail</em> (1 · Features and their specs, 2 · Plus their stories, 3 · Plus their test cases) and the <em>Format</em> (HTML or PDF), then ${b("Download the preparation document")}.`, ref: "refinement#document" },
      { text: `Or, under <em>Share links</em>, ${b("Create a share link")}: the level, <em>Expires after</em> 1, 7 or 30 days. Copy it now: it is not shown again.`, ref: "refinement#share" },
      { text: `${b("Revoke")} it when it is no longer needed. The table lists each link's level, creation, expiry, openings and state.`, ref: "refinement#share" },
    ],
    after: "The reader sees the document as it was when the link was made, without an account. Each download and link is logged.",
  },
  {
    slug: "test-cases",
    moment: "refine",
    title: "Have Claude write the test cases",
    situation: "The testers want scenarios before the sprint starts.",
    steps: [
      { text: (h) => `On ${h.app("/refinement", "Refinement")}, ${b("Write test cases for all features")}; or, on one card's page, ${b("Write test cases with Claude")}. The card needs stories, made or proposed.`, ref: "refinement#test-cases" },
      { text: `Read and edit the Gherkin scenarios in the card's <em>Test cases</em>, then ${b("Save the test cases")}. They are kept in La Fabrique, not on GitHub.`, ref: "refinement#test-cases" },
    ],
    after: "The preparation document, at its third level, shows each story's test cases.",
  },

  // Plan the next sprint
  {
    slug: "choose-next-release",
    moment: "plan",
    title: "Choose what goes into the next sprint",
    situation: "Monday you start a new sprint; the board holds twenty cards.",
    steps: [
      { text: (h) => `On the ${h.app("/board", "Board")}, choose <em>Lane</em>: Release. Drag the cards you want into <em>Next release</em>, and those that can wait back to <em>Not set</em>.`, ref: "board#releases" },
      { text: (h) => `On ${h.app("/refinement", "Refinement")}, set each feature's priority (${b("Set")}): its stories take it, one level lower for the nice to have.`, ref: "cards#priority" },
      { text: `Put the features in the order you want them built: ↑ ↓, or drag the handle.`, ref: "refinement#order" },
      { text: (h) => `The ${h.app("/sprint", "Sprint")} page says what the next sprint will take: the unfinished cards of the last one and those of Next release.`, ref: "sprint#before" },
    ],
    after: "Next release is what Start the sprint takes. Nothing else enters by itself, except a card whose story is already being worked on.",
    see: ["sprint#joining"],
  },
  {
    slug: "go-no-go",
    moment: "plan",
    title: "Check GO / NO-GO and lift a NO-GO",
    situation: "Refinement says NO-GO for the next sprint.",
    steps: [
      { text: (h) => `On ${h.app("/refinement", "Refinement")}, read <em>What blocks</em> under NO-GO: one line per feature (no spec, questions waiting, spec complete and no stories, stories not ready, not validated, to validate again).`, ref: "refinement#progress" },
      { text: `Work each line: Specify, answer, refine, create the stories, ${b("Mark ready")}, ${b("Validate the feature")}.`, ref: "refinement#page" },
      { text: `A feature that cannot be ready in time: drag it out of Next release on the board.`, ref: "board#releases" },
    ],
    after: "GO says “Every feature of Next release is ready.” with a link to start the sprint.",
  },
  {
    slug: "start-sprint",
    moment: "plan",
    title: "Start the sprint",
    situation: "Refinement says GO.",
    steps: [
      { text: (h) => `On ${h.app("/sprint", "Sprint")}, the card <em>Start the next sprint</em>: the next minor or the next major version, or <em>Another</em>; a name if you want (“Menus and shopping”). ${b("Start the sprint")}.`, ref: "sprint#start" },
      { text: `The cards of Next release move into the sprint. Order the cards, and in each the stories: ↑ ↓, or drag.`, ref: "sprint#order" },
      { text: `A story says what it lacks (“Not ready: no priority”). Set its priority, ${b("Mark ready")}.`, ref: "sprint#ready" },
    ],
    after: "The sprint is named by its version (“Sprint 0.82”) on the board and its page. Change its version or name while it runs.",
  },

  // Run the sprint
  {
    slug: "run-sprint",
    moment: "run",
    title: "Run the sprint by itself",
    situation: "The stories are ready; you want Claude Code to build them in order.",
    steps: [
      { text: (h) => `On ${h.app("/sprint", "Sprint")}, the card <em>Running by itself</em> shows the plan: the cards in lanes (as many as Claude may run at once), their stories in order, nice to have last, where a card would stop, and what is not in the run.`, ref: "sprint#run" },
      { text: `${b("Run the sprint")}. For each card, La Fabrique launches Claude Code on a story, waits for its pull request, has it merged by the project's workflow, then takes the next one.`, ref: "sprint#run" },
      { text: `Follow it on the page: each card's step, Claude's runs, the open pull requests. The page reads itself again while something is in progress.`, ref: "sprint#follow" },
      { text: `${b("Pause")}, ${b("Resume")} or ${b("Stop")} at any time; a run in progress is never cancelled.`, ref: "sprint#run" },
    ],
    after: (h) => `Nothing is validated, released or closed by the run: the stories wait in ${h.app("/to-test", "To test")}.`,
    see: ["sprint#one-at-a-time"],
  },
  {
    slug: "card-stopped",
    moment: "run",
    title: "A card stopped during the run",
    situation: "The sprint says one card stopped: “Claude done: no pull request”.",
    steps: [
      { text: `Read why, and follow its link: a story not ready, Claude's run failed or without a pull request, a merge refused, a run or a merge too long.`, ref: "sprint#stops" },
      { text: `Claude left the story without a pull request: ${b("Relaunch Claude on #n")}. It starts again on its branch, if it has one.`, ref: "sprint#stops" },
      { text: `Fixed otherwise (the story made ready, the conflict solved): ${b("Resume this card")}.`, ref: "sprint#stops" },
    ],
    after: "The other cards went on meanwhile. Each stop and restart is in the log.",
  },
  {
    slug: "change-course",
    moment: "run",
    title: "Change course during the sprint",
    situation: "Priorities changed mid-sprint: the release becomes a major one, and one card must wait.",
    steps: [
      { text: (h) => `On ${h.app("/sprint", "Sprint")}, ${b("Change its version or name")}: the new version must be ahead of the latest release.`, ref: "sprint#start" },
      { text: `${b("Pause")} the run while you rearrange, or ${b("Stop")} it; a run of Claude already started finishes.`, ref: "sprint#run" },
      { text: `Reorder the cards and stories so the card that waits comes last; a story that can wait: <em>Nice to have</em> in its priority list.`, ref: "sprint#order" },
      { text: `${b("Resume")}, or ${b("Run it again")}: the plan is computed again.`, ref: "sprint#run" },
    ],
    after: "At the close, the unfinished cards go back to Next release; the next sprint takes them again.",
  },

  // Test and ship
  {
    slug: "check-story",
    moment: "ship",
    title: "Check a story and send it back",
    situation: "Claude's work on “Notify a changed recipe” is merged; you try it.",
    steps: [
      { text: (h) => `Open ${h.app("/to-test", "To test")}: each story with its card, its criteria, its feedback and the defects linked to it, and the link to the environment.`, ref: "testing#to-test" },
      { text: `Try it there. From the project's app, the round La Fabrique button opens ${b("Test")}: the same stories and criteria, in a panel floating above the app.`, ref: "testing#panel" },
      { text: `Tick each criterion that holds (in To test, or ${b("Record")} in the panel), then ${b("Validate")}: it waits until every criterion is ticked.`, ref: "testing#validate" },
      { text: `A criterion fails: in the app's panel, ${b("Fail")}, write what happened, add a screenshot if you want. From To test, ${b("Report a defect")} opens an issue instead.`, ref: "testing#feedback" },
    ],
    after: "A failed story goes back to In development with the rework label. A tech lead launches Rework with Claude; once its pull request is merged, the story is to test again.",
  },
  {
    slug: "triage-defect",
    moment: "ship",
    title: "Triage a defect reported from the app",
    situation: "A tester reports “the total is wrong after removing a product”.",
    steps: [
      { text: (h) => `Open ${h.app("/defects", "Defects")}: the defects, with their story and version when the reporter chose them, the others <em>to triage</em>.`, ref: "defects#tab" },
      { text: `Open the defect: the report, its screenshot, its comments. Under <em>Triage</em>, choose what <em>It is about</em> (a story, a version, a change), tick <em>Triaged: remove to triage</em>, ${b("Save")}.`, ref: "defects#triage" },
    ],
    after: "La Fabrique says it on GitHub, removes to triage, and To test shows the defect under its story.",
  },
  {
    slug: "give-the-go",
    moment: "ship",
    title: "Give the go",
    situation: "Every story of the sprint is validated.",
    steps: [
      { text: (h) => `Project with an integration branch: on ${h.app("/production", "Production")} (or the sprint page), <em>Give the go for 1.42</em>: each story Validated or not. Choose the next release, minor or major, then ${b("Give the go")}. A story not validated: say why in the field, ${b("Give the go anyway")}.`, ref: "releases#go" },
      { text: (h) => `Project without one: on ${h.app("/sprint", "Sprint")}, ${b("Close the sprint")}, ${b("Go on")}, check what the release takes and what stays, give its title, ${b("Close the sprint and release")}. The sprint says <em>Closing</em> until the release is out.`, ref: "sprint#close" },
    ],
    after: "The validated stories are closed with a word in the project's language; each card takes the version that shipped it. Your go is in the log.",
    see: ["releases#notes"],
  },

  // Keep the board in order
  {
    slug: "arrange-board",
    moment: "board",
    title: "Arrange the board for a review",
    situation: "Tomorrow's product review: where each domain stands, segment by segment.",
    steps: [
      { text: (h) => `On the ${h.app("/board", "Board")}, choose <em>Lane</em>: Status, then <em>Group by</em>: Segment. Each card sits at the crossing.`, ref: "board#dimensions" },
      { text: `Open <em>Filters</em>: Type Feature, Domain the one reviewed; ${b("Show")}. Tick <em>Hide empty lanes</em>.`, ref: "board#filters" },
      { text: `Drag a card to another segment to change its value; with the keyboard: Space on its handle, the arrow keys, Space again.`, ref: "board#moving" },
      { text: `Add a value the board does not have yet: ${b("New lane")} or ${b("New group")}.`, ref: "board#dimensions" },
    ],
    after: "The arrangement and the filters are kept on your device; each change of a card's value is logged.",
  },
  {
    slug: "find-a-card",
    moment: "board",
    title: "Find the card of a story",
    situation: "A pull request says “Refs #170”; which feature is it?",
    steps: [
      { text: (h) => `On the ${h.app("/board", "Board")}, open <em>Filters</em> and type <code>#170</code> (or <code>170</code>) in <em>Text</em>: the card of that story shows. <code>C12</code> finds card 12.`, ref: "board#filters" },
      { text: (h) => `Or from ${h.app("/to-test", "To test")} and the story's page: each story names its card, with a link.`, ref: "stories#stages" },
    ],
    after: "A story that names a card without being linked to it is proposed on the card, under Stories that name C5: Link to C5.",
    see: ["stories#linking"],
  },
  {
    slug: "clean-up",
    moment: "board",
    title: "Clean up the board",
    situation: "Old ideas and abandoned features clutter the board.",
    steps: [
      { text: `What was decided against: set its status to <em>Dropped</em>. What is done with: ${b("Archive")} on its page. Neither is erased: tick <em>Dropped and archived</em> in the filters to see them, ${b("Restore")} to bring one back.`, ref: "cards#archive" },
      { text: `Arranged by release, tick <em>Hide closed lanes</em>: the released versions fold away, the open releases stay.`, ref: "board#releases" },
    ],
    after: "Every version of every card is kept, and the log says who did what.",
  },
  {
    slug: "import-cards",
    moment: "board",
    title: "Import the cards of a workshop",
    situation: "A workshop produced thirty ideas in a spreadsheet.",
    steps: [
      { text: `Shape them as JSON in the export's format: ${b("Export every card (JSON)")} gives an example.`, ref: "board#import-export" },
      { text: (h) => `On the ${h.app("/board", "Board")}, ${b("Import cards (JSON)")}: the file, or the JSON pasted, then ${b("Import")}. Each card is created, a draft feature unless said otherwise; a title already on the board is skipped, never overwritten.`, ref: "board#import-export" },
    ],
    after: "Each imported card is logged. Export works the same way, for a copy of the project's cards.",
  },

  // Work from Claude
  {
    slug: "claude-connector",
    moment: "claude",
    title: "Work from claude.ai or Claude Code",
    situation: "You prefer to think aloud with Claude, then file the cards.",
    steps: [
      { text: `In Claude, add La Fabrique as a connector: the address is <code>/mcp</code> on La Fabrique. Sign in with GitHub and consent.`, ref: "claude-costs#mcp" },
      { text: `Ask: “Read the board of the shop and create a draft card for the recipe notifications.” Claude reads with your rights and writes in your name: cards, specs, stories, the sprint.`, ref: "claude-costs#mcp" },
      { text: (h) => `Disconnect it at any time in ${h.signedIn ? `<a href="/apps">Connected apps</a>` : "Connected apps"}.`, ref: "claude-costs#mcp" },
    ],
    after: "Every write is in the log with the tool used. The go is never given through Claude.",
  },
];

const REFERENCE: RefPage[] = [
  {
    slug: "getting-around",
    title: "Getting around",
    summary: "Your role, the perspective, the dashboard and a project's tabs.",
    sections: [
      {
        id: "role",
        title: "Your role",
        body: `<p>Roles are given by a super admin to a GitHub account. Each role has the rights of those below it: tester, Product Engineer, tech lead, super admin. The go is the exception: the Product Engineer and the super admin give it, not the tech lead.</p>
          <table class="help-table"><thead><tr><th>You can</th><th>Not you</th></tr></thead><tbody>
          <tr><td>Write, import and arrange cards; ask Claude for specs, stories, reviews and test cases; create stories, set priorities, mark them ready</td><td>Launch Claude Code on one story by hand, Rework with Claude, Update with Claude (tech lead)</td></tr>
          <tr><td>Start, version, run, pause and close the sprint; relaunch Claude on a story left without a pull request; ask for a review; merge a pull request into the production branch</td><td>Merge into another branch, Launch the next story, change a project's Setup (tech lead)</td></tr>
          <tr><td>Tick criteria, validate, send feedback, triage defects; give the go</td><td>Roles, projects, apps (super admin)</td></tr>
          </tbody></table>`,
      },
      {
        id: "perspective",
        title: "The perspective",
        body: `<p>Next to your login, the perspective chooses which tabs you see. A Product Engineer starts in <em>Product</em>: Overview, Board, Refinement, Sprint, Stories, Backlog, To test, Defects, Roadmap, Releases, Requests. <em>All</em> shows every tab. A perspective hides; it never forbids.</p>`,
      },
      {
        id: "tabs",
        title: "A project's tabs",
        body: (h: Helpers) => `<dl class="help-tabs">
            <dt>${h.app("", "Overview")}</dt><dd>Where the project is: production, test, development.</dd>
            <dt>${h.app("/board", "Board")}</dt><dd>The cards, arranged by two dimensions. ${h.ref("board", "Reference")}</dd>
            <dt>${h.app("/refinement", "Refinement")}</dt><dd>The features of Next release, up to GO / NO-GO. ${h.ref("refinement", "Reference")}</dd>
            <dt>${h.app("/sprint", "Sprint")}</dt><dd>The release in progress. ${h.ref("sprint", "Reference")}</dd>
            <dt>${h.app("/stories", "Stories")}</dt><dd>Every story on GitHub, grouped by card, with its stage.</dd>
            <dt>${h.app("/backlog", "Backlog")}</dt><dd>What is not started yet, by card, in priority order.</dd>
            <dt>${h.app("/to-test", "To test")}</dt><dd>The stories to check. ${h.ref("testing", "Reference")}</dd>
            <dt>${h.app("/defects", "Defects")}</dt><dd>The defects reported. ${h.ref("defects", "Reference")}</dd>
            <dt>${h.app("/roadmap", "Roadmap")}</dt><dd>The releases, past and coming.</dd>
            <dt>${h.app("/releases", "Releases")}</dt><dd>The release notes, version by version.</dd>
            <dt>${h.app("/requests", "Requests")}</dt><dd>Requests written with the project's form, outside the cards.</dd>
          </dl>`,
      },
      {
        id: "header",
        title: "The header",
        body: (h: Helpers) => `<p>The <strong>(i)</strong> next to La Fabrique's name gives the version running and leads to ${h.signedIn ? `<a href="/whats-new">What's new</a>` : "What's new"}. Under the bar, the project and the branch you read (the reference branch); a project with an integration branch can be read on it or on production. ${h.signedIn ? `<a href="/settings">Settings</a>` : "Settings"} holds your use of Claude and the version of the page.</p>`,
      },
    ],
  },
  {
    slug: "cards",
    title: "Cards",
    summary: "What a card is, its text, its kinds, its status, its priority, its versions.",
    sections: [
      {
        id: "kinds",
        title: "Kinds",
        body: `<p>A card's <em>Type</em> is <em>Feature</em> (something to build), <em>Idea</em> (not decided) or <em>Question</em> (to answer before deciding). It lives in La Fabrique, attached to its project. It is never assigned, estimated or put in a sprint by itself: what is development is a story on GitHub.</p>`,
      },
      {
        id: "create",
        title: "Writing a card",
        body: `<p>${b("New card")} on the board, or the <strong>+</strong> at the head of a lane to place it there:</p>
          <ul>
            <li><em>Title</em> (required, 200 characters), <em>Text</em> in Markdown (20,000), <em>Type</em>, <em>Status</em>.</li>
            <li><em>Epic</em>, <em>Domain</em>, <em>Segment</em>, <em>Release</em>: free text with suggestions.</li>
          </ul>
          <p>${b("Write the card")}. The priority is set afterwards, on its page. A draft not sent is kept on your device. Write the need, for whom, what is wrong today; not the solution. ${b("Edit")} changes it at any time; every version is kept.</p>`,
      },
      {
        id: "annotations",
        title: "Annotations",
        body: `<ul>
            <li><code>{segment: Families}</code>: a tag (segment, domain…).</li>
            <li><code>#12</code>: an issue of the project.</li>
            <li><code>@login</code>: a person.</li>
            <li><code>[[Recipe]]</code>: a term of the project's glossary.</li>
          </ul>`,
      },
      {
        id: "statuses",
        title: "Status",
        body: `<p>A card has one status. The first ones say where its spec is; once validated with stories, the status follows the stories and the sprint, with a count (<span class="mono">1/3 developed</span>).</p>
          <table class="help-table"><thead><tr><th>Status</th><th>Means</th><th>Moved by</th></tr></thead><tbody>
          <tr><td>Draft</td><td>Written, nothing decided.</td><td>You</td></tr>
          <tr><td>Shaping</td><td>Claude asks its questions, then writes the spec.</td><td>Asking Claude</td></tr>
          <tr><td>To validate</td><td>Claude knows enough, or you closed the questions.</td><td>Claude, or you</td></tr>
          <tr><td>Validated</td><td>The spec holds.</td><td>You</td></tr>
          <tr><td>Stories to prepare</td><td>Some stories miss what makes them ready.</td><td>By itself</td></tr>
          <tr><td>Ready for dev</td><td>Every story is ready.</td><td>By itself</td></tr>
          <tr><td>In sprint</td><td>The card is in the running sprint.</td><td>By itself</td></tr>
          <tr><td>In development</td><td>Claude Code works on a story; a pull request is open.</td><td>By itself</td></tr>
          <tr><td>To test</td><td>The work is merged; check it.</td><td>By itself</td></tr>
          <tr><td>In production</td><td>Released; the card names the versions that shipped it.</td><td>By itself</td></tr>
          <tr><td>Dropped</td><td>Decided against.</td><td>You</td></tr>
          </tbody></table>
          <p>The stage follows the mandatory stories: a nice to have never holds a card back. The count takes every story. What La Fabrique moves by itself only moves forward (asking Claude: Shaping; closing the questions: To validate; making or linking a story: Validated), never from Dropped nor on an archived card. On the card's page, the status list sets it by hand; on the board, a card cannot be dragged into a stage that follows its stories, nor into Validated. Every change is logged with its reason.</p>`,
      },
      {
        id: "reopen",
        title: "When a validated feature changes",
        body: `<p>A Validated card whose feature changes (its text, its spec, an older version taken back) goes back to <em>To validate</em>, out of the stages that follow its stories. It becomes Validated again once its stories are reviewed.</p>`,
      },
      {
        id: "priority",
        title: "Priority",
        body: `<p>The project's priorities (for example P1, P2, P3, or <em>No priority</em>) are set on the card's page and on Refinement (${b("Set")}). The card's stories take it on GitHub when they are created and when it changes; a nice to have story takes one level lower. In the sprint, each story has its own priority list, with <em>Nice to have</em>.</p>`,
      },
      {
        id: "archive",
        title: "Dropped and archived",
        body: `<p><em>Dropped</em> is a status: decided against. ${b("Archive")}, on the card's page, takes it off the board (“Archived: it no longer shows on the board.”); ${b("Restore")} brings it back. Both are hidden unless <em>Dropped and archived</em> is ticked in the filters. Nothing about a card is ever erased.</p>`,
      },
    ],
  },
  {
    slug: "board",
    title: "The board",
    summary: "Lanes and groups, releases, filters and search, moving cards, import and export.",
    sections: [
      {
        id: "dimensions",
        title: "Lane and Group by",
        body: `<p>The board arranges the cards by a first dimension, <em>Lane</em> (columns; <em>None (free order)</em> for none), then by a second, <em>Group by</em> (rows), to cross them. The dimensions: <em>Status</em> (the default), <em>Type</em>, <em>Epic</em>, <em>Domain</em>, <em>Segment</em>, <em>Release</em>. ${b("New lane")} or ${b("New group")} adds a value no card has yet (not for releases). The header counts the cards shown (“12 cards of 40”).</p>
          <p>Each card shows its number (C12), type, status, priority, “Claude working”, its cost with Claude, and the versions that shipped it.</p>`,
      },
      {
        id: "releases",
        title: "Releases",
        body: `<p>Arranged by release, the lanes are, from left to right: <em>Not set</em>, <em>Next release</em>, <em>Sprint</em> while one runs, then the project's releases, read from its release notes, newest first. A card in Next release is taken by the next Start the sprint.</p>
          <ul>
            <li>On a project with an integration branch, the release in progress is marked <em>On int</em>; during a sprint, it is said in the Sprint lane's header and has no lane of its own.</li>
            <li><em>Hide empty lanes</em>, called <em>Hide closed lanes</em> when arranged by release, folds the released versions and always keeps the open ones.</li>
            <li>Next release has a link to Refinement; Sprint shows its version and <em>In progress</em>.</li>
          </ul>`,
      },
      {
        id: "filters",
        title: "Filters and search",
        body: `<p><em>Filters</em> (the fold says how many are on): <em>Type</em>, <em>Status</em>, and each of Epic, Domain, Segment, Release (a value, or <em>Not set</em>); <em>Text</em>; <em>Dropped and archived</em>. ${b("Show")} applies them, <em>Clear the filters</em> removes them.</p>
          <p><em>Text</em> keeps the cards where every word is found in the title, the text, the number (<code>C12</code>), or one of its stories: <code>#170</code> or <code>170</code>.</p>`,
      },
      {
        id: "moving",
        title: "Moving cards",
        body: `<p>Drag a card by its handle (⠿) to another lane or group: it takes that value (a release, a status, a segment…), for everyone, and the move is logged. With the keyboard: Space or Enter on the handle picks it up, the arrow keys move it, Space drops it, Escape cancels.</p>
          <p>Refused: a stage that follows the stories (Stories to prepare… In production), and Validated on a card that follows its stories (“This status follows the card's stories on GitHub”).</p>
          <p>The arrangement and the filters are kept on your device, and come back when you open the tab.</p>`,
      },
      {
        id: "import-export",
        title: "Import and export",
        body: `<p>${b("Export every card (JSON)")}, at the foot of the board, gives the project's cards. ${b("Import cards (JSON)")} (Product Engineer and above) takes a file in the same format, or the JSON pasted: at most 200 cards and 2 MB. Each card is created, never overwritten; a title already on the board is skipped (“3 cards imported; 1 skipped, already on the board.”). A card without a type is a feature, without a status a draft; its spec and stories come along. Each imported card is logged.</p>`,
      },
    ],
  },
  {
    slug: "claude-spec",
    title: "Specs with Claude",
    summary: "How Claude asks, writes and changes a spec, in the background.",
    sections: [
      {
        id: "background",
        title: "In the background, live",
        body: `<p>On the card's page, each request opens a panel: ${b("Write the spec with Claude")}, ${b("Split into stories with Claude")}, ${b("Review the stories with Claude")}, ${b("Write test cases with Claude")}, ${b("Ask Claude for a change")}, each sent by ${b("Ask Claude")}.</p>
          <p>The request is recorded at once and queued: two jobs at a time for La Fabrique, one per card. Claude works in the background: leaving the page loses nothing, an open page updates live (“Waiting for its turn: 2nd in line”, <em>What Claude does</em>), and the board marks the card “Claude working”. When Anthropic is busy, the job tries again up to three times; if it cannot finish, ${b("Try again")}.</p>`,
      },
      {
        id: "questions",
        title: "Questions and answers",
        body: `<p>Claude frames the need first: under <em>Claude asks</em>, at most five questions, each with its field, and <em>Anything else?</em>. ${b("Send my answers to Claude")} (at least one answer), or ${b("Enough questions")} to close them. Your answers are kept with the spec (<em>Questions answered</em>) and never asked again. Claude stops when it knows enough and says so; from the third round, only blocking questions.</p>`,
      },
      {
        id: "change",
        title: "Asking for a change",
        body: `<p>${b("Ask Claude for a change")} rewrites the spec from your words (“Say what should change.”). ${b("Edit the spec by hand")} opens the sections to write yourself, ${b("Save the spec")}; if someone saved meanwhile, it is refused rather than overwritten. The spec is in the project's sections (context, need, criteria…), the same as its requests.</p>`,
      },
      {
        id: "versions",
        title: "Versions",
        body: `<p>Every version is kept. <em>History</em> lists them (“Version 3”); an older one opens with “Version 3 of 5, by @…”, ${b("Back to the current version")} and ${b("Restore this version")}, which makes it the newest. A story keeps the permanent link to the version it was made from.</p>`,
      },
      {
        id: "sent",
        title: "What is sent to Claude",
        body: `<p>The card's text and values, its spec, the titles of the other cards and of the open stories, the card's stories (title, stage, criteria) when Claude reviews them, and the project's <code>CLAUDE.md</code>. Nothing else.</p>`,
      },
    ],
  },
  {
    slug: "stories",
    title: "Stories",
    summary: "From a validated spec to issues on GitHub, and what a story says about itself.",
    sections: [
      {
        id: "split",
        title: "Split into stories",
        body: `<p>${b("Split into stories with Claude")} proposes stories that can each go to production alone, each with its acceptance criteria; Claude marks some <em>nice to have</em>. Nothing is created yet: ${b("Review and create the stories")} opens the editor.</p>`,
      },
      {
        id: "editor",
        title: "The stories editor",
        body: `<p>Each proposed story is a block:</p>
          <ul>
            <li><em>Create this story</em> (untick to leave it out) and <em>Nice to have</em> (its priority one level below the card's);</li>
            <li><em>Title</em>, then each of the project's sections in a field that grows with its text;</li>
            <li>the criteria one per line: ↑, ↓, <em>Remove</em>, <em>Add a criterion</em>;</li>
            <li><em>What GitHub will receive</em>, as it will read.</li>
          </ul>
          <p>${b("Save my edits")} keeps them for later; ${b("Discard the proposal")} drops it. ${b("Create the checked stories on GitHub")} creates them in your name; if GitHub fails part-way, what is done is said and the rest stays here.</p>`,
      },
      {
        id: "one-story",
        title: "One card, one story",
        body: `<p>${b("Make one story on GitHub")} turns the whole spec into a single story: a title, <em>What GitHub will receive</em>, ${b("Create the story on GitHub")}. Offered when the card has a spec, no stories, and every required section filled; otherwise it says which to fill. The story takes the card's priority.</p>`,
      },
      {
        id: "review",
        title: "Reviewing the stories",
        body: `<p>On a card that has stories, ${b("Review the stories with Claude")} reads them against the spec. ${b("Review and apply")} shows <em>The stories already made</em>, each <em>Still fits</em> or <em>To change</em> with the comment to post on its issue (edit it before it is sent, in your name), then the <em>New stories</em> missing. ${b("Send the checked to GitHub")}, or ${b("Confirm: the stories still fit")}. The review is logged.</p>`,
      },
      {
        id: "ready",
        title: "Ready",
        body: `<p>A story is ready when it meets the project's <em>Definition of Ready</em>. A story not ready says what it lacks: “no acceptance criteria”, “not in an epic nor a card”, “no priority”, “not labelled ready”. ${b("Mark ready")} puts the project's ready label on it; criteria are added on GitHub. Only a ready story is taken by Claude Code.</p>`,
      },
      {
        id: "stages",
        title: "A story's stage",
        body: `<p>Where a story is, read from GitHub: backlog, ready, in development (a branch or an open pull request), merged and <em>To validate</em>, on test, validated, in production. Each story has its page in the sprint: its steps, criteria, pull requests, Claude's runs and history.</p>`,
      },
      {
        id: "linking",
        title: "Linking a story to a card",
        body: `<p>A story made from a card is linked to it. An issue that names a card (“C5”) without being linked is proposed on the card (<em>Stories that name C5</em>) and in To test: ${b("Link to C5")}. Nothing is linked by itself.</p>`,
      },
    ],
  },
  {
    slug: "refinement",
    title: "Refinement",
    summary: "Preparing the next release: each feature's next step, Claude in batch, GO / NO-GO, the document.",
    sections: [
      {
        id: "page",
        title: "The page",
        body: `<p>Refinement shows the features of <em>Next release</em> as cards, in the board's order (dropped and archived left out), each with its next step:</p>
          <ul>
            <li><strong>Specify</strong>: no spec yet; Claude writes it.</li>
            <li><strong>Answer</strong>: Claude asks; the questions are in the card (“Answer (2)”).</li>
            <li><strong>Then refine</strong>: the spec is complete, no stories; Claude proposes them, and the stories editor opens in the card.</li>
            <li><strong>Validate</strong>: the stories are made; those not ready say so, with ${b("Mark ready")}.</li>
            <li><strong>Ready for the sprint</strong>: validated.</li>
          </ul>
          <p>While Claude works, the card says “Claude has it”. <em>Ideas and questions</em> lists the other cards of Next release.</p>`,
      },
      {
        id: "order",
        title: "Priorities and order",
        body: `<p>Each card has its list <em>Priority, for the card and its stories</em> and ${b("Set")}. Move a card with ↑ ↓ or its handle: the order is the board's, and the sprint's order of build.</p>`,
      },
      {
        id: "batch",
        title: "Claude on several features",
        body: `<p>A feature at Specify or Refine has a box. The card <em>Launch Claude on the ticked features</em> says the cost before: “3 ticked: one call each. You have 17 of today's 20 calls left; this month's budget is $4.10 of $50.” ${b("Launch the next step")}: Specify for those without a spec, Refine for the others; one job each. Beyond what you have left, nothing is launched.</p>`,
      },
      {
        id: "queue",
        title: "The queue",
        body: `<p>Claude takes two jobs at a time, the others wait their turn in the order launched, and each card shows its place in line. ${b("Cancel")} only a job that has not started: a running job is never cancelled. A job that failed offers ${b("Try again")}.</p>`,
      },
      {
        id: "progress",
        title: "Progress and GO / NO-GO",
        body: `<p>The meters at the top: <em>Features</em>, <em>Specified</em>, <em>Refined</em>, <em>Ready</em>, and the stories, needed and nice to have. Then the verdict for the next sprint:</p>
          <ul>
            <li><strong>GO</strong>: “Every feature of Next release is ready.”, with a link to start the sprint.</li>
            <li><strong>NO-GO</strong>: <em>What blocks</em>, a line per feature: no spec, questions waiting, spec complete and no stories, stories not ready, not validated, to validate again.</li>
            <li><strong>Sprint running</strong>: a link to the sprint.</li>
          </ul>`,
      },
      {
        id: "validate",
        title: "Validating a feature",
        body: `<p>${b("Validate the feature")} is the last step, for a feature, by a Product Engineer or above: offered once no question waits and every story is out of the backlog (ready). From Refinement or the card's page; otherwise “Waiting for a Product Engineer to validate it.” The card says <em>Not validated</em>, <em>Validated by @…</em> or <em>To validate again</em> when its text, spec or stories changed.</p>`,
      },
      {
        id: "test-cases",
        title: "Test cases",
        body: `<p>${b("Write test cases for all features")} (or ${b("Write test cases with Claude")} on one card, once it has stories) asks Claude for Gherkin scenarios for each story, from its criteria and the spec: one job per feature, counted in the quota. They are kept in La Fabrique, in the card's <em>Test cases</em>, editable (${b("Save the test cases")}).</p>`,
      },
      {
        id: "document",
        title: "The preparation document",
        body: `<p><em>Level of detail</em>: 1 · Features and their specs, 2 · Plus their stories, 3 · Plus their test cases. <em>Format</em>: HTML (one file) or PDF. ${b("Download the preparation document")}. It opens with the project, the version prepared, the latest released, the date and who made it, then the features in priority order and GO or NO-GO. Each download is logged.</p>`,
      },
      {
        id: "share",
        title: "Share links",
        body: `<p>${b("Create a share link")} (Product Engineer and above): the level, <em>Expires after</em> 1, 7 or 30 days (30 by default). “Copy it now: it is not shown again.” Anyone with it reads, without an account, the document as it was when the link was made; the page asks not to be indexed. The table: Level, Created, Expires, Openings (counted by date, never who), State (Active, Revoked, Expired), ${b("Revoke")}. Creating and revoking are logged.</p>`,
      },
    ],
  },
  {
    slug: "sprint",
    title: "The sprint",
    summary: "Planning the next sprint, starting it, its order, running it by itself, closing it.",
    sections: [
      {
        id: "before",
        title: "Before the sprint",
        body: `<p>Without a sprint, the page says “No sprint in progress” and what the next one takes: the unfinished cards of the last sprint (<em>Kept in the sprint</em>) and those placed in <em>Next release</em> on the board. On a project with an integration branch, what is on int is shown, read only.</p>`,
      },
      {
        id: "start",
        title: "Starting the sprint, its version",
        body: `<p>The card <em>Start the next sprint</em> (Product Engineer and above): the next minor or the next major version, or <em>Another</em> (1.0 included); <em>Name</em>, optional. ${b("Start the sprint")}. One sprint at a time; refused when Next release has no card. While it runs, <em>Change its version or name</em> and ${b("Save")}; a version not ahead of everything out or in progress is refused. Logged.</p>`,
      },
      {
        id: "order",
        title: "Order",
        body: `<p>Under <em>Features and stories</em>, the cards in the board's order, the stories of each in their order, nice to have last. ↑ ↓, or drag. Each move is logged. Each story has its priority list (with <em>Nice to have</em>, which sets it one level lower on GitHub).</p>`,
      },
      {
        id: "ready",
        title: "What a story lacks",
        body: `<p>A story not ready says what it lacks (“Not ready: no priority”), with ${b("Mark ready")} or <em>Add its criteria on GitHub</em>. Other lines: <em>Test it</em>, <em>Back in development</em>, “Waits for #12”, ${b("Relaunch Claude")} on a story in development without a pull request. “N stories left” does not count the nice to have.</p>`,
      },
      {
        id: "one-at-a-time",
        title: "One story at a time per card",
        body: `<p>While a story of a card is in progress (Claude on it, or its pull request open and not merged), the other stories of the card wait: “Waits for #12”.</p>`,
      },
      {
        id: "run",
        title: "Running the sprint by itself",
        body: `<p>The card <em>Running by itself</em> shows the plan first: the cards in <em>Lane 1…n</em> (as many as Claude may run at once), each card's stories in order, nice to have last, each marked <em>Claude, then merge</em>, <em>Merged already</em>, <em>Waits behind</em> or <em>The card stops here</em>; then what is <em>Not in the run</em> and why.</p>
          <p>${b("Run the sprint")} (Product Engineer, super admin; the project must declare its Claude and merge workflows). For each card, La Fabrique launches Claude Code on a story in the name of who ran it, waits for its run, has its pull request merged by the project's workflow, waits for the merge, then takes the next story. Cards run side by side, one merge at a time. ${b("Pause")}, ${b("Resume")}, ${b("Stop")} at any time; a run of Claude in progress is never cancelled. ${b("Run it again")} after a stop. Nothing is validated, released or closed by it.</p>`,
      },
      {
        id: "stops",
        title: "When a card stops",
        body: `<p>A card stops and says why, with a link; the others go on: a story not ready, Claude's run failed or ended without a pull request, a merge refused (a conflict: Claude updates the branch, then a new merge), two runs on one story without a pull request, a run of more than 70 minutes, a merge of more than 40, a run that does not start within 15. ${b("Resume this card")} once fixed; ${b("Relaunch Claude on #n")} when Claude left the story without a pull request (on its branch, if it has one).</p>`,
      },
      {
        id: "follow",
        title: "Following the work",
        body: `<p>The page has three parts: the sprint (where it is, the go, the close), <em>Implementation</em> (the run, Claude's runs, the next story) with <em>Pull requests open</em> (${b("Ask for a review")} to a tech lead, ${b("Merge")} into the production branch, “Merge refused” with why), and <em>Features and stories</em>. Each story has its page: steps, criteria, pull requests, Claude's runs, history, feedback. While something is in progress, the page reads itself again every minute, when you are not typing or dragging.</p>`,
      },
      {
        id: "joining",
        title: "Cards that join by themselves",
        body: `<p>During a sprint, a card with a story in development, to rework or to test joins the Sprint lane by itself, wherever it was; the sprint says it once and the card's history keeps the reason. On a project with an integration branch, when int carries what production does not have and no sprint runs, La Fabrique opens one itself.</p>`,
      },
      {
        id: "close",
        title: "Stopping and closing",
        body: `<p>${b("Close the sprint")}. Each finished card takes the version that shipped it; the unfinished ones go back to Next release, and the next sprint takes them again.</p>
          <ul>
            <li>With an integration branch: it closes at once; the go also closes it once production is promoted.</li>
            <li>Without one (Product Engineer, super admin), the close is the release: <em>Before closing the sprint</em> (${b("Go on")} or <em>Postpone the close</em>), then what <em>The release takes</em> and <em>What stays</em>, <em>Its title</em>, ${b("Close the sprint and release")}. The sprint says <em>Closing</em> and follows the release workflow (<em>Follow it on GitHub</em>); a failure says why and reopens the sprint.</li>
          </ul>`,
      },
    ],
  },
  {
    slug: "testing",
    title: "Testing and validating",
    summary: "To test, the test panel in the app, validation and feedback.",
    sections: [
      {
        id: "to-test",
        title: "To test",
        body: `<p>The stories to check on the test environment (int, or production for a project without one, “Stories to validate”), with the link to open it, grouped by epic. Each story: its card, its steps, its criteria, its feedback (“2 feedbacks from testing”) and the defects linked. The validated stories are folded (“N validated stories, hidden”). <em>Defects not linked to a story</em> lead to their triage.</p>`,
      },
      {
        id: "panel",
        title: "Testing from the app",
        body: `<p>In the project's app, a round La Fabrique button opens ${b("Report a defect")} and ${b("Test")}. The test panel floats above the app, from page to page: Previous and Next between the stories, each criterion with its box, Record and Fail.</p>`,
      },
      {
        id: "validate",
        title: "Criteria and validation",
        body: `<p>Each criterion is a button: tick the ones that hold (tester and above; ticked in the issue on GitHub, logged). ${b("Validate")} waits until every criterion is ticked (“Check every criterion to validate.”); who and when are kept in La Fabrique's log. A story sent back shows ${b("Validate again")} once reworked.</p>`,
      },
      {
        id: "feedback",
        title: "Feedback",
        body: `<p>In the app's test panel, ${b("Fail")} on a criterion: write what happened, with a screenshot if you want. It is a comment on the story in your name, citing the criterion; the criterion is unticked, the story takes the rework label and goes back to In development. Nothing restarts by itself: a tech lead launches Rework with Claude. In To test, ${b("Report a defect")} (title, what I did, what I saw, what I expected, ${b("Open the issue")}) opens a defect linked to the story instead.</p>`,
      },
    ],
  },
  {
    slug: "defects",
    title: "Defects",
    summary: "Defects reported from the apps and their triage.",
    sections: [
      {
        id: "tab",
        title: "The Defects tab",
        body: `<p>The issues labelled bug, filtered by <em>State</em> (Open, Closed, All) and <em>To triage only</em>: Defect, Story, Version, Reported. Each defect has its page: <em>It is about</em>, <em>The report</em> (with its screenshot), <em>Comments</em>, <em>History</em>, read on GitHub at each visit.</p>`,
      },
      {
        id: "triage",
        title: "Triage",
        body: `<p>Under <em>Triage</em> (tester and above): what <em>It is about</em> (a story, a version on int or shipped, a change of a release note; search them), <em>Triaged: remove to triage</em>, ${b("Save")}. La Fabrique comments on the story and the defect and logs it. The last link decides the story, in Defects as in To test.</p>`,
      },
    ],
  },
  {
    slug: "releases",
    title: "Releases and the go",
    summary: "Giving the go, release notes, what a card says once shipped.",
    sections: [
      {
        id: "go",
        title: "The go",
        body: `<p>Only a Product Engineer or a super admin gives it. On a project with an integration branch, on Production or the sprint page: <em>Give the go for 1.42</em> lists the stories, <em>Validated</em> or <em>Not validated</em>; <em>Next release after 1.42</em>, minor or major; ${b("Give the go")}. When stories are not validated, the go is blocked until you say why in the field, then ${b("Give the go anyway")}. The project's own workflow promotes; La Fabrique never holds a deployment key. On a project without an integration branch, the go is ${b("Close the sprint")}.</p>`,
      },
      {
        id: "after",
        title: "After the go",
        body: `<p>The stories validated before the go are closed, with a word in the project's language; a story shipped without validation stays open, To validate. Each card says the versions that shipped it, and whether it is complete or what is left.</p>`,
      },
      {
        id: "notes",
        title: "Release notes",
        body: `<p>Each project keeps its release notes in its repository; each entry names its stories. Roadmap and Releases read them; the board's release lanes too.</p>`,
      },
    ],
  },
  {
    slug: "claude-costs",
    title: "Claude: quota, cost, connector",
    summary: "What Claude costs, its limits, and La Fabrique as a connector in Claude.",
    sections: [
      {
        id: "quota",
        title: "Quota and budget",
        body: (h: Helpers) => `<p>Each call to Claude from La Fabrique counts against a daily quota per person and a monthly budget for La Fabrique. The cost is shown before a batch, on each card's page, and per project and person in ${h.signedIn ? `<a href="/settings#claude">Settings → Claude</a>` : "Settings → Claude"}. Who, when, which card, the model and the cost are kept; never the content.</p>`,
      },
      {
        id: "code",
        title: "Claude Code",
        body: `<p>Claude Code builds the stories: it is the project's own workflow, with the project's keys, launched by La Fabrique (from the sprint, or by a tech lead). It works on a branch and opens a pull request, never pushing to the production branch.</p>`,
      },
      {
        id: "mcp",
        title: "La Fabrique as a connector",
        body: (h: Helpers) => `<p>Add La Fabrique to claude.ai or Claude Code as a connector, at <code>/mcp</code>; sign in with GitHub and consent. Claude reads (projects, board, cards, sprint, stories) and writes (cards, specs, stories, links, the sprint) in your name, with your rights read again at each call. With a tech lead's rights, it also launches Claude Code on a story and merges; a story sent back by testing is then reworked with its feedbacks, as ${b("Rework with Claude")} does. Every write is logged with the tool. Never the go. Disconnect it in ${h.signedIn ? `<a href="/apps">Connected apps</a>` : "Connected apps"}.</p>`,
      },
    ],
  },
  {
    slug: "words",
    title: "Words",
    summary: "The vocabulary of La Fabrique.",
    sections: [
      {
        id: "glossary",
        title: "Glossary",
        body: `<dl class="help-words">
            <dt>Card</dt><dd>A feature, an idea or a question, before it is development.</dd>
            <dt>Spec</dt><dd>The card's functional description, in the project's sections, written with Claude. Versioned.</dd>
            <dt>Story</dt><dd>An issue on GitHub made from a card, with its acceptance criteria. What Claude Code builds.</dd>
            <dt>Epic</dt><dd>An issue that groups stories on GitHub.</dd>
            <dt>Nice to have</dt><dd>A story that never holds its card back and is built last.</dd>
            <dt>Definition of Ready</dt><dd>What a story needs before Claude Code takes it.</dd>
            <dt>Next release</dt><dd>The board's lane where the next sprint's cards wait.</dd>
            <dt>Refinement</dt><dd>Preparing the features of Next release, up to GO / NO-GO.</dd>
            <dt>Sprint</dt><dd>The release in progress, with its version.</dd>
            <dt>int</dt><dd>The integration environment, where the merged work is tested and waits for the go.</dd>
            <dt>Go</dt><dd>The decision to put a version in production.</dd>
            <dt>Perspective</dt><dd>Which tabs you see; it never changes what you may do.</dd>
          </dl>`,
      },
    ],
  },
];

export const PRODUCT_ENGINEER: Guide = {
  slug: "product-engineer",
  title: "Product Engineer",
  summary: "Write the need, shape it with Claude, refine the next release, plan and run the sprint, validate, give the go.",
  ready: true,
  heading: "From a need to the version in production",
  lede: "You own the what and the why. La Fabrique gives you a place to write it, Claude to sharpen it and turn it into stories, a sprint that builds them in your order, and the go.",
  intro: (h: Helpers) => `<section class="help-intro">
      <h2>Your week, in short</h2>
      <ol class="help-plain">
        <li><strong>Shape</strong> the features on the ${h.app("/board", "Board")}, with Claude.</li>
        <li><strong>Refine</strong> the next release in ${h.app("/refinement", "Refinement")}, in batch, until GO.</li>
        <li><strong>Plan and start</strong> the ${h.app("/sprint", "Sprint")}, then let it run.</li>
        <li><strong>Check</strong> the work in ${h.app("/to-test", "To test")}, send back what fails.</li>
        <li><strong>Give the go.</strong></li>
      </ol>
      <p class="muted small">New here? Start with ${h.ref("getting-around", "Getting around")}, then ${h.useCase("new-feature", "a new feature, from the idea to its stories")}.</p>
    </section>`,
  moments: MOMENTS,
  useCases: USE_CASES,
  reference: REFERENCE,
};
