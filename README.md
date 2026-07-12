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

- `.git/redline/state.json` stores approvals and snapshot history.
- `.git/redline/review.sqlite` stores comments and workspace settings.

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
