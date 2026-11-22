# The release-notes tool

One release-notes file per project, versioned with its code (format: `docs/fabrique-json.md`, « Notes de version »), and one tool that writes it at the merges and at the releases: [`kit/release-notes.js`](/kit/release-notes.js). La Fabrique runs this very file in its own workflows; every project keeps a copy of it, as it is. There is no second version, in another language or adapted to a project: a project's own way goes into the options of the command and into its workflows, never into the tool.

## Why

Two pull requests written at the same time both take "the next version" on top of the file. Merged line by line, the second one always conflicts, on that file alone (seen on L'épicerie's sprint of 21 November 2026: four pull requests stopped). The tool does not merge the file line by line: at the merge, it rebuilds it, from the target branch's file, with the pull request's own entries on top, numbered or not depending on where they go.

## What a pull request writes

On top of the file, one entry per story, without a time:

```json
{
  "version": "next",
  "date": "2026-11-22",
  "titre": "Connect your assistant without a waiting list",
  "changements": ["Any validated account can connect its assistant."],
  "stories": [249],
  "liens": null
}
```

`"next"` says it: the number is not the pull request's to give. A project whose checks want a number on its branches (L'épicerie, which shows the top entry's number on its integration environment) writes the next number instead; it is a draft, renumbered at the merge.

## The merge

```sh
node release-notes.js merge <merge base file> <branch file> <target file> <out file> --mode next|number|release [--tz Europe/Paris]
```

The merge workflow (`workflows.fusionner`) writes the three versions of the file (`git show`), merges the target into the pull request's branch with `--no-commit`, runs the tool, adds the file, and refuses only if another file is in conflict. The pull request's own entries are those the merge base does not have. An older entry edited on the branch replaces the target's when the target left it as it was; edited on both sides, the target's text stays and the tool says so.

| Mode | Where the pull request goes | Its entries |
|---|---|---|
| `next` | the production branch of a project without integration branch (La Fabrique, RoadWise) | stay `next`, on top, without number nor time; the release at the close of the sprint numbers them (below). An entry numbered by hand is numbered and dated now. |
| `number` | an integration branch (L'épicerie) | numbered after the target's newest, dated today, without a time: on the integration environment, the version without a time is « not online yet » (`v1.N–int`); the go gives the time. |
| `release` | a production branch that releases at each merge | numbered after the target's newest, with the date and time now. |

A major version written by hand (`2.0` above the target's newest) is kept as written. The command prints the versions given.

## The release of a sprint (project without integration branch)

```sh
node release-notes.js publish <notes file> <version> <title> <stories, comma-separated> [titles.json] [--tz Europe/Paris]
```

Run by the release workflow (`workflows.publier`) when « Close the sprint » is pressed: the `next` entries that declare a story done become one entry (the version, the date and time, the title, every change, the stories done; the changes behind the scenes kept apart); an entry with a story not done goes out marked *Partial*; the other `next` entries stay on top.

A project with an integration branch makes its release at the go, in its own promotion workflow (L'épicerie: `scripts/dater_version.py`, the entries without a time become one version).

## Set it up in a project

1. Copy [`/kit/release-notes.js`](/kit/release-notes.js) into the repository, as it is, and declare where: `.fabrique.json` > `version.outil` (`scripts/fabrique/release-notes.js`). Its version is on its first line (`FabriqueReleaseNotes 1.0.0`); to update, copy the new file over it.
2. The merge workflow, declared in `workflows.fusionner`, runs it at each merge, as the examples do:
   - without integration branch: La Fabrique's own [merge.yml](/guide/exemples/merge.yml) (`--mode next`) and [release.yml](/guide/exemples/release.yml) (`publish`, declared in `workflows.publier`);
   - with an integration branch: L'épicerie's [fusionner.yml](/guide/exemples/fusionner.yml) (`--mode number`). It takes the tool from the integration branch (the pull request's branch may predate it).
3. The project's instructions for Claude (`CLAUDE.md`, the `claude` workflow's prompt) say what a pull request writes: an entry `next` on top (or a draft number), never a conflict to resolve by hand on that file.

The workflows run on the production branch (La Fabrique dispatches them there): a change of the merge workflow takes effect once it is in production.
