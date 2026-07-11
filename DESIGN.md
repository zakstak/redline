---
name: Redline
description: A quiet, low-strain design system for deliberate local code review.
colors:
  midnight-canvas: "oklch(0.145 0.008 270)"
  graphite-paper: "oklch(0.175 0.009 270)"
  raised-graphite: "oklch(0.215 0.011 270)"
  graphite-hover: "oklch(0.235 0.013 270)"
  proof-ink: "oklch(0.91 0.006 270)"
  soft-ink: "oklch(0.76 0.008 270)"
  muted-ink: "oklch(0.63 0.01 270)"
  quiet-rule: "oklch(0.275 0.012 270)"
  strong-rule: "oklch(0.38 0.015 270)"
  red-pencil: "oklch(0.65 0.19 25)"
  bright-red-pencil: "oklch(0.74 0.15 25)"
  red-pencil-wash: "oklch(0.255 0.055 25)"
  approval-green: "oklch(0.71 0.12 154)"
  approval-wash: "oklch(0.235 0.04 154)"
  changed-violet: "oklch(0.73 0.12 300)"
  changed-wash: "oklch(0.25 0.05 300)"
  added-field: "oklch(0.19 0.022 151)"
  removed-field: "oklch(0.2 0.026 25)"
  on-red-pencil: "oklch(0.97 0.006 25)"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.55rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  ui:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "SFMono-Regular, Cascadia Code, Liberation Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.08em"
rounded:
  xs: "0.25rem"
  sm: "0.35rem"
  md: "0.42rem"
  lg: "0.5rem"
  pill: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
  2xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.red-pencil}"
    textColor: "{colors.on-red-pencil}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 0.85rem"
    height: "2.15rem"
  button-primary-hover:
    backgroundColor: "{colors.bright-red-pencil}"
    textColor: "{colors.on-red-pencil}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.graphite-paper}"
    textColor: "{colors.soft-ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 0.6rem"
    height: "1.75rem"
  input-compact:
    backgroundColor: "{colors.midnight-canvas}"
    textColor: "{colors.proof-ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 0.7rem"
    height: "2.25rem"
  status-current:
    backgroundColor: "{colors.approval-wash}"
    textColor: "{colors.approval-green}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.45rem"
  status-changed:
    backgroundColor: "{colors.changed-wash}"
    textColor: "{colors.changed-violet}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.45rem"
---

# Design System: Redline

## 1. Overview

**Creative North Star: "The Quiet Proof Desk"**

Redline feels like a dedicated proofing desk used by a developer during a long review session in a dim room. The dark theme is a deliberate low-eye-strain environment, not a stylistic shortcut. Cool graphite surfaces hold steady while restrained red-pencil marks identify the few moments that require action.

The system is precise, calm, and deliberate. Dense information is welcome when it supports inspection, but every region has one job and every state has an explicit label. The interface earns trust through stable rails, exact alignment, quiet borders, and controls that behave like familiar instruments.

It rejects the visual language of a generic SaaS dashboard, a cheerful collaboration product, and a full IDE. It also rejects decorative cards, workflow sprawl, playful language, and controls unrelated to inspection.

**Key Characteristics:**

- Dark graphite surfaces tuned for sustained low-light reading.
- One red-pencil accent reserved for selection, attention, and primary commitment.
- Compact, keyboard-first controls with visible focus and explicit state labels.
- Structural rails and dividers instead of floating card grids.
- Monospaced metadata for paths, counts, line numbers, and machine state.
- Responsive structure that turns rails into focus-managed overlays below their desktop thresholds.

**The Fixed Desk Rule.** The diff is the work surface. Navigation and review history support it without competing for visual priority.

**The Low-Strain Rule.** Large areas remain low-chroma and low-contrast. High chroma is rare, semantic, and never used as decoration.

## 2. Colors

The palette is a cool graphite field marked by a restrained red pencil, with softened green and violet reserved for review state.

### Primary

- **Red Pencil:** The sole action accent. Use it for the current review target, primary commitment, line selection, and small uppercase section labels.
- **Bright Red Pencil:** The hover and high-legibility companion to Red Pencil. It may clarify an active state but must not become a second accent.
- **Red Pencil Wash:** A low-chroma field for selected filters and supporting emphasis. It carries state without flooding the screen.

### Secondary

- **Approval Green:** Confirms that inspected bytes still hold. Use it for approved state, positive diff statistics, and live workspace status.
- **Changed Violet:** Identifies content that changed after approval. It is a warning to inspect, not an error color.

### Neutral

- **Midnight Canvas:** The deepest work surface behind diffs, inputs, and comment records.
- **Graphite Paper:** The primary rail, toolbar, and panel surface.
- **Raised Graphite:** The selected, nested, or slightly raised surface.
- **Graphite Hover:** The highest neutral interaction layer. Use only during hover or for small count capsules.
- **Proof Ink:** Primary text and high-confidence controls.
- **Soft Ink:** Default readable text for filenames, comments, and supporting labels.
- **Muted Ink:** Secondary metadata, placeholders, inactive controls, and timestamps.
- **Quiet Rule:** The default one-pixel divider.
- **Strong Rule:** A stronger one-pixel boundary for overlays, editable fields, and high-salience edges.
- **On Red Pencil:** Text and icons placed on the primary accent.

The syntax palette is deliberately muted. Keywords, types, functions, strings, numbers, constants, properties, tags, and operators may differ in hue, but their lightness remains close enough that no token dominates the code being reviewed.

### Named Rules

**The Red Pencil Rule.** Red Pencil occupies no more than ten percent of a screen. Its rarity is what makes it authoritative.

**The State Has a Name Rule.** Approval, changed, error, and warning states always include text or an icon. Color alone never carries meaning.

**The Quiet Code Rule.** Diff backgrounds carry additions and removals; syntax color remains subordinate to the change itself.

## 3. Typography

**Display Font:** Inter (with the native UI sans stack)
**Body Font:** Inter (with the native UI sans stack)
**Label/Mono Font:** SFMono-Regular (with Cascadia Code, Liberation Mono, and monospace fallbacks)

**Character:** A single compact sans keeps product controls familiar and unobtrusive. Monospace appears only where exact alignment, source identity, or machine-readable state matters.

### Hierarchy

- **Display** (700, 1.5rem, 1.2): Reserved for the settings-page thesis or a similarly rare page-level heading. Never use it inside the review workspace.
- **Headline** (700, 1.125rem, 1.2): Workspace and panel titles. Tight tracking gives short headings authority without adding size.
- **Title** (700, 1rem, 1.4): Section names and settings labels.
- **Body** (400, 1rem, 1.6): Sustained prose, comments, editable text, and status explanations. Keep the measure within 62 characters per line.
- **UI** (400 or 600, 0.875rem, 1.4): Buttons, filenames, search fields, and compact helper copy.
- **Label** (700, 0.75rem, 0.08em, uppercase): Eyebrows, rail labels, and compact machine state. Use the mono stack.
- **Code** (400, 1rem, 1.6): The diff surface. Disable decorative ligatures where exact characters matter.

### Named Rules

**The Evidence First Rule.** Source code is the largest sustained text on the review screen. Interface chrome never grows loud enough to challenge it.

**The Mono Means Exact Rule.** Use monospace for paths, counts, line numbers, fingerprints, shortcuts, timestamps, and state metadata. Do not use it as atmosphere.

## 4. Elevation

Redline is flat by default. Depth comes from adjacent graphite tones and one-pixel rules. A soft ambient shadow appears only when a rail becomes an overlay or when a floating selection toolbar must remain legible above code. Desktop rails remain structurally attached to the work surface.

### Shadow Vocabulary

- **Overlay Shadow** (`0 8px 24px oklch(0.08 0.008 270 / 0.34)`): Mobile and tablet drawers, the review overlay, and the floating line-selection toolbar.
- **Inset Selection Lift** (`0 1px 4px oklch(0.08 0.008 270 / 0.28)`): The active option inside segmented controls. This is a minute separation cue, never a card shadow.
- **Live Status Halo** (`0 0 0 0.16rem` with a 14% approval-green mix): The workspace watcher only.

### Named Rules

**The Flat Desk Rule.** Surfaces at rest are flat. If a stationary desktop region needs a shadow to separate it, its tonal layer or divider is wrong.

**The Overlay Earns Lift Rule.** Shadows are permitted only when a surface physically covers another surface or floats above the diff.

## 5. Components

Components are compact, restrained instruments. Their states are carried by tonal shifts, one-pixel rules, and direct copy rather than decorative flourish.

### Buttons

- **Shape:** Gently squared corners (0.35rem to 0.42rem), with a one-pixel boundary on secondary actions.
- **Primary:** Red Pencil with On Red Pencil content. Use the 0.875rem UI role at semibold weight. Standard settings actions are 2.15rem tall with 0.85rem horizontal padding; the snapshot action is a larger 3.5rem commitment row.
- **Hover / Focus:** Primary actions move to Bright Red Pencil. Secondary actions move to Raised Graphite or Graphite Hover. Every keyboard focus uses a two-pixel Bright Red Pencil outline with a two-pixel offset.
- **Active / Disabled:** Pressed buttons translate down one pixel. Disabled buttons reduce opacity, except settings actions, which use Raised Graphite and Muted Ink so the reason remains readable.
- **Secondary / Ghost:** Graphite Paper or transparent backgrounds, Soft or Muted Ink, and Quiet Rule borders. Approval hover uses Approval Green instead of Red Pencil.
- **Visible Queue Approval:** A compact two-line action fixed between the file list and rail footer. It names the eligible count, explains that it does not stage or commit, and moves from Raised Graphite to Approval Wash on hover.

### Chips

- **Style:** Status capsules use a pill radius, 0.25rem by 0.45rem padding, uppercase mono labels, and semantic washes.
- **State:** Approval Green on Approval Wash means current; Changed Violet on Changed Wash means changed. Neutral count capsules use Graphite Hover and Soft Ink.

### Cards / Containers

- **Corner Style:** Containers that represent records use gently curved corners (0.42rem). Structural rails and toolbars remain square and edge-bound.
- **Background:** Midnight Canvas for embedded records and editable areas; Graphite Paper for rails; Raised Graphite for selected or stale records.
- **Shadow Strategy:** No shadow at rest. Refer to the Overlay Earns Lift Rule.
- **Border:** One-pixel Quiet Rule by default, Strong Rule for stale state or editable emphasis.
- **Internal Padding:** Compact records use 0.65rem. Major rails use 1rem to 1.35rem.

### Inputs / Fields

- **Style:** Midnight Canvas, Quiet or Strong Rule border, compact curved corners (0.4rem to 0.42rem), Proof Ink, and Muted Ink placeholders.
- **Focus:** The shared two-pixel Bright Red Pencil outline is always visible. Inputs do not replace it with a decorative glow.
- **Error / Disabled:** Errors use Removed Field with Bright Red Pencil text. Disabled values preserve readable labels and never rely on opacity alone when context matters.

### Navigation

The file rail is a dense queue, not a collection of cards. File rows use transparent backgrounds at rest, Graphite Hover on hover, and Raised Graphite plus a Quiet Rule border when active. At 56rem the file rail becomes structural; below that threshold it is a focus-managed drawer. The approval ledger becomes a structural third rail at 80rem and an overlay below it.

Visible-file approval follows the queue filter and search. It appears only for two or more eligible files, excludes binary content, rejects stale batches atomically, and returns focus to the diff or drawer search after success. It never replaces the distinct snapshot action.

Touch input raises primary interactive targets to 2.75rem without enlarging the desktop typography. Reduced-motion preference collapses animation and transition durations to effectively zero.

Keyboard layout is an explicit workspace preference. Normie preserves familiar Tab, arrow, and pointer behavior. Vim exposes a clearly labeled diff-navigation mode with Normal and Visual line states; J/K only changes from file navigation to line navigation while that mode is visibly active. Vim mode hides browser scrollbars, marks the cursor row, and maintains a six-line scroll margin. Wheel, Ctrl+D/U, Page Up/Down, gg, and G move the cursor and viewport as one system.

On phones, file approval becomes a fixed, full-width thumb-zone action above the safe bottom edge. The file and review rails remain focus-managed overlays, while the source diff keeps horizontal panning for exact unwrapped code.

### Diff Surface

The diff is the signature component and the visual center of gravity. Code uses the mono stack at 1rem with a generous 1.6 line height. Added and removed fields use deep semantic backgrounds. Line selection uses Red Pencil, search uses a muted violet field, and line numbers remain secondary until interactive. Split and unified modes share the same state vocabulary.

### Comment Record

Comments are evidence records, not social cards. Current comments sit on Midnight Canvas with a Quiet Rule border. Stale comments move to Raised Graphite with Strong Rule and an explicit uppercase stale label. Destructive removal stays a quiet underlined text action.

### Guidance and Recovery

First-use guidance is an inline tinted band attached to the diff, never a tour or modal. It teaches the first valuable action, line-number selection, then respects dismissal in local storage. The file rail keeps a replayable keyboard-shortcut disclosure for later recognition.

Comment deletion removes the record optimistically but delays the server mutation for seven seconds. A raised undo notice receives focus and sits at the lower edge of the work surface, above the phone approval action when both are present.

## 6. Do's and Don'ts

### Do:

- **Do** preserve the dark theme and cool graphite surface ladder for low eye strain during sustained review.
- **Do** keep sustained prose and source code at 1rem, controls at 0.875rem, and secondary labels no smaller than 0.75rem.
- **Do** keep Red Pencil rare and attach it to selection, attention, or commitment.
- **Do** use one-pixel rules and tonal layers to define structure.
- **Do** keep the diff visually primary and source code more prominent than surrounding chrome.
- **Do** label every semantic state with copy or iconography in addition to color.
- **Do** preserve visible focus, keyboard navigation, focus-managed overlays, reduced-motion behavior, and 2.75rem coarse-pointer targets.
- **Do** use familiar controls with consistent hover, focus, active, disabled, loading, and error behavior.
- **Do** keep first-use teaching contextual, dismissible, and replayable through persistent shortcut help.
- **Do** provide inline undo for destructive review-history actions.

### Don't:

- **Don't** make Redline resemble a generic SaaS dashboard.
- **Don't** make it feel like a cheerful collaboration product or a full IDE.
- **Don't** add decorative cards, identical card grids, nested cards, or a card wrapper around every region.
- **Don't** introduce workflow sprawl, playful language, or controls unrelated to inspection.
- **Don't** use gradients, gradient text, glassmorphism, neon accents, or saturated inactive states.
- **Don't** use a colored side stripe thicker than one pixel on records, alerts, or list items.
- **Don't** invent display typography for product chrome or use monospace merely to look technical.
- **Don't** communicate review status through color alone.
- **Don't** add decorative motion. Motion exists only to explain state, loading, or overlay movement.
- **Don't** reach for a modal first. Prefer stable rails, inline disclosure, or the established focus-managed drawers.
