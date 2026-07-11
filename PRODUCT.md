# Product

## Register

product

## Users

Redline is for developers reviewing uncommitted work in a local Git workspace. The primary user moves file by file, leaves precise notes, and approves the exact bytes they have inspected before committing or handing the work to an agent.

Local coding agents are first-class consumers of the same review. They can read structured diffs, inspect side-aware comments, and export a review without scraping the interface.

## Product Purpose

Redline turns a working tree into a focused review queue. It indexes changed files, hides generated and binary noise by default, renders readable split or unified diffs, and keeps review state attached to exact file fingerprints.

Approval is independent of Git staging. An approved file remains approved while its content and mode are unchanged. If it changes, Redline returns it to the queue. A snapshot approves the complete visible change set at once.

Comments attach to explicit old or new line ranges. They remain available as history when their file fingerprint becomes outdated, but never masquerade as current feedback.

## Core Workflow

1. Open a local Git workspace.
2. Filter or search the changed-file queue.
3. Inspect a syntax-highlighted split or unified diff.
4. Search the diff, jump to a visible line, and select one or more line ranges.
5. Leave local comments, approve the current file, or approve the visible filtered queue.
6. Approve a complete snapshot when the change set is ready.
7. Export the review as structured JSON or Markdown for an agent or handoff.

The workspace refreshes from local filesystem events and falls back to polling when a watcher is unavailable.

Keyboard interaction is selectable per workspace. Normie is the familiar default. Vim adds an explicit diff mode for J/K line movement, visual-line selection, commenting, and approval without changing file navigation outside that mode. Its viewport follows the active line with a stable scroll margin; wheel, half-page, page, and boundary movement remain cursor-driven.

## Product Boundaries

Redline is not an editor, Git client, hosted collaboration service, or pull request tool. It does not modify source files, stage changes, create commits, contact a remote service, or maintain compatibility with abandoned pre-release data contracts.

## Brand Personality

Redline is precise, calm, and deliberate. Its voice is concise and quietly confident. The interface supports concentration through stable structure, disciplined copy, strong contrast, and restrained motion.

## Anti-references

Redline should not resemble a generic SaaS dashboard, a cheerful collaboration product, or a full IDE. Avoid decorative cards, workflow sprawl, playful language, and controls unrelated to inspection.

## Design Principles

1. **Review before action.** Every surface reinforces inspection and understanding.
2. **Local-first confidence.** Workspace data stays on the machine and mutations are loopback-only.
3. **File-level clarity.** The current path, change kind, review state, and diff mode remain obvious.
4. **Stable anchors.** Comments use side-aware source ranges and exact file fingerprints.
5. **Approval without ceremony.** Review state does not depend on staging or committing.
6. **Agent-readable by default.** The local API exposes the same review model as the interface.
7. **Purpose-built restraint.** Familiar controls disappear into the review task.

## Accessibility & Inclusion

WCAG AA is the baseline. Redline is keyboard-first, preserves visible focus, traps focus in narrow-screen overlays, respects reduced motion, and never communicates review state through color alone.
