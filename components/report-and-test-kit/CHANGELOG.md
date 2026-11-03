# Changelog

- **1.9.0** — The Test panel hides the validated stories by default (shown on demand, the choice kept on the device); a turning ring shows while a tick or a validation is being saved.
- **1.8.0** — The Test panel stays open from one page of the app to the next, at the same story, with the feedback being written; a story's feature is a link to La Fabrique. Reporting and testing follow `.fabrique.json`: `signalement` by audience, production included, and the test environment (`recette`).
- **1.7.0** — A discreet launcher (Report a defect, Test); the Test panel floats, folds and moves; Fail writes a feedback on the story, which goes back to development.
- **1.6.0** — Relay protocol 2: with a relay that says `"relay": 2`, every call goes to `?path=…`; a generic relay, written once, needs no new route for later versions. Older relays keep working.
- **1.5.0** — Record what the tester does for a criterion; the relay passes `steps` on `POST ?to-test={story}/criteria`.
- **1.4.0** — Tick, validate and report from the Test panel; the relay asks for `stories:test`, answers `can_test` and `GET ?to-test=1`.
- **1.3.0** — The Test panel: the stories to test, read only.
- **1.2.0** — « What it is about »: a change of a release note can be chosen; the relay passes `change`.
- **1.1.0** — The versions on int and released, with their stories (`GET ?targets=1`).
- **1.0.0** — Report a defect on the part of the page that is wrong.
