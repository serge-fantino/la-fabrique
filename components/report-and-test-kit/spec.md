# Report a defect and test from the app — spec

## Context

Finding a defect while using the app, then going to GitHub to describe it, loses what matters: the page, the version, the part that is wrong, the errors. Testing a story means going back and forth between the app on int and La Fabrique's *To test*.

## Need

- From any page of the app, outside production, a person linked to La Fabrique reports a defect on the part of the page they pick, in two lines, with an optional screenshot; the issue is opened in their name.
- A tester sees the stories waiting on int, ticks their acceptance criteria, validates them, or reports a defect on one, without leaving the app.
- What the tester does for a criterion can be recorded and becomes a scenario.
- The browser never holds a token and never talks to La Fabrique: the project's server relays, and adds what only it knows.

## Acceptance criteria

- [ ] When a linked person picks a part of the page and sends two lines, an issue is opened in their name with the page, the version, the environment, the component, the screen, the browser and the recent errors.
- [ ] When the person chooses a version, a change or a story in « What it is about », the issue says so and is linked to that story.
- [ ] When the network is down, the report is kept on the device and sent when it is back.
- [ ] When a tester opens « Test », they see the stories waiting on int with their criteria; ticking one ticks it in the issue, in their name; Validate is refused until every criterion is ticked.
- [ ] When a tester records a criterion, the steps keep pages, buttons and field names, never a value typed, and are sent with the tick.
- [ ] When the environment is production, nothing is shown and nothing is sent.
- [ ] When the relay answers 401, the link is forgotten and the person is offered to link again.
