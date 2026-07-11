# Redline

Redline is a local-first review workspace for uncommitted Git changes. It
provides a focused browser interface for reviewing files, leaving side-aware
comments, and approving exact file snapshots without staging or committing.

## Requirements

- Node.js 22.13 or newer
- Git

## Run locally

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:4322`. Vite serves the client on port 4322 and proxies
`/api` to the Fastify server on port 4323.

To run the production build:

```sh
npm run build
npm start
```

The production server listens on `127.0.0.1:4322` by default. Set `PORT` to
choose another loopback port and `REDLINE_WORKSPACE` to choose the initial Git
workspace.

## What it does

- Lists modified, added, deleted, renamed, type-changed, and untracked files.
- Hides generated and binary review noise unless requested.
- Renders syntax-highlighted split and unified diffs.
- Supports file search, diff search, line jumps, keyboard navigation, and
  adjustable context.
- Anchors comments to explicit old or new line ranges.
- Marks comments outdated when the underlying file fingerprint changes.
- Approves one file or a complete workspace snapshot without changing Git state.
- Atomically approves the current filtered file queue and rejects the whole
  batch if any fingerprint is stale.
- Defers whole changed files outside the active queue without approving them,
  preserves deferral across edits and explicit Git renames, and clears it after
  an observed clean state.
- Stores append-only review threads with pending, accepted, rejected, deferred,
  and explicitly reopened states.
- Offers a workspace-level keyboard layout: Normie keeps familiar browser
  controls, while Vim adds modal, cursor-driven diff navigation with visual-line
  selection and a six-line scroll margin.
- Applies accessible named themes and validated semantic color overrides
  immediately, with serialized autosave per workspace.
- Keeps interface and code fonts and sizes independently adjustable with offline
  stacks and atomic workspace-local persistence.
- Watches the worktree and Git metadata, with browser polling as a fallback.
- Exposes structured review data and Markdown exports to local agents.

## Local data

Review data lives under the active repository's Git metadata and never appears
in the worktree:

- `.git/redline/state.json` stores approvals, snapshot history, and canonical
  deferred paths.
- `.git/redline/review.sqlite` stores versioned comment threads, idempotency
  records, and workspace settings.

Both files are created with user-only permissions. Delete `.git/redline` to
reset Redline for a workspace.

This is a greenfield pre-release contract. State and API changes may reset local
review data instead of carrying migration code.

## Local API

The server accepts requests only through loopback hostnames. Cross-site
mutations are rejected, and state-changing requests must use JSON.

Useful discovery endpoints:

- `GET /api` lists the API surface and agent guidance.
- `GET /api/openapi.json` returns the OpenAPI 3.1 document.
- `GET /api/review` returns the complete structured review.
- `GET /api/diff?path=src/App.tsx` returns raw and parsed diff data.
- `POST /api/review/files` atomically approves explicit path and fingerprint
  pairs.
- `GET /api/comments/export?format=json|markdown` exports comments.
- `GET /api/events` streams workspace changes with server-sent events.
- `PUT /api/settings/theme` validates and saves a
  `{ workspaceRoot, preference }` theme update.
- `DELETE /api/settings/theme` deletes the active workspace theme using the same
  workspace identity precondition.
- `PUT /api/settings/typography` validates and atomically saves the complete
  workspace typography preference.

Theme preferences use a strict versioned preset-plus-overrides contract. Both
the browser and server evaluate the same WCAG contrast matrix. Invalid drafts
remain editable in the protected Settings surface but never apply or persist;
workspace reset returns to the Redline preset.

Create a comment with the fingerprint returned by `/api/diff` and one or more
side-aware ranges:

```json
{
  "path": "src/App.tsx",
  "fingerprint": "sha256-fingerprint",
  "anchors": [{ "side": "new", "startLine": 42, "endLine": 45 }],
  "body": "Handle the empty workspace before rendering this branch."
}
```

Send this object to `POST /api/comments`. A stale fingerprint returns HTTP 409
rather than attaching feedback to changed code.

## CLI

Build and run the non-interactive command surface:

```sh
npm run build
npm install --global .
redline review
redline diff src/App.tsx
redline comments add --input comment.json
redline comments export --format markdown
redline approve files --input files.json
redline approve workspace
```

For development without a global install, use `npm run dev:cli -- review`.
Remove the installed command with `npm uninstall --global redline`; repository
review data remains local under each worktree's Git metadata until explicitly
deleted.

The default `auto` mode validates and discovers a local server for up to exactly
2,000 ms. A verified match uses server mode. Any discovery transport, status,
content-type, body, decoding, or identity failure falls back to direct workspace
access. `--mode server` reports the same failures instead; `--mode direct`
performs no URL validation or HTTP request. Once an operation request starts,
Redline never falls back or replays it. The complete operation deadline is
30,000 ms.

Server URL precedence is `--server-url`, `REDLINE_SERVER_URL`, then
`http://127.0.0.1:4322`. Only credential-free `http` origins on `localhost`, the
exact IPv4 address `127.0.0.1`, or `[::1]` are accepted. Paths, queries,
fragments, redirects, remote hosts, wildcard hosts, and credentials are
rejected. Every operation carries the discovered process token and canonical Git
worktree identity, so a workspace switch or replacement process fails closed.

CLI outcomes:

| Exit | Meaning                                                    |
| ---: | ---------------------------------------------------------- |
|    0 | Success                                                    |
|    2 | Invocation or unsafe configuration                         |
|    3 | Git worktree resolution failure                            |
|    4 | Server, discovery, transport, response, or timeout failure |
|    5 | Stale fingerprint or domain conflict                       |
|    6 | Persistence or unexpected internal failure                 |

Operational success is JSON on stdout by default; diagnostics are structured
JSON on stderr. Markdown is accepted only by `comments export`. Help and version
do not inspect Git or contact a server.

### Agent review threads

Agent commands require a verified server and never fall back to direct mode:

```sh
redline agent review COMMENT_ID
redline agent review-all
redline agent respond COMMENT_ID --decision accepted --input reply.md
redline agent respond COMMENT_ID --decision rejected --input reason.md
redline agent respond COMMENT_ID --decision deferred --input blocker.md
redline agent reopen COMMENT_ID
```

Each decision validates the observed root version and thread revision.
Acceptance additionally validates the canonical workspace, path, and current
fingerprint or explicit absent-path state. Agent replies are immutable.
Rejection needs a reason; deferral needs a blocker. A comment decision does not
approve a file snapshot, stage files, commit, or change Git state.

### Deferral semantics

`POST /api/review/defer` removes one eligible changed path from active counts,
search, navigation, and approvals. Deferred files remain changed and directly
diffable in a separate UI area until restored. Explicit renames transfer the
marker before obsolete paths are cleared; delete/add pairs Git does not report
as renames remain independent. Tracked deletions can be deferred.
`POST /api/review/restore` is idempotent, and an observed clean status removes
the marker so a later change at that path returns to the active queue.

### GitHub pull request comments

Redline can import published, line-anchored review threads from one exact open
GitHub pull request. Install and authenticate the GitHub CLI first
(`gh auth login`). Discovery proves the base repository, head repository, branch
or detached commit, and a single eligible PR; it fails closed for conflicting
remotes, forks that do not match the configured push target, ambiguous PRs, or
uncertain ancestry.

Comment retrieval is manual through **Import GitHub comments** or **Refresh
GitHub comments**. Imported roots and replies are read-only, preserve each
poster, and never change local unresolved counts, approval eligibility,
snapshots, filters, or comment mutations. Redline remaps retained anchors after
worktree changes without polling GitHub. Unavailable or ambiguous anchors remain
visible in structured exports with a stable mapping reason.

Synchronization uses argument-array `gh api` calls only. Complete snapshots are
atomically replaced after pagination and bounded source acquisition succeeds;
failure or cancellation preserves the previous generation. Redline retains at
most eight snapshots, 25 MiB per PR, 64 MiB of unique source text, and 100 MiB
overall, evicting the oldest inactive identity deterministically. Delete
`.git/redline/github-imports.json` to reset imported data.

GitHub-flavored Markdown supports tables, task lists, strikethrough, autolinks,
and fenced code. Raw HTML and images in comments are disabled. Links are limited
to credential-free HTTP(S), `mailto`, and document fragments. Author avatars are
fetched only by Redline's bounded same-origin proxy from
`avatars.githubusercontent.com`; initials remain available when an avatar is
missing or invalid.

## Architecture

- `src/`: React interface, diff model, and syntax highlighting.
- `server/`: Fastify API, Git inspection, persistence, and file watching.
- `shared/`: TypeScript contracts shared by the browser and server.
- `tests/`: Vitest unit and integration tests.
- `playwright/`: End-to-end browser coverage.

The server shells out to Git with literal pathspecs, reads only the active
workspace, and stores no review data outside that repository's `.git` directory.

## Validation

```sh
npm run ci
npm run test:e2e
```

`npm run ci` runs lint, TypeScript checks, unit and integration tests, and both
production builds.
