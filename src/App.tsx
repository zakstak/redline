import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChangedFile,
  DiffResponse,
  FilesApprovalResponse,
  GitHubImportStatus,
  ReviewAuthor,
  ReviewComment,
  ReviewSettings,
  SnapshotResponse,
  WorkspaceResponse,
} from "../shared/review-contract.js";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR_ROLES,
  THEME_PRESETS,
  evaluateTheme,
  normalizeThemeColor,
  resolveTheme,
  themeCssVariables,
  type ThemeColorRole,
  type ThemePreference,
  type ThemePresetId,
} from "../shared/theme.js";
import {
  CODE_FONT_OPTIONS,
  DEFAULT_TYPOGRAPHY_PREFERENCE,
  TYPOGRAPHY_SIZE_CONTRACT,
  UI_FONT_OPTIONS,
  typographyCssVariables,
  type TypographyPreference,
} from "../shared/typography.js";
import {
  DiffView,
  type DiffSearchStatus,
  type DiffViewHandle,
  type SelectedLine,
} from "./DiffView.js";

type FileFilter = "needs-review" | "approved" | "all";
type DiffLayout = "adaptive" | "unified";
type WatchState = "connecting" | "live" | "polling";

interface ApiErrorPayload {
  message?: string;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface PendingCommentDeletion {
  comment: ReviewComment;
  workspaceRoot: string;
}

type ThemeSaveState = "saved" | "saving" | "failed" | "rejected";
type ThemeSaveOperation = {
  kind: "update" | "reset";
  preference?: ThemePreference;
  revision: number;
  workspaceRoot: string;
};
type TypographySaveState = "saved" | "saving" | "failed" | "rejected";
type TypographySaveOperation = {
  preference: TypographyPreference;
  revision: number;
  workspaceRoot: string;
  source: "font" | "size" | "reset";
};

function applyTheme(preference: ThemePreference) {
  for (const [property, value] of Object.entries(
    themeCssVariables(preference),
  )) {
    document.documentElement.style.setProperty(property, value);
  }
  document.documentElement.style.colorScheme =
    THEME_PRESETS[preference.preset].colorScheme;
}

function applyTypography(preference: TypographyPreference) {
  for (const [property, value] of Object.entries(
    typographyCssVariables(preference),
  ))
    document.documentElement.style.setProperty(property, value);
}

function reviewHintWasDismissed() {
  try {
    return window.localStorage.getItem("redline.review-hint-dismissed") === "1";
  } catch {
    return false;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => ({}))) as ApiErrorPayload;
    throw new ApiError(
      payload.message || `Local request failed with status ${response.status}.`,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function trapOverlayFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const container = event.currentTarget;
  const focusable = [
    ...container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hidden && element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    container.focus();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === container)
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      height={size}
      viewBox="0 0 20 20"
      width={size}
    >
      {children}
    </svg>
  );
}

function CheckIcon() {
  return (
    <Icon>
      <path d="m4 10.5 3.5 3.5L16 5.5" />
    </Icon>
  );
}

function RefreshIcon() {
  return (
    <Icon>
      <path d="M16.1 7A6.5 6.5 0 1 0 16 13M16.1 7V3.5M16.1 7h-3.5" />
    </Icon>
  );
}

function SearchIcon() {
  return (
    <Icon>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.3 12.3 4 4" />
    </Icon>
  );
}

function CommentIcon() {
  return (
    <Icon>
      <path d="M4 4.5h12v8H9l-4.5 3v-3H4z" />
    </Icon>
  );
}

function SnapshotIcon() {
  return (
    <Icon>
      <path d="M5 5.5h10v10H5z" />
      <path d="M7.5 3h10v10M8 10l1.5 1.5L12.5 8" />
    </Icon>
  );
}

function PreviousIcon() {
  return (
    <Icon size={14}>
      <path d="m5 12 5-5 5 5" />
    </Icon>
  );
}

function NextIcon() {
  return (
    <Icon size={14}>
      <path d="m5 8 5 5 5-5" />
    </Icon>
  );
}

function LockIcon() {
  return (
    <Icon>
      <rect x="4.5" y="8" width="11" height="8" rx="1.5" />
      <path d="M7 8V6a3 3 0 0 1 6 0v2" />
    </Icon>
  );
}

function ChevronIcon() {
  return (
    <Icon>
      <path d="m7 4 6 6-6 6" />
    </Icon>
  );
}

function LeftPanelIcon() {
  return (
    <Icon>
      <rect x="2.5" y="3" width="15" height="14" rx="1.5" />
      <path d="M7 3v14" />
    </Icon>
  );
}

function RightPanelIcon() {
  return (
    <Icon>
      <rect x="2.5" y="3" width="15" height="14" rx="1.5" />
      <path d="M13 3v14" />
    </Icon>
  );
}

function SettingsIcon() {
  return (
    <Icon>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" />
    </Icon>
  );
}

function BackIcon() {
  return (
    <Icon>
      <path d="m12.5 4-6 6 6 6" />
    </Icon>
  );
}

function DatabaseIcon() {
  return (
    <Icon>
      <ellipse cx="10" cy="5" rx="6" ry="2.5" />
      <path d="M4 5v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5" />
    </Icon>
  );
}

function formatRelativeTime(value?: string) {
  if (!value) return "Never";
  const difference = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(difference / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function statusLabel(file: ChangedFile) {
  if (file.reviewStatus === "approved") return "Approved";
  if (file.reviewStatus === "changed") return "Changed since approval";
  return "Needs review";
}

function changeLabel(file: ChangedFile) {
  const labels: Record<ChangedFile["kind"], string> = {
    added: "Added",
    deleted: "Deleted",
    modified: "Modified",
    renamed: "Renamed",
    untracked: "Untracked",
    "type-changed": "Type changed",
  };
  return labels[file.kind];
}

function selectionLabel(lines: SelectedLine[]) {
  if (lines.length === 1) return lines[0]?.label ?? "Selected line";
  const sides = new Set(lines.map((line) => line.side));
  if (sides.size > 1)
    return `${lines.length} lines selected across before and after`;
  const numbers = lines
    .map((line) => line.number)
    .filter((lineNumber): lineNumber is number => lineNumber !== null)
    .sort((first, second) => first - second);
  const first = numbers[0];
  const last = numbers.at(-1);
  return first !== undefined && last !== undefined
    ? first === last
      ? `${lines.length} versions of line ${first} selected`
      : `${lines.length} lines selected (${first} to ${last})`
    : `${lines.length} lines selected`;
}

function commentLineLabel(comment: ReviewComment) {
  return (
    comment.anchors
      .map((anchor) => {
        const side = anchor.side === "old" ? "Old" : "New";
        return anchor.startLine === anchor.endLine
          ? `${side} line ${anchor.startLine}`
          : `${side} lines ${anchor.startLine} to ${anchor.endLine}`;
      })
      .join(", ") || "Unavailable anchor"
  );
}

function safeMarkdownUrl(value: string) {
  if (/\p{Cc}/u.test(value)) return "";
  if (value.startsWith("#")) return value;
  try {
    decodeURIComponent(value);
    const url = new URL(value);
    if (url.protocol === "mailto:") return value;
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {
    return "";
  }
  return "";
}

function MarkdownBody({ value }: { value: string }) {
  return (
    <ReactMarkdown
      components={{
        img: () => null,
        a: ({ href, children }) =>
          href ? (
            <a href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
      }}
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeMarkdownUrl}
    >
      {value}
    </ReactMarkdown>
  );
}

function AuthorBadge({ author }: { author: ReviewAuthor }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="comment-author">
      <span aria-hidden="true" className="author-avatar">
        {author.avatarUrl && !failed ? (
          <img
            alt=""
            onError={() => setFailed(true)}
            src={`/api/github/avatar?url=${encodeURIComponent(author.avatarUrl)}`}
          />
        ) : (
          author.initials
        )}
      </span>
      <strong>{author.name}</strong>
    </span>
  );
}

function LoadingShell() {
  return (
    <div className="loading-shell" aria-label="Loading local workspace">
      <aside className="loading-files">
        <span className="skeleton skeleton-title" />
        {Array.from({ length: 7 }, (_, index) => (
          <span className="skeleton skeleton-file" key={index} />
        ))}
      </aside>
      <section className="loading-diff">
        <span className="skeleton skeleton-heading" />
        {Array.from({ length: 13 }, (_, index) => (
          <span
            className="skeleton skeleton-code"
            key={index}
            style={{ width: `${48 + ((index * 17) % 43)}%` }}
          />
        ))}
      </section>
      <aside className="loading-ledger">
        <span className="skeleton skeleton-title" />
      </aside>
    </div>
  );
}

const contextPresets = [0, 3, 5, 8, 12, 20];

function ThemeEditor({
  onChange,
  onResetWorkspace,
  onRetry,
  preference,
  saveState,
}: {
  onChange: (preference: ThemePreference) => void;
  onResetWorkspace: () => void;
  onRetry: () => void;
  preference: ThemePreference;
  saveState: ThemeSaveState;
}) {
  const [preset, setPreset] = useState<ThemePresetId>(preference.preset);
  const [draft, setDraft] = useState<Record<ThemeColorRole, string>>(() =>
    resolveTheme(preference),
  );
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [draftWarnings, setDraftWarnings] = useState<string[]>(() =>
    evaluateTheme(resolveTheme(preference)).warnings.map(
      (finding) =>
        `${finding.foreground} on ${finding.background}: ${finding.nonColorCue}`,
    ),
  );
  const invalidDraftRef = useRef(false);

  useEffect(() => {
    if (invalidDraftRef.current) return;
    setPreset(preference.preset);
    setDraft(resolveTheme(preference));
    setDraftErrors([]);
    setDraftWarnings(
      evaluateTheme(resolveTheme(preference)).warnings.map(
        (finding) =>
          `${finding.foreground} on ${finding.background}: ${finding.nonColorCue}`,
      ),
    );
  }, [preference]);

  const evaluateDraft = (
    nextPreset: ThemePresetId,
    nextDraft: Record<ThemeColorRole, string>,
  ) => {
    const normalized = {} as Record<ThemeColorRole, string>;
    const malformed: string[] = [];
    for (const role of THEME_COLOR_ROLES) {
      const value = normalizeThemeColor(nextDraft[role]);
      if (value) normalized[role] = value;
      else malformed.push(`${role}: use a 3, 4, 6, or 8 digit hex color.`);
    }
    if (malformed.length > 0) {
      invalidDraftRef.current = true;
      setDraftErrors(malformed);
      setDraftWarnings([]);
      return;
    }
    const evaluation = evaluateTheme(normalized);
    if (!evaluation.valid) {
      invalidDraftRef.current = true;
      setDraftErrors(
        evaluation.errors.map(
          (finding) =>
            `${finding.foreground} on ${finding.background}: ${finding.ratio.toFixed(2)}:1, ` +
            `${finding.criterion} requires ${finding.threshold}:1.`,
        ),
      );
      setDraftWarnings([]);
      return;
    }
    invalidDraftRef.current = false;
    const base = THEME_PRESETS[nextPreset].colors;
    const overrides = Object.fromEntries(
      THEME_COLOR_ROLES.flatMap((role) =>
        normalized[role] === base[role] ? [] : [[role, normalized[role]]],
      ),
    ) as ThemePreference["overrides"];
    setDraftErrors([]);
    setDraftWarnings(
      evaluation.warnings.map(
        (finding) =>
          `${finding.foreground} on ${finding.background}: ${finding.nonColorCue}`,
      ),
    );
    onChange({ version: 1, preset: nextPreset, overrides });
  };

  const choosePreset = (nextPreset: ThemePresetId) => {
    invalidDraftRef.current = false;
    const colors = { ...THEME_PRESETS[nextPreset].colors };
    setPreset(nextPreset);
    setDraft(colors);
    setDraftErrors([]);
    setDraftWarnings(
      evaluateTheme(colors).warnings.map(
        (finding) =>
          `${finding.foreground} on ${finding.background}: ${finding.nonColorCue}`,
      ),
    );
    onChange({ version: 1, preset: nextPreset, overrides: {} });
  };

  const updateRole = (role: ThemeColorRole, value: string) => {
    const next = { ...draft, [role]: value };
    setDraft(next);
    evaluateDraft(preset, next);
  };

  return (
    <section
      className="settings-section theme-settings-section"
      aria-labelledby="theme-heading"
    >
      <div className="settings-section-copy">
        <h2 id="theme-heading">Review theme</h2>
        <p>
          Choose a preset or tune semantic colors. Valid complete palettes apply
          immediately and autosave here.
        </p>
      </div>

      <div className="theme-editor">
        <div
          aria-label="Theme preset"
          className="theme-presets"
          role="radiogroup"
        >
          {Object.values(THEME_PRESETS).map((candidate) => (
            <button
              aria-checked={preset === candidate.id}
              key={candidate.id}
              onClick={() => choosePreset(candidate.id)}
              role="radio"
              type="button"
            >
              <span
                aria-hidden="true"
                className="theme-preset-swatch"
                style={{
                  background: candidate.colors.canvas,
                  borderColor: candidate.colors.accentStrong,
                }}
              />
              <span>
                <strong>{candidate.name}</strong>
                <small>{candidate.description}</small>
              </span>
              {preset === candidate.id ? (
                <span className="theme-selected-label">Selected</span>
              ) : null}
            </button>
          ))}
        </div>

        <details className="theme-customizer">
          <summary>Customize semantic colors</summary>
          <p>
            Draft values stay protected here until the complete palette passes
            required contrast.
          </p>
          <div className="theme-color-grid">
            {THEME_COLOR_ROLES.map((role) => {
              const normalized = normalizeThemeColor(draft[role]);
              return (
                <label key={role}>
                  <span>
                    {role.replace(
                      /[A-Z]/g,
                      (letter) => ` ${letter.toLowerCase()}`,
                    )}
                  </span>
                  <span className="theme-color-input">
                    <i
                      aria-hidden="true"
                      style={{ background: normalized ?? "transparent" }}
                    />
                    <input
                      aria-invalid={!normalized}
                      onChange={(event) => updateRole(role, event.target.value)}
                      spellCheck={false}
                      value={draft[role]}
                    />
                    <button
                      aria-label={`Reset ${role}`}
                      disabled={
                        draft[role] === THEME_PRESETS[preset].colors[role]
                      }
                      onClick={() =>
                        updateRole(role, THEME_PRESETS[preset].colors[role])
                      }
                      type="button"
                    >
                      Reset
                    </button>
                  </span>
                </label>
              );
            })}
          </div>
          <button
            className="theme-clear-button"
            onClick={() => choosePreset(preset)}
            type="button"
          >
            Clear custom colors
          </button>
        </details>

        {draftErrors.length > 0 ? (
          <div className="theme-validation" role="alert">
            <strong>Draft not applied</strong>
            <ul>
              {draftErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {draftErrors.length === 0 && draftWarnings.length > 0 ? (
          <details className="theme-warnings">
            <summary>
              {draftWarnings.length} non-essential contrast warning
              {draftWarnings.length === 1 ? "" : "s"}
            </summary>
            <ul>
              {draftWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="theme-save-row">
          <p aria-live="polite">
            {saveState === "saving"
              ? "Saving theme for this workspace."
              : saveState === "failed"
                ? "Theme is applied locally but not saved."
                : saveState === "rejected"
                  ? "Theme was rejected by the server and was not saved."
                  : "Theme saved for this workspace."}
          </p>
          {saveState === "failed" ? (
            <button onClick={onRetry} type="button">
              Retry save
            </button>
          ) : null}
          <button
            className="theme-workspace-reset"
            onClick={onResetWorkspace}
            type="button"
          >
            Reset workspace theme
          </button>
        </div>
      </div>
    </section>
  );
}

function TypographyEditor({
  onChange,
  onRetry,
  preference,
  saveState,
  unsaved,
}: {
  onChange: (
    preference: TypographyPreference,
    source: TypographySaveOperation["source"],
  ) => void;
  onRetry: () => void;
  preference: TypographyPreference;
  saveState: TypographySaveState;
  unsaved: boolean;
}) {
  const update = (
    patch: Partial<TypographyPreference>,
    source: TypographySaveOperation["source"],
  ) => onChange({ ...preference, ...patch }, source);
  const sizeControl = (
    key: "interfaceFontSize" | "codeFontSize",
    contract: (typeof TYPOGRAPHY_SIZE_CONTRACT)[keyof typeof TYPOGRAPHY_SIZE_CONTRACT],
  ) => (
    <div className="typography-size-control">
      <button
        aria-label={`Decrease ${contract.label.toLowerCase()} text size`}
        disabled={preference[key] <= contract.min}
        onClick={() =>
          update({ [key]: preference[key] - contract.step }, "size")
        }
        type="button"
      >
        −
      </button>
      <output aria-label={`${contract.label} text size`} aria-live="polite">
        <strong>{preference[key]} px</strong>
        <small>
          {contract.min}–{contract.max} px
        </small>
      </output>
      <button
        aria-label={`Increase ${contract.label.toLowerCase()} text size`}
        disabled={preference[key] >= contract.max}
        onClick={() =>
          update({ [key]: preference[key] + contract.step }, "size")
        }
        type="button"
      >
        +
      </button>
    </div>
  );

  return (
    <section
      className="settings-section typography-settings"
      aria-labelledby="typography-heading"
    >
      <div className="settings-section-copy">
        <h2 id="typography-heading">Typography</h2>
        <p>
          Choose offline font stacks and size interface and source text
          independently.
        </p>
      </div>
      <div className="typography-controls">
        <label>
          <span>Interface font</span>
          <small>Navigation, controls, comments, and prose</small>
          <select
            onChange={(event) =>
              update(
                {
                  uiFont: event.target.value as TypographyPreference["uiFont"],
                },
                "font",
              )
            }
            value={preference.uiFont}
          >
            {Object.entries(UI_FONT_OPTIONS).map(([id, option]) => (
              <option key={id} style={{ fontFamily: option.stack }} value={id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {sizeControl("interfaceFontSize", TYPOGRAPHY_SIZE_CONTRACT.interface)}
        <label>
          <span>Code font</span>
          <small>Diff source, line numbers, and code paths</small>
          <select
            onChange={(event) =>
              update(
                {
                  codeFont: event.target
                    .value as TypographyPreference["codeFont"],
                },
                "font",
              )
            }
            value={preference.codeFont}
          >
            {Object.entries(CODE_FONT_OPTIONS).map(([id, option]) => (
              <option key={id} style={{ fontFamily: option.stack }} value={id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {sizeControl("codeFontSize", TYPOGRAPHY_SIZE_CONTRACT.code)}
        <div className="typography-save-row">
          <p
            aria-live="polite"
            role={
              saveState === "failed" || saveState === "rejected"
                ? "alert"
                : "status"
            }
          >
            {saveState === "saving"
              ? "Saving typography…"
              : saveState === "failed"
                ? unsaved
                  ? "Typography is unsaved."
                  : "The font choice could not be saved and was restored."
                : saveState === "rejected"
                  ? "Typography was rejected by the server and was restored."
                  : "Typography saved for this workspace."}
          </p>
          {saveState === "failed" && unsaved ? (
            <button onClick={onRetry} type="button">
              Retry
            </button>
          ) : null}
          <button
            disabled={
              preference.uiFont === DEFAULT_TYPOGRAPHY_PREFERENCE.uiFont &&
              preference.codeFont === DEFAULT_TYPOGRAPHY_PREFERENCE.codeFont &&
              preference.interfaceFontSize ===
                DEFAULT_TYPOGRAPHY_PREFERENCE.interfaceFontSize &&
              preference.codeFontSize ===
                DEFAULT_TYPOGRAPHY_PREFERENCE.codeFontSize
            }
            onClick={() => onChange(DEFAULT_TYPOGRAPHY_PREFERENCE, "reset")}
            type="button"
          >
            Reset typography
          </button>
        </div>
      </div>
    </section>
  );
}

function SettingsPage({
  themeEditorRevision,
  includeNoise,
  onBack,
  onIncludeNoiseChange,
  onSaved,
  onThemeChange,
  onThemeReset,
  onThemeRetry,
  onTypographyChange,
  onTypographyRetry,
  settings,
  themeSaveState,
  typographySaveState,
  typographyUnsaved,
  workspace,
}: {
  themeEditorRevision: number;
  includeNoise: boolean;
  onBack: () => void;
  onIncludeNoiseChange: (include: boolean) => void;
  onSaved: (settings: ReviewSettings) => void;
  onThemeChange: (preference: ThemePreference) => void;
  onThemeReset: () => void;
  onThemeRetry: () => void;
  onTypographyChange: (
    preference: TypographyPreference,
    source: TypographySaveOperation["source"],
  ) => void;
  onTypographyRetry: () => void;
  settings: ReviewSettings;
  themeSaveState: ThemeSaveState;
  typographySaveState: TypographySaveState;
  typographyUnsaved: boolean;
  workspace: WorkspaceResponse;
}) {
  const [draft, setDraft] = useState(String(settings.diffContextLines));
  const [keyboardLayout, setKeyboardLayout] = useState<
    ReviewSettings["keyboardLayout"]
  >(settings.keyboardLayout);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error">(
    "idle",
  );
  const parsedDraft = Number(draft);
  const validDraft =
    /^\d+$/.test(draft) &&
    Number.isSafeInteger(parsedDraft) &&
    parsedDraft >= 0 &&
    parsedDraft <= 20;
  const dirty =
    validDraft &&
    (parsedDraft !== settings.diffContextLines ||
      keyboardLayout !== settings.keyboardLayout);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!validDraft) return;
    setSaving(true);
    setSaveState("idle");
    try {
      const updated = await api<ReviewSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ diffContextLines: parsedDraft, keyboardLayout }),
      });
      onSaved(updated);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="app-shell settings-shell" data-shell="settings">
      <header className="settings-header">
        <button
          autoFocus
          className="settings-back-button"
          onClick={onBack}
          type="button"
        >
          <BackIcon /> Review
        </button>
        <div>
          <span>Settings</span>
          <strong>{workspace.name}</strong>
        </div>
        <span className="settings-local-label">
          <LockIcon /> Local only
        </span>
      </header>

      <form className="settings-page" onSubmit={(event) => void save(event)}>
        <div className="settings-intro">
          <p className="eyebrow">Workspace preferences</p>
          <h1>Set how the review surface behaves.</h1>
          <p>
            These defaults apply to every file in this workspace. You can still
            expand individual hunks while reviewing.
          </p>
        </div>

        <section
          className="settings-section"
          aria-labelledby="context-lines-heading"
        >
          <div className="settings-section-copy">
            <h2 id="context-lines-heading">Unchanged lines around changes</h2>
            <p>Show this many lines before and after each changed block.</p>
          </div>

          <div className="context-setting-control">
            <div
              aria-label="Common context line values"
              className="context-presets"
              role="group"
            >
              {contextPresets.map((value) => (
                <button
                  aria-pressed={validDraft && parsedDraft === value}
                  key={value}
                  onClick={() => {
                    setDraft(String(value));
                    setSaveState("idle");
                  }}
                  type="button"
                >
                  {value}
                </button>
              ))}
            </div>
            <label className="context-number-field">
              <span>Custom</span>
              <input
                aria-describedby="context-lines-help"
                inputMode="numeric"
                max={20}
                min={0}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setSaveState("idle");
                }}
                type="number"
                value={draft}
              />
              <small>lines</small>
            </label>
            <p id="context-lines-help">
              0 shows only changed lines. Maximum 20.
            </p>
          </div>

          <div aria-label="Diff context preview" className="context-preview">
            <div>
              <span>{validDraft ? parsedDraft : "–"}</span> unchanged lines
            </div>
            <div>
              <span>+</span> changed line
            </div>
            <div>
              <span>{validDraft ? parsedDraft : "–"}</span> unchanged lines
            </div>
          </div>
        </section>

        <section
          className="settings-section settings-noise-section"
          aria-labelledby="review-noise-heading"
        >
          <div className="settings-section-copy">
            <h2 id="review-noise-heading">File-list visibility</h2>
            <p id="review-noise-help">
              Include generated and binary files in this browser tab. Redline
              resets this view when the page reloads.
            </p>
          </div>
          <label className="noise-toggle settings-noise-toggle">
            <input
              aria-describedby="review-noise-help"
              checked={includeNoise}
              onChange={(event) => onIncludeNoiseChange(event.target.checked)}
              type="checkbox"
            />
            <span className="toggle-track">
              <span />
            </span>
            <span>
              Show review noise
              <small>
                {includeNoise
                  ? "Generated and binary files are visible"
                  : `${workspace.hiddenNoiseCount} generated or binary hidden`}
              </small>
            </span>
          </label>
        </section>

        <section
          className="settings-section keyboard-layout-section"
          aria-labelledby="keyboard-layout-heading"
        >
          <div className="settings-section-copy">
            <h2 id="keyboard-layout-heading">Keyboard layout</h2>
            <p>
              Choose familiar browser controls or modal diff navigation. Pointer
              controls work in both layouts.
            </p>
          </div>

          <div
            aria-label="Keyboard layout"
            className="keyboard-layout-options"
            role="radiogroup"
          >
            <button
              aria-checked={keyboardLayout === "normie"}
              onClick={() => {
                setKeyboardLayout("normie");
                setSaveState("idle");
              }}
              role="radio"
              type="button"
            >
              <span>
                <strong>Normie</strong>
                <small>Tab, arrows, click</small>
              </span>
              <kbd>Default</kbd>
            </button>
            <button
              aria-checked={keyboardLayout === "vim"}
              onClick={() => {
                setKeyboardLayout("vim");
                setSaveState("idle");
              }}
              role="radio"
              type="button"
            >
              <span>
                <strong>Vim</strong>
                <small>J/K, V, C, Esc, A</small>
              </span>
              <kbd>Modal</kbd>
            </button>
          </div>
        </section>

        <ThemeEditor
          key={themeEditorRevision}
          onChange={onThemeChange}
          onResetWorkspace={onThemeReset}
          onRetry={onThemeRetry}
          preference={settings.theme}
          saveState={themeSaveState}
        />

        <TypographyEditor
          onChange={onTypographyChange}
          onRetry={onTypographyRetry}
          preference={settings.typography}
          saveState={typographySaveState}
          unsaved={typographyUnsaved}
        />

        <section className="settings-storage" aria-labelledby="storage-heading">
          <DatabaseIcon />
          <div>
            <h2 id="storage-heading">Review messages use SQLite</h2>
            <p>
              Comments and these preferences stay in{" "}
              <code>.git/redline/review.sqlite</code>. Repository contents never
              leave this machine.
            </p>
          </div>
        </section>

        <footer className="settings-actions">
          <p aria-live="polite">
            {!validDraft
              ? "Enter a whole number from 0 to 20."
              : saveState === "saved"
                ? "Saved for this workspace."
                : saveState === "error"
                  ? "Settings could not be saved."
                  : dirty
                    ? "Unsaved change."
                    : "Settings are current."}
          </p>
          <button disabled={!dirty || saving || !validDraft} type="submit">
            {saving ? "Saving" : "Save settings"}
          </button>
        </footer>
      </form>
    </main>
  );
}

export default function App() {
  const [activePage, setActivePage] = useState<"review" | "settings">("review");
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [includeNoise, setIncludeNoise] = useState(false);
  const [activePath, setActivePath] = useState("");
  const [filter, setFilter] = useState<FileFilter>("needs-review");
  const [fileSearch, setFileSearch] = useState("");
  const [diffSearch, setDiffSearch] = useState("");
  const [diffSearchStatus, setDiffSearchStatus] = useState<DiffSearchStatus>({
    current: 0,
    total: 0,
  });
  const [lineJumpOpen, setLineJumpOpen] = useState(false);
  const [lineJumpValue, setLineJumpValue] = useState("");
  const [lineJumpError, setLineJumpError] = useState("");
  const [layout, setLayout] = useState<DiffLayout>("adaptive");
  const [vimDiffMode, setVimDiffMode] = useState(false);
  const [vimVisualMode, setVimVisualMode] = useState(false);
  const [filePanelOpen, setFilePanelOpen] = useState(
    () => !window.matchMedia("(max-width: 55.99rem)").matches,
  );
  const filePanelOverlay = useMediaQuery("(max-width: 55.99rem)");
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const reviewPanelOverlay = useMediaQuery("(max-width: 79.99rem)");
  const [pendingReviewFocus, setPendingReviewFocus] = useState<
    "panel" | "composer" | null
  >(null);
  const [pendingFileSearch, setPendingFileSearch] = useState(false);
  const [settings, setSettings] = useState<ReviewSettings>({
    version: 1,
    diffContextLines: 3,
    keyboardLayout: "normie",
    theme: DEFAULT_THEME_PREFERENCE,
    typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [themeSaveState, setThemeSaveState] = useState<ThemeSaveState>("saved");
  const [themeUnsaved, setThemeUnsaved] = useState(false);
  const [themeEditorRevision, setThemeEditorRevision] = useState(0);
  const [typographySaveState, setTypographySaveState] =
    useState<TypographySaveState>("saved");
  const [typographyUnsaved, setTypographyUnsaved] = useState(false);
  const [contextLines, setContextLines] = useState(settings.diffContextLines);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffWorkspaceRoot, setDiffWorkspaceRoot] = useState("");
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [draftInvalidationNotice, setDraftInvalidationNotice] = useState("");
  const [approving, setApproving] = useState<"file" | "snapshot" | "">("");
  const [approvingVisibleCount, setApprovingVisibleCount] = useState(0);
  const [visibleApprovalMessage, setVisibleApprovalMessage] = useState("");
  const [visibleApprovalError, setVisibleApprovalError] = useState("");
  const [storedSelectedLines, setStoredSelectedLines] = useState<
    SelectedLine[]
  >([]);
  const [selectionScope, setSelectionScope] = useState<{
    path: string;
    fingerprint: string;
  } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [savingComment, setSavingComment] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [pendingCommentDeletion, setPendingCommentDeletion] =
    useState<PendingCommentDeletion | null>(null);
  const [reviewHintVisible, setReviewHintVisible] = useState(
    () => !reviewHintWasDismissed(),
  );
  const [pathInput, setPathInput] = useState("");
  const [workspacePathOpen, setWorkspacePathOpen] = useState(false);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [watchState, setWatchState] = useState<WatchState>("connecting");
  const [githubStatus, setGithubStatus] = useState<GitHubImportStatus | null>(
    null,
  );
  const [githubRefreshing, setGithubRefreshing] = useState(false);
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const settingsNavRef = useRef<HTMLButtonElement>(null);
  const filePanelRef = useRef<HTMLElement>(null);
  const filePanelToggleRef = useRef<HTMLButtonElement>(null);
  const filePanelReturnFocusRef = useRef<HTMLElement | null>(null);
  const diffSearchRef = useRef<HTMLInputElement>(null);
  const lineJumpRef = useRef<HTMLInputElement>(null);
  const diffViewRef = useRef<DiffViewHandle>(null);
  const focusDiffAfterLoadRef = useRef(false);
  const previousActiveFileRef = useRef<{
    path: string;
    fingerprint: string;
  } | null>(null);
  const draftStateRef = useRef({ hasDraft: false });
  const diffRequestRef = useRef(0);
  const workspaceRequestRef = useRef(0);
  const settingsRequestRef = useRef(0);
  const includeNoiseRef = useRef(includeNoise);
  const workspaceOpenRef = useRef(false);
  const workspaceEpochRef = useRef(0);
  const reviewPanelRef = useRef<HTMLElement>(null);
  const reviewToggleRef = useRef<HTMLButtonElement>(null);
  const approveFileButtonRef = useRef<HTMLButtonElement>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCommentDeletionRef = useRef<PendingCommentDeletion | null>(null);
  const commentDeletionTimerRef = useRef<number | null>(null);
  const visibleApprovalMessageTimerRef = useRef<number | null>(null);
  const vimGStartedAtRef = useRef(0);
  const activeWorkspaceRootRef = useRef("");
  const themeQueueRef = useRef<ThemeSaveOperation[]>([]);
  const themeMutationInFlightRef = useRef(false);
  const latestThemeIntentRef = useRef(0);
  const persistedThemeRef = useRef<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const themeDebounceRef = useRef<number | null>(null);
  const flushThemeQueueRef = useRef<() => void>(() => undefined);
  const typographyQueueRef = useRef<TypographySaveOperation | null>(null);
  const typographyMutationInFlightRef = useRef(false);
  const typographyPausedRef = useRef(false);
  const latestTypographyIntentRef = useRef(0);
  const confirmedTypographyRef = useRef(DEFAULT_TYPOGRAPHY_PREFERENCE);
  const desiredTypographyRef = useRef(DEFAULT_TYPOGRAPHY_PREFERENCE);
  const flushTypographyQueueRef = useRef<() => void>(() => undefined);
  activeWorkspaceRootRef.current = workspace?.root ?? "";
  includeNoiseRef.current = includeNoise;
  const activeWorkspaceIdentityRef = useRef("");
  activeWorkspaceIdentityRef.current = workspace
    ? `${workspace.root}\0${workspace.branch}\0${workspace.head}`
    : "";

  const loadWorkspace = useCallback(
    async (silent = false, includeNoiseOverride?: boolean) => {
      if (workspaceOpenRef.current) return null;
      const requestId = ++workspaceRequestRef.current;
      if (silent) setRefreshing(true);
      else setLoadingWorkspace(true);
      try {
        const nextWorkspace = await api<WorkspaceResponse>(
          `/api/workspace?includeNoise=${includeNoiseOverride ?? includeNoiseRef.current}`,
        );
        if (
          requestId !== workspaceRequestRef.current ||
          workspaceOpenRef.current
        )
          return null;
        setWorkspace(nextWorkspace);
        setPathInput(nextWorkspace.root);
        setWorkspaceError("");
        setActivePath((current) => {
          if (
            [...nextWorkspace.files, ...nextWorkspace.deferredFiles].some(
              (file) => file.path === current,
            )
          )
            return current;
          return (
            nextWorkspace.files.find((file) => file.reviewStatus !== "approved")
              ?.path ??
            nextWorkspace.files[0]?.path ??
            ""
          );
        });
        return nextWorkspace;
      } catch (error) {
        if (
          requestId !== workspaceRequestRef.current ||
          workspaceOpenRef.current
        )
          return null;
        setWorkspaceError(
          error instanceof Error
            ? error.message
            : "The local workspace could not be loaded.",
        );
        return null;
      } finally {
        if (
          requestId === workspaceRequestRef.current &&
          !workspaceOpenRef.current
        ) {
          setLoadingWorkspace(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  const loadSettings = useCallback(async () => {
    const requestId = ++settingsRequestRef.current;
    try {
      const nextSettings = await api<ReviewSettings>("/api/settings");
      if (requestId !== settingsRequestRef.current) return null;
      const themeSavePending =
        themeDebounceRef.current !== null ||
        themeMutationInFlightRef.current ||
        themeQueueRef.current.length > 0;
      if (!themeSavePending) applyTheme(nextSettings.theme);
      if (!themeSavePending) persistedThemeRef.current = nextSettings.theme;
      setSettings((current) => ({
        ...nextSettings,
        theme: themeSavePending ? current.theme : nextSettings.theme,
      }));
      setContextLines(nextSettings.diffContextLines);
      setSettingsLoaded(true);
      if (!themeSavePending) {
        setThemeSaveState("saved");
        setThemeUnsaved(false);
      }
      applyTypography(nextSettings.typography);
      confirmedTypographyRef.current = nextSettings.typography;
      desiredTypographyRef.current = nextSettings.typography;
      typographyQueueRef.current = null;
      typographyPausedRef.current = false;
      setTypographySaveState("saved");
      setTypographyUnsaved(false);
      return nextSettings;
    } catch (error) {
      if (requestId !== settingsRequestRef.current) return null;
      persistedThemeRef.current = DEFAULT_THEME_PREFERENCE;
      applyTheme(DEFAULT_THEME_PREFERENCE);
      applyTypography(DEFAULT_TYPOGRAPHY_PREFERENCE);
      confirmedTypographyRef.current = DEFAULT_TYPOGRAPHY_PREFERENCE;
      desiredTypographyRef.current = DEFAULT_TYPOGRAPHY_PREFERENCE;
      typographyQueueRef.current = null;
      typographyPausedRef.current = false;
      setSettings((current) => ({
        ...current,
        theme: DEFAULT_THEME_PREFERENCE,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCE,
      }));
      setSettingsLoaded(true);
      setActionError(
        error instanceof Error
          ? error.message
          : "Review settings could not be loaded.",
      );
      return null;
    }
  }, []);

  const flushThemeQueue = useCallback(async () => {
    if (themeMutationInFlightRef.current) return;
    const operation = themeQueueRef.current.shift();
    if (!operation) {
      setThemeSaveState("saved");
      setThemeUnsaved(false);
      return;
    }
    themeMutationInFlightRef.current = true;
    setThemeSaveState("saving");
    try {
      const updated = await api<ReviewSettings>(
        "/api/settings/theme",
        operation.kind === "reset"
          ? {
              method: "DELETE",
              body: JSON.stringify({ workspaceRoot: operation.workspaceRoot }),
            }
          : {
              method: "PUT",
              body: JSON.stringify({
                workspaceRoot: operation.workspaceRoot,
                preference: operation.preference,
              }),
            },
      );
      if (activeWorkspaceRootRef.current === operation.workspaceRoot)
        persistedThemeRef.current = updated.theme;
      if (
        activeWorkspaceRootRef.current === operation.workspaceRoot &&
        operation.revision === latestThemeIntentRef.current
      ) {
        applyTheme(updated.theme);
        setSettings((current) => ({ ...current, theme: updated.theme }));
      }
      themeMutationInFlightRef.current = false;
      if (themeQueueRef.current.length > 0) flushThemeQueueRef.current();
      else if (operation.revision === latestThemeIntentRef.current) {
        setThemeSaveState("saved");
        setThemeUnsaved(false);
      } else {
        setThemeSaveState("saving");
        setThemeUnsaved(true);
      }
    } catch (error) {
      themeMutationInFlightRef.current = false;
      const retryable = !(error instanceof ApiError) || error.status >= 500;
      if (operation.revision === latestThemeIntentRef.current) {
        if (retryable) {
          themeQueueRef.current.unshift(operation);
          setThemeSaveState("failed");
          setThemeUnsaved(true);
        } else {
          const persistedTheme = persistedThemeRef.current;
          applyTheme(persistedTheme);
          setSettings((current) => ({ ...current, theme: persistedTheme }));
          setThemeEditorRevision((current) => current + 1);
          setThemeSaveState("rejected");
          setThemeUnsaved(false);
        }
      } else {
        setThemeSaveState("saving");
        setThemeUnsaved(true);
        if (themeQueueRef.current.length > 0) flushThemeQueueRef.current();
      }
    }
  }, []);
  flushThemeQueueRef.current = () => void flushThemeQueue();

  const queueThemePreference = useCallback((preference: ThemePreference) => {
    const workspaceRoot = activeWorkspaceRootRef.current;
    if (!workspaceRoot) return;
    applyTheme(preference);
    setSettings((current) => ({ ...current, theme: preference }));
    setThemeSaveState("saving");
    setThemeUnsaved(true);
    const revision = ++latestThemeIntentRef.current;
    if (themeDebounceRef.current !== null)
      window.clearTimeout(themeDebounceRef.current);
    themeDebounceRef.current = window.setTimeout(() => {
      themeDebounceRef.current = null;
      const queue = themeQueueRef.current;
      const last = queue.at(-1);
      const operation = {
        kind: "update",
        preference,
        revision,
        workspaceRoot,
      } satisfies ThemeSaveOperation;
      if (last?.kind === "update" && last.workspaceRoot === workspaceRoot)
        queue[queue.length - 1] = operation;
      else queue.push(operation);
      flushThemeQueueRef.current();
    }, 450);
  }, []);

  const resetWorkspaceTheme = useCallback(() => {
    const workspaceRoot = activeWorkspaceRootRef.current;
    if (!workspaceRoot) return;
    if (themeDebounceRef.current !== null)
      window.clearTimeout(themeDebounceRef.current);
    themeDebounceRef.current = null;
    themeQueueRef.current = themeQueueRef.current.filter(
      (operation) => operation.workspaceRoot !== workspaceRoot,
    );
    const revision = ++latestThemeIntentRef.current;
    themeQueueRef.current.push({ kind: "reset", revision, workspaceRoot });
    applyTheme(DEFAULT_THEME_PREFERENCE);
    setSettings((current) => ({ ...current, theme: DEFAULT_THEME_PREFERENCE }));
    setThemeEditorRevision((current) => current + 1);
    setThemeSaveState("saving");
    setThemeUnsaved(true);
    flushThemeQueueRef.current();
  }, []);

  const retryThemeSave = useCallback(() => {
    if (themeQueueRef.current.length === 0) return;
    setThemeSaveState("saving");
    flushThemeQueueRef.current();
  }, []);

  const flushTypographyQueue = useCallback(async () => {
    if (typographyMutationInFlightRef.current || typographyPausedRef.current)
      return;
    const operation = typographyQueueRef.current;
    if (!operation) return;
    typographyQueueRef.current = null;
    typographyMutationInFlightRef.current = true;
    setTypographySaveState("saving");
    try {
      const updated = await api<ReviewSettings>("/api/settings/typography", {
        method: "PUT",
        body: JSON.stringify({
          workspaceRoot: operation.workspaceRoot,
          preference: operation.preference,
        }),
      });
      typographyMutationInFlightRef.current = false;
      confirmedTypographyRef.current = updated.typography;
      if (
        activeWorkspaceRootRef.current === operation.workspaceRoot &&
        operation.revision === latestTypographyIntentRef.current
      ) {
        applyTypography(updated.typography);
        desiredTypographyRef.current = updated.typography;
        setSettings((current) => ({
          ...current,
          typography: updated.typography,
        }));
      }
      if (typographyQueueRef.current) flushTypographyQueueRef.current();
      else {
        setTypographySaveState("saved");
        setTypographyUnsaved(false);
      }
    } catch (error) {
      typographyMutationInFlightRef.current = false;
      const rejected = error instanceof ApiError && error.status < 500;
      if (rejected) {
        typographyQueueRef.current = null;
        typographyPausedRef.current = false;
        desiredTypographyRef.current = confirmedTypographyRef.current;
        applyTypography(confirmedTypographyRef.current);
        setSettings((current) => ({
          ...current,
          typography: confirmedTypographyRef.current,
        }));
        setTypographySaveState("rejected");
        setTypographyUnsaved(false);
        return;
      }
      if (operation.source === "font") {
        typographyQueueRef.current = null;
        typographyPausedRef.current = false;
        desiredTypographyRef.current = confirmedTypographyRef.current;
        applyTypography(confirmedTypographyRef.current);
        setSettings((current) => ({
          ...current,
          typography: confirmedTypographyRef.current,
        }));
        setTypographySaveState("failed");
        setTypographyUnsaved(false);
        return;
      }
      typographyPausedRef.current = true;
      const latest = desiredTypographyRef.current;
      if (!typographyQueueRef.current)
        typographyQueueRef.current = {
          preference: latest,
          revision: latestTypographyIntentRef.current,
          workspaceRoot: operation.workspaceRoot,
          source: operation.source,
        };
      setTypographySaveState("failed");
      setTypographyUnsaved(true);
    }
  }, []);
  flushTypographyQueueRef.current = () => void flushTypographyQueue();

  const queueTypographyPreference = useCallback(
    (
      preference: TypographyPreference,
      source: TypographySaveOperation["source"],
    ) => {
      const workspaceRoot = activeWorkspaceRootRef.current;
      if (!workspaceRoot) return;
      desiredTypographyRef.current = preference;
      applyTypography(preference);
      setSettings((current) => ({ ...current, typography: preference }));
      const revision = ++latestTypographyIntentRef.current;
      typographyQueueRef.current = {
        preference,
        revision,
        workspaceRoot,
        source,
      };
      setTypographyUnsaved(true);
      if (!typographyPausedRef.current) {
        setTypographySaveState("saving");
        window.setTimeout(() => flushTypographyQueueRef.current(), 0);
      } else setTypographySaveState("failed");
    },
    [],
  );

  const retryTypographySave = useCallback(() => {
    if (!typographyQueueRef.current) {
      typographyQueueRef.current = {
        preference: desiredTypographyRef.current,
        revision: latestTypographyIntentRef.current,
        workspaceRoot: activeWorkspaceRootRef.current,
        source: "size",
      };
    }
    typographyPausedRef.current = false;
    setTypographySaveState("saving");
    flushTypographyQueueRef.current();
  }, []);

  useEffect(() => {
    const protectUnsavedTheme = (event: BeforeUnloadEvent) => {
      if (!themeUnsaved && !typographyUnsaved) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedTheme);
    return () =>
      window.removeEventListener("beforeunload", protectUnsavedTheme);
  }, [themeUnsaved, typographyUnsaved]);

  useEffect(
    () => () => {
      if (themeDebounceRef.current !== null)
        window.clearTimeout(themeDebounceRef.current);
    },
    [],
  );

  useEffect(() => {
    void loadWorkspace().then((nextWorkspace) => {
      if (nextWorkspace) void loadSettings();
    });
    const refreshVisibleWorkspace = () => {
      if (document.visibilityState === "visible") void loadWorkspace(true);
    };
    const interval = window.setInterval(refreshVisibleWorkspace, 30_000);
    document.addEventListener("visibilitychange", refreshVisibleWorkspace);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisibleWorkspace);
    };
  }, [loadSettings, loadWorkspace]);

  useEffect(() => {
    if (!workspace?.root) return;
    setWatchState("connecting");
    const events = new EventSource("/api/events");
    const handleReady = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { watching?: boolean };
        setWatchState(payload.watching ? "live" : "polling");
      } catch {
        setWatchState("polling");
      }
    };
    const handleWorkspaceChange = () => {
      setWatchState("live");
      void loadWorkspace(true);
    };
    events.addEventListener("ready", handleReady);
    events.addEventListener("workspace-changed", handleWorkspaceChange);
    events.onerror = () => setWatchState("polling");
    return () => events.close();
  }, [loadWorkspace, workspace?.root]);

  const activeFile = useMemo(
    () =>
      [...(workspace?.files ?? []), ...(workspace?.deferredFiles ?? [])].find(
        (file) => file.path === activePath,
      ) ?? null,
    [activePath, workspace],
  );
  const activeFileDeferred = Boolean(
    workspace?.deferredFiles.some((file) => file.path === activePath),
  );
  const activeFingerprint = activeFile?.fingerprint ?? "";
  const displayedDiff =
    diff?.path === activePath && diffWorkspaceRoot === workspace?.root
      ? diff
      : null;
  const selectionIsCurrent = Boolean(
    displayedDiff &&
    selectionScope?.path === displayedDiff.path &&
    selectionScope.fingerprint === displayedDiff.fingerprint,
  );
  const selectedLines = selectionIsCurrent ? storedSelectedLines : [];
  draftStateRef.current.hasDraft =
    storedSelectedLines.length > 0 || Boolean(commentBody.trim());
  const setSelectedLines = useCallback(
    (lines: SelectedLine[]) => {
      setStoredSelectedLines(lines);
      setSelectionScope(
        lines.length > 0 && displayedDiff
          ? { path: displayedDiff.path, fingerprint: displayedDiff.fingerprint }
          : null,
      );
    },
    [displayedDiff],
  );

  useEffect(() => {
    const previous = previousActiveFileRef.current;
    const current = activeFingerprint
      ? { path: activePath, fingerprint: activeFingerprint }
      : null;
    const fileChangedInPlace = Boolean(
      previous &&
      current &&
      previous.path === current.path &&
      previous.fingerprint !== current.fingerprint,
    );
    if (fileChangedInPlace && draftStateRef.current.hasDraft) {
      setDraftInvalidationNotice(
        "This file changed. The unsaved comment anchor was cleared; existing notes are kept as stale history.",
      );
      focusDiffAfterLoadRef.current = true;
      if (reviewPanelOverlay) setReviewPanelOpen(false);
    } else if (previous && current && previous.path !== current.path) {
      setDraftInvalidationNotice("");
    }
    previousActiveFileRef.current = current;
    setStoredSelectedLines([]);
    setSelectionScope(null);
    setCommentBody("");
  }, [activeFingerprint, activePath, reviewPanelOverlay]);

  useEffect(() => {
    setContextLines(settings.diffContextLines);
  }, [activePath, settings.diffContextLines]);

  const loadDiff = useCallback(async () => {
    const requestId = ++diffRequestRef.current;
    const expectedWorkspaceEpoch = workspaceEpoch;
    if (!activePath) {
      setDiff(null);
      setDiffWorkspaceRoot("");
      setDiffLoading(false);
      return;
    }

    setDiffLoading(true);
    setDiff(null);
    setDiffWorkspaceRoot("");
    try {
      const nextDiff = await api<DiffResponse>(
        `/api/diff?path=${encodeURIComponent(activePath)}&context=${contextLines}`,
      );
      if (
        requestId !== diffRequestRef.current ||
        expectedWorkspaceEpoch !== workspaceEpochRef.current ||
        nextDiff.path !== activePath
      )
        return;
      setDiff(nextDiff);
      setDiffWorkspaceRoot(workspace?.root ?? "");
      setActionError("");
    } catch (error) {
      if (
        requestId !== diffRequestRef.current ||
        expectedWorkspaceEpoch !== workspaceEpochRef.current
      )
        return;
      setDiff(null);
      setDiffWorkspaceRoot("");
      setActionError(
        error instanceof Error
          ? error.message
          : "The diff could not be loaded.",
      );
    } finally {
      if (requestId === diffRequestRef.current) setDiffLoading(false);
    }
  }, [activePath, contextLines, workspace?.root, workspaceEpoch]);
  const loadDiffRef = useRef(loadDiff);
  loadDiffRef.current = loadDiff;

  useEffect(() => {
    if (!workspace?.root) {
      setGithubStatus(null);
      return;
    }
    let active = true;
    setGithubStatus(null);
    void api<GitHubImportStatus>("/api/github/status")
      .then((status) => {
        if (!active) return;
        setGithubStatus(status);
        if (status.retained) void loadDiffRef.current();
      })
      .catch(() => {
        if (active)
          setGithubStatus({
            version: 1,
            state: "unavailable",
            retained: false,
            stale: false,
            message: "GitHub pull request discovery is unavailable.",
          });
      });
    return () => {
      active = false;
    };
  }, [workspace?.branch, workspace?.head, workspace?.root]);

  const refreshGitHubComments = async () => {
    const expectedWorkspaceIdentity = activeWorkspaceIdentityRef.current;
    setGithubRefreshing(true);
    try {
      const status = await api<GitHubImportStatus>("/api/github/refresh", {
        method: "POST",
        body: "{}",
      });
      if (expectedWorkspaceIdentity !== activeWorkspaceIdentityRef.current)
        return;
      setGithubStatus(status);
      if (status.retained) {
        await loadWorkspace(true);
        await loadDiff();
      }
    } catch (error) {
      if (expectedWorkspaceIdentity !== activeWorkspaceIdentityRef.current)
        return;
      setActionError(
        error instanceof Error
          ? error.message
          : "GitHub comments could not be refreshed.",
      );
    } finally {
      setGithubRefreshing(false);
    }
  };

  const retryGithubDiscovery = async () => {
    const expectedWorkspaceIdentity = activeWorkspaceIdentityRef.current;
    setGithubRefreshing(true);
    try {
      const status = await api<GitHubImportStatus>("/api/github/status");
      if (expectedWorkspaceIdentity !== activeWorkspaceIdentityRef.current)
        return;
      setGithubStatus(status);
    } catch (error) {
      if (expectedWorkspaceIdentity !== activeWorkspaceIdentityRef.current)
        return;
      setActionError(
        error instanceof Error
          ? error.message
          : "GitHub pull request discovery is unavailable.",
      );
    } finally {
      setGithubRefreshing(false);
    }
  };

  useEffect(() => {
    void loadDiff();
  }, [activeFile?.fingerprint, loadDiff]);

  useEffect(() => {
    if (!displayedDiff || !focusDiffAfterLoadRef.current) return;
    focusDiffAfterLoadRef.current = false;
    window.requestAnimationFrame(() => diffViewRef.current?.focusCurrentLine());
  }, [displayedDiff]);

  const visibleFiles = useMemo(() => {
    const query = fileSearch.trim().toLowerCase();
    return (workspace?.files ?? []).filter((file) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "approved" && file.reviewStatus === "approved") ||
        (filter === "needs-review" && file.reviewStatus !== "approved");
      const matchesSearch = !query || file.path.toLowerCase().includes(query);
      return matchesFilter && matchesSearch;
    });
  }, [fileSearch, filter, workspace]);
  const visibleApprovalFiles = useMemo(
    () =>
      visibleFiles.filter(
        (file) => file.reviewStatus !== "approved" && !file.binary,
      ),
    [visibleFiles],
  );
  const visibleBinaryCount = useMemo(
    () =>
      visibleFiles.filter(
        (file) => file.reviewStatus !== "approved" && file.binary,
      ).length,
    [visibleFiles],
  );

  const selectRelativeFile = useCallback(
    (direction: 1 | -1) => {
      if (visibleFiles.length === 0) return;
      const currentIndex = visibleFiles.findIndex(
        (file) => file.path === activePath,
      );
      const nextIndex =
        currentIndex < 0
          ? 0
          : (currentIndex + direction + visibleFiles.length) %
            visibleFiles.length;
      focusDiffAfterLoadRef.current = true;
      setActivePath(visibleFiles[nextIndex]?.path ?? "");
      setSelectedLines([]);
      setCommentBody("");
    },
    [activePath, setSelectedLines, visibleFiles],
  );

  const closeFilePanel = useCallback((restoreFocus = true) => {
    setFilePanelOpen(false);
    setPendingFileSearch(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          (
            filePanelToggleRef.current ?? filePanelReturnFocusRef.current
          )?.focus();
        }),
      );
    }
  }, []);

  const openFilePanel = useCallback(
    (focusSearch = true) => {
      if (!filePanelOpen)
        filePanelReturnFocusRef.current =
          document.activeElement as HTMLElement | null;
      setPendingFileSearch(focusSearch);
      setFilePanelOpen(true);
    },
    [filePanelOpen],
  );

  const closeSettings = useCallback(() => {
    setActivePage("review");
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => settingsNavRef.current?.focus()),
    );
  }, []);

  const closeReviewPanel = useCallback((restoreFocus = true) => {
    setReviewPanelOpen(false);
    setPendingReviewFocus(null);
    if (restoreFocus)
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          reviewToggleRef.current?.focus();
        }),
      );
  }, []);

  const openReviewPanel = useCallback(
    (focus: "panel" | "composer" = "panel") => {
      if (filePanelOverlay && filePanelOpen) closeFilePanel(false);
      setPendingReviewFocus(focus);
      setReviewPanelOpen(true);
    },
    [closeFilePanel, filePanelOpen, filePanelOverlay],
  );

  const openLineJump = useCallback(() => {
    if (reviewPanelOpen) closeReviewPanel(false);
    setLineJumpOpen(true);
    setLineJumpValue("");
    setLineJumpError("");
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => lineJumpRef.current?.focus()),
    );
  }, [closeReviewPanel, reviewPanelOpen]);

  const exitToDiff = useCallback(() => {
    setLineJumpOpen(false);
    setLineJumpError("");
    diffViewRef.current?.focusCurrentLine();
  }, []);

  const submitLineJump = useCallback(() => {
    const lineNumber = Number(lineJumpValue);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
      setLineJumpError("Enter a positive line number.");
      return;
    }
    if (!diffViewRef.current?.goToLine(lineNumber)) {
      setLineJumpError("That line is not visible in this diff.");
      return;
    }
    setLineJumpOpen(false);
    setLineJumpError("");
  }, [lineJumpValue]);

  useEffect(() => {
    if (!reviewPanelOpen || !pendingReviewFocus) return;
    window.requestAnimationFrame(() => {
      if (pendingReviewFocus === "composer")
        commentTextareaRef.current?.focus();
      else reviewPanelRef.current?.focus();
      setPendingReviewFocus(null);
    });
  }, [pendingReviewFocus, reviewPanelOpen]);

  useEffect(() => {
    if (!filePanelOpen || !pendingFileSearch) return;
    window.requestAnimationFrame(() => {
      fileSearchRef.current?.focus();
      setPendingFileSearch(false);
    });
  }, [filePanelOpen, pendingFileSearch]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (activePage === "settings") {
        if (event.key === "Escape") {
          event.preventDefault();
          closeSettings();
          return;
        }
        if (target.matches('input, textarea, select, [contenteditable="true"]'))
          return;
        return;
      }
      if (event.key === "Escape") {
        if (vimDiffMode) {
          event.preventDefault();
          setVimDiffMode(false);
          setVimVisualMode(false);
          setSelectedLines([]);
          return;
        }
        if (reviewPanelOpen) closeReviewPanel();
        else if (filePanelOverlay && filePanelOpen) closeFilePanel();
        else if (
          !target.matches('input, textarea, select, [contenteditable="true"]')
        ) {
          if (selectedLines.length > 0) setSelectedLines([]);
          else if (diffSearch) setDiffSearch("");
          else if (fileSearch) setFileSearch("");
        }
        return;
      }
      if (target.matches('input, textarea, select, [contenteditable="true"]'))
        return;
      if (settings.keyboardLayout === "vim" && vimDiffMode) {
        const key = event.key.toLowerCase();
        if (event.ctrlKey && (key === "d" || key === "u")) {
          event.preventDefault();
          diffViewRef.current?.navigateFocusedPage(
            key === "d" ? 1 : -1,
            0.5,
            vimVisualMode,
          );
          return;
        }
        if (event.key === "PageDown" || event.key === "PageUp") {
          event.preventDefault();
          diffViewRef.current?.navigateFocusedPage(
            event.key === "PageDown" ? 1 : -1,
            1,
            vimVisualMode,
          );
          return;
        }
        if (key === "g" && event.shiftKey) {
          event.preventDefault();
          vimGStartedAtRef.current = 0;
          diffViewRef.current?.focusBoundary("end", vimVisualMode);
          return;
        }
        if (
          event.key === "g" &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          const now = Date.now();
          if (now - vimGStartedAtRef.current < 750) {
            vimGStartedAtRef.current = 0;
            diffViewRef.current?.focusBoundary("start", vimVisualMode);
          } else {
            vimGStartedAtRef.current = now;
          }
          return;
        }
        if (
          (key === "j" || key === "k") &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          diffViewRef.current?.navigateFocusedLine(
            key === "j" ? 1 : -1,
            vimVisualMode,
          );
          return;
        }
        if (key === "v" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          if (!vimVisualMode) diffViewRef.current?.selectFocusedLine();
          setVimVisualMode((current) => !current);
          return;
        }
        if (key === "a" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          approveFileButtonRef.current?.click();
          return;
        }
        if (
          key === "c" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          displayedDiff
        ) {
          const hasSelection = selectedLines.length > 0;
          if (hasSelection || diffViewRef.current?.selectFocusedLine()) {
            event.preventDefault();
            setVimDiffMode(false);
            setVimVisualMode(false);
            openReviewPanel("composer");
          }
          return;
        }
      }
      if (
        settings.keyboardLayout === "vim" &&
        !vimDiffMode &&
        event.key === "Enter" &&
        displayedDiff &&
        (target === document.body ||
          target.matches(".line-number-button") ||
          Boolean(target.closest(".diff-view")))
      ) {
        event.preventDefault();
        setVimDiffMode(true);
        setVimVisualMode(false);
        diffViewRef.current?.focusCurrentLine();
        return;
      }
      if (
        event.key.toLowerCase() === "j" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        if (reviewPanelOpen) closeReviewPanel(false);
        setLineJumpOpen(false);
        selectRelativeFile(1);
      }
      if (
        event.key.toLowerCase() === "k" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        if (reviewPanelOpen) closeReviewPanel(false);
        setLineJumpOpen(false);
        selectRelativeFile(-1);
      }
      if (
        event.key.toLowerCase() === "c" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        displayedDiff
      ) {
        const hasSelection = selectedLines.length > 0;
        if (hasSelection || diffViewRef.current?.selectFocusedLine()) {
          event.preventDefault();
          openReviewPanel("composer");
        }
      }
      if (event.key === "/") {
        event.preventDefault();
        if (reviewPanelOpen) closeReviewPanel(false);
        setLineJumpOpen(false);
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => diffSearchRef.current?.focus()),
        );
      }
      if (
        event.key.toLowerCase() === "g" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        displayedDiff
      ) {
        event.preventDefault();
        openLineJump();
      }
      if (
        event.key.toLowerCase() === "f" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        if (reviewPanelOpen) closeReviewPanel(false);
        openFilePanel(true);
      }
      if (event.key === "]") {
        event.preventDefault();
        if (reviewPanelOpen) closeReviewPanel();
        else openReviewPanel("panel");
      }
      if (event.key === "[") {
        event.preventDefault();
        if (filePanelOpen) closeFilePanel();
        else {
          if (reviewPanelOpen) closeReviewPanel(false);
          openFilePanel(true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activePage,
    closeFilePanel,
    closeSettings,
    closeReviewPanel,
    diffSearch,
    displayedDiff,
    filePanelOpen,
    filePanelOverlay,
    fileSearch,
    openFilePanel,
    openLineJump,
    openReviewPanel,
    reviewPanelOpen,
    selectRelativeFile,
    selectedLines.length,
    setSelectedLines,
    settings.keyboardLayout,
    vimDiffMode,
    vimVisualMode,
  ]);

  useEffect(() => {
    setVimDiffMode(false);
    setVimVisualMode(false);
  }, [activePath, settings.keyboardLayout]);

  useEffect(() => {
    if (!vimDiffMode) return;
    const scroller = document.querySelector<HTMLElement>(".diff-scroll");
    if (!scroller) return;
    let wheelDelta = 0;
    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      wheelDelta += event.deltaY;
      const rowCount = Math.trunc(wheelDelta / 28);
      if (rowCount === 0) return;
      wheelDelta -= rowCount * 28;
      diffViewRef.current?.navigateFocusedLine(
        rowCount > 0 ? 1 : -1,
        vimVisualMode,
        Math.min(6, Math.abs(rowCount)),
      );
    };
    scroller.addEventListener("wheel", handleWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", handleWheel);
  }, [vimDiffMode, vimVisualMode]);

  const openWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (themeUnsaved || typographyUnsaved) {
      setWorkspaceError(
        "Wait for workspace appearance settings to finish saving, or retry the failed save before switching.",
      );
      return;
    }
    workspaceOpenRef.current = true;
    workspaceRequestRef.current += 1;
    settingsRequestRef.current += 1;
    diffRequestRef.current += 1;
    setDiff(null);
    setDiffWorkspaceRoot("");
    setSelectedLines([]);
    setCommentBody("");
    setOpeningWorkspace(true);
    setSettingsLoaded(false);
    try {
      const nextWorkspace = await api<WorkspaceResponse>(
        "/api/workspace/open",
        {
          method: "POST",
          body: JSON.stringify({ path: pathInput }),
        },
      );
      setWorkspace(nextWorkspace);
      workspaceEpochRef.current += 1;
      setWorkspaceEpoch(workspaceEpochRef.current);
      setWorkspaceError("");
      setWorkspacePathOpen(false);
      setActivePath(
        nextWorkspace.files.find((file) => file.reviewStatus !== "approved")
          ?.path ??
          nextWorkspace.files[0]?.path ??
          "",
      );
      setSelectedLines([]);
      await loadSettings();
    } catch (error) {
      setSettingsLoaded(true);
      setWorkspaceError(
        error instanceof Error
          ? error.message
          : "That local workspace could not be opened.",
      );
      void loadDiff();
    } finally {
      workspaceOpenRef.current = false;
      setOpeningWorkspace(false);
      setLoadingWorkspace(false);
    }
  };

  const approveFile = async () => {
    if (!displayedDiff || displayedDiff.path !== activePath) return;
    setApproving("file");
    try {
      await api("/api/review/file", {
        method: "POST",
        body: JSON.stringify({
          path: displayedDiff.path,
          fingerprint: displayedDiff.fingerprint,
        }),
      });
      setDiff((current) =>
        current?.path === displayedDiff.path
          ? {
              ...current,
              reviewStatus: "approved",
              approvedAt: new Date().toISOString(),
            }
          : current,
      );
      const refreshed = await loadWorkspace(true);
      const nextFile = refreshed?.files.find(
        (file) =>
          file.reviewStatus !== "approved" && file.path !== displayedDiff.path,
      );
      if (nextFile && filter === "needs-review") setActivePath(nextFile.path);
      setActionError("");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The file could not be approved.",
      );
      await loadWorkspace(true);
    } finally {
      setApproving("");
    }
  };

  const approveSnapshot = async () => {
    setApproving("snapshot");
    try {
      const result = await api<SnapshotResponse>("/api/review/snapshot", {
        method: "POST",
        body: "{}",
      });
      setWorkspace(result.workspace);
      setDiff((current) => {
        const approved = result.workspace.files.find(
          (file) =>
            file.path === current?.path && file.reviewStatus === "approved",
        );
        return current && approved
          ? {
              ...current,
              reviewStatus: "approved",
              approvedAt: result.snapshot.approvedAt,
            }
          : current;
      });
      setActionError("");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The snapshot could not be approved.",
      );
    } finally {
      setApproving("");
    }
  };

  const deferFile = async () => {
    if (!displayedDiff || activeFileDeferred) return;
    try {
      const refreshed = await api<WorkspaceResponse>(
        `/api/review/defer?includeNoise=${includeNoiseRef.current}`,
        {
          method: "POST",
          body: JSON.stringify({ path: displayedDiff.path }),
        },
      );
      setWorkspace(refreshed);
      const next =
        refreshed.files.find((file) => file.reviewStatus !== "approved") ??
        refreshed.files[0];
      setActivePath(next?.path ?? "");
      setSelectedLines([]);
      setCommentBody("");
      setActionError("");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The file could not be deferred.",
      );
    }
  };

  const restoreFile = async (path: string) => {
    try {
      const refreshed = await api<WorkspaceResponse>(
        `/api/review/restore?includeNoise=${includeNoiseRef.current}`,
        {
          method: "POST",
          body: JSON.stringify({ path }),
        },
      );
      setWorkspace(refreshed);
      setActivePath(path);
      setActionError("");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The file could not be restored.",
      );
    }
  };

  const approveVisibleFiles = async () => {
    const files = visibleApprovalFiles;
    if (files.length < 2) return;
    if (visibleApprovalMessageTimerRef.current !== null) {
      window.clearTimeout(visibleApprovalMessageTimerRef.current);
      visibleApprovalMessageTimerRef.current = null;
    }
    setApprovingVisibleCount(files.length);
    setVisibleApprovalMessage("");
    setVisibleApprovalError("");
    try {
      const result = await api<FilesApprovalResponse>("/api/review/files", {
        method: "POST",
        body: JSON.stringify({
          files: files.map((file) => ({
            path: file.path,
            fingerprint: file.fingerprint,
          })),
        }),
      });
      const approvedPaths = new Set(
        result.approvals.map((approval) => approval.path),
      );
      setDiff((current) =>
        current && approvedPaths.has(current.path)
          ? {
              ...current,
              reviewStatus: "approved",
              approvedAt: result.approvedAt,
            }
          : current,
      );
      await loadWorkspace(true);
      const count = result.approvals.length;
      setVisibleApprovalMessage(
        `${count} visible file${count === 1 ? "" : "s"} approved.`,
      );
      window.requestAnimationFrame(() => {
        if (filePanelOverlay && filePanelOpen) fileSearchRef.current?.focus();
        else document.getElementById("diff-content")?.focus();
      });
      visibleApprovalMessageTimerRef.current = window.setTimeout(() => {
        setVisibleApprovalMessage("");
        visibleApprovalMessageTimerRef.current = null;
      }, 4_000);
    } catch (error) {
      setVisibleApprovalError(
        error instanceof Error
          ? error.message
          : "The visible files could not be approved.",
      );
      await loadWorkspace(true);
    } finally {
      setApprovingVisibleCount(0);
    }
  };

  const addComment = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !displayedDiff ||
      displayedDiff.path !== activePath ||
      selectedLines.length === 0
    )
      return;
    setSavingComment(true);
    try {
      const anchors = selectedLines.reduce<
        Array<{ side: "old" | "new"; startLine: number; endLine: number }>
      >((ranges, line) => {
        if (line.number === null) return ranges;
        const previous = ranges.at(-1);
        if (
          previous &&
          previous.side === line.side &&
          line.number <= previous.endLine + 1
        ) {
          previous.endLine = Math.max(previous.endLine, line.number);
        } else {
          ranges.push({
            side: line.side,
            startLine: line.number,
            endLine: line.number,
          });
        }
        return ranges;
      }, []);
      const comment = await api<ReviewComment>("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          path: displayedDiff.path,
          fingerprint: displayedDiff.fingerprint,
          anchors,
          body: commentBody,
        }),
      });
      setDiff((current) =>
        current?.path === displayedDiff.path
          ? { ...current, comments: [...current.comments, comment] }
          : current,
      );
      setCommentBody("");
      setSelectedLines([]);
      await loadWorkspace(true);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The comment could not be saved.",
      );
    } finally {
      setSavingComment(false);
    }
  };

  const commitCommentDeletion = useCallback(
    async (pending: PendingCommentDeletion) => {
      if (pendingCommentDeletionRef.current?.comment.id !== pending.comment.id)
        return;
      if (commentDeletionTimerRef.current !== null)
        window.clearTimeout(commentDeletionTimerRef.current);
      commentDeletionTimerRef.current = null;
      pendingCommentDeletionRef.current = null;
      setPendingCommentDeletion(null);
      try {
        await api(`/api/comments/${encodeURIComponent(pending.comment.id)}`, {
          method: "DELETE",
        });
        if (activeWorkspaceRootRef.current === pending.workspaceRoot) {
          await loadWorkspace(true);
          await loadDiff();
        }
      } catch (error) {
        if (activeWorkspaceRootRef.current === pending.workspaceRoot) {
          setDiff((current) =>
            current?.path === pending.comment.path &&
            !current.comments.some(
              (comment) => comment.id === pending.comment.id,
            )
              ? {
                  ...current,
                  comments: [...current.comments, pending.comment].sort(
                    (first, second) =>
                      first.createdAt.localeCompare(second.createdAt),
                  ),
                }
              : current,
          );
        }
        setActionError(
          error instanceof Error
            ? error.message
            : "The comment could not be deleted.",
        );
      }
    },
    [loadDiff, loadWorkspace],
  );

  const scheduleCommentDeletion = useCallback(
    (comment: ReviewComment) => {
      const previous = pendingCommentDeletionRef.current;
      if (previous) void commitCommentDeletion(previous);
      const pending = {
        comment,
        workspaceRoot: activeWorkspaceRootRef.current,
      };
      pendingCommentDeletionRef.current = pending;
      setPendingCommentDeletion(pending);
      setDiff((current) =>
        current?.path === comment.path
          ? {
              ...current,
              comments: current.comments.filter(
                (candidate) => candidate.id !== comment.id,
              ),
            }
          : current,
      );
      commentDeletionTimerRef.current = window.setTimeout(() => {
        void commitCommentDeletion(pending);
      }, 7_000);
    },
    [commitCommentDeletion],
  );

  const undoCommentDeletion = useCallback(() => {
    const pending = pendingCommentDeletionRef.current;
    if (!pending) return;
    if (commentDeletionTimerRef.current !== null)
      window.clearTimeout(commentDeletionTimerRef.current);
    commentDeletionTimerRef.current = null;
    pendingCommentDeletionRef.current = null;
    setPendingCommentDeletion(null);
    if (activeWorkspaceRootRef.current !== pending.workspaceRoot) return;
    setDiff((current) =>
      current?.path === pending.comment.path &&
      !current.comments.some((comment) => comment.id === pending.comment.id)
        ? {
            ...current,
            comments: [...current.comments, pending.comment].sort(
              (first, second) =>
                first.createdAt.localeCompare(second.createdAt),
            ),
          }
        : current,
    );
  }, []);

  useEffect(() => {
    const pending = pendingCommentDeletionRef.current;
    if (!pending || pending.workspaceRoot === workspace?.root) return;
    if (commentDeletionTimerRef.current !== null)
      window.clearTimeout(commentDeletionTimerRef.current);
    commentDeletionTimerRef.current = null;
    pendingCommentDeletionRef.current = null;
    setPendingCommentDeletion(null);
  }, [workspace?.root]);

  useEffect(
    () => () => {
      if (commentDeletionTimerRef.current !== null)
        window.clearTimeout(commentDeletionTimerRef.current);
      if (visibleApprovalMessageTimerRef.current !== null)
        window.clearTimeout(visibleApprovalMessageTimerRef.current);
    },
    [],
  );

  const dismissReviewHint = () => {
    setReviewHintVisible(false);
    try {
      window.localStorage.setItem("redline.review-hint-dismissed", "1");
    } catch {
      // The hint can still be dismissed for this session when storage is unavailable.
    }
  };

  const copyComments = async () => {
    try {
      const response = await fetch("/api/comments/export?format=markdown");
      if (!response.ok) throw new Error("Comment export failed.");
      await navigator.clipboard.writeText(await response.text());
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("failed");
    }
  };

  if (
    (loadingWorkspace && !workspace && !workspaceError) ||
    (workspace && !settingsLoaded)
  ) {
    return (
      <main className="app-shell" data-shell="review-workspace">
        <LoadingShell />
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="app-shell" data-shell="review-workspace">
        <section className="workspace-error-state">
          <div>
            <p className="eyebrow">Local workspace</p>
            <h1>Point Redline at a Git checkout.</h1>
            <p>
              {workspaceError ||
                "The current server directory is not a Git workspace."}
            </p>
            <WorkspaceForm
              error={workspaceError}
              loading={openingWorkspace}
              onSubmit={(event) => void openWorkspace(event)}
              path={pathInput}
              setPath={setPathInput}
            />
          </div>
        </section>
      </main>
    );
  }

  if (activePage === "settings") {
    return (
      <SettingsPage
        includeNoise={includeNoise}
        onBack={closeSettings}
        onIncludeNoiseChange={(nextIncludeNoise) => {
          setIncludeNoise(nextIncludeNoise);
          void loadWorkspace(true, nextIncludeNoise);
        }}
        onSaved={(updated) => {
          setSettings((current) => ({
            ...updated,
            theme: current.theme,
            typography: current.typography,
          }));
          setContextLines(updated.diffContextLines);
        }}
        onThemeChange={queueThemePreference}
        onThemeReset={resetWorkspaceTheme}
        onThemeRetry={retryThemeSave}
        onTypographyChange={queueTypographyPreference}
        onTypographyRetry={retryTypographySave}
        settings={settings}
        themeEditorRevision={themeEditorRevision}
        themeSaveState={themeSaveState}
        typographySaveState={typographySaveState}
        typographyUnsaved={typographyUnsaved}
        workspace={workspace}
      />
    );
  }

  return (
    <main className="app-shell" data-shell="review-workspace">
      <a className="skip-link" href="#diff-content">
        Skip to diff
      </a>

      <div
        className="review-shell"
        data-files-open={filePanelOpen}
        data-review-open={reviewPanelOpen}
      >
        <aside
          aria-label="Changed files"
          aria-modal={filePanelOverlay && filePanelOpen ? true : undefined}
          className="file-rail"
          data-open={filePanelOpen}
          id="changed-files-panel"
          inert={reviewPanelOverlay && reviewPanelOpen ? true : undefined}
          onKeyDown={filePanelOverlay ? trapOverlayFocus : undefined}
          ref={filePanelRef}
          role={filePanelOverlay ? "dialog" : undefined}
          tabIndex={filePanelOverlay ? -1 : undefined}
        >
          <div className="workspace-identity">
            <div className="workspace-title-row">
              <div>
                <p className="rail-label">Workspace</p>
                <h1 title={workspace.name}>{workspace.name}</h1>
              </div>
              <div className="workspace-title-actions">
                <button
                  aria-expanded={workspacePathOpen}
                  className="workspace-change-button"
                  onClick={() => setWorkspacePathOpen((current) => !current)}
                  type="button"
                >
                  Change
                </button>
                <button
                  aria-label="Refresh local changes"
                  className="icon-button"
                  data-spinning={refreshing}
                  onClick={() => void loadWorkspace(true)}
                  type="button"
                >
                  <RefreshIcon />
                </button>
                <button
                  aria-controls="changed-files-panel"
                  aria-expanded="true"
                  aria-label="Collapse changed files panel"
                  className="icon-button"
                  onClick={() => closeFilePanel()}
                  title="Collapse changed files panel ([)"
                  type="button"
                >
                  <LeftPanelIcon />
                </button>
              </div>
            </div>
            {workspacePathOpen ? (
              <form
                className="workspace-path-form"
                onSubmit={(event) => void openWorkspace(event)}
              >
                <label htmlFor="workspace-path">Local path</label>
                <div>
                  <input
                    autoFocus
                    id="workspace-path"
                    onChange={(event) => setPathInput(event.target.value)}
                    spellCheck={false}
                    value={pathInput}
                  />
                  <button
                    disabled={openingWorkspace || pathInput === workspace.root}
                    type="submit"
                  >
                    Open
                  </button>
                </div>
              </form>
            ) : null}
          </div>

          <div className="review-counts" aria-label="Review counts">
            <button
              data-active={filter === "needs-review"}
              onClick={() => setFilter("needs-review")}
              type="button"
            >
              <strong>{workspace.counts.needsReview}</strong>
              <span>Needs review</span>
            </button>
            <button
              data-active={filter === "approved"}
              onClick={() => setFilter("approved")}
              type="button"
            >
              <strong>{workspace.counts.approved}</strong>
              <span>Approved</span>
            </button>
            <button
              data-active={filter === "all"}
              onClick={() => setFilter("all")}
              type="button"
            >
              <strong>{workspace.counts.total}</strong>
              <span>All</span>
            </button>
          </div>

          <label className="file-search">
            <span className="visually-hidden">Filter changed files</span>
            <SearchIcon />
            <input
              onChange={(event) => setFileSearch(event.target.value)}
              placeholder="Filter files"
              ref={fileSearchRef}
              value={fileSearch}
            />
            <kbd>F</kbd>
          </label>

          <div className="file-list" role="list">
            {visibleFiles.length > 0 ? (
              visibleFiles.map((file) => (
                <div className="file-list-item" key={file.path} role="listitem">
                  <button
                    aria-label={`${file.path}, ${statusLabel(file)}, ${changeLabel(file)}${file.commentCount > 0 ? `, ${file.commentCount} ${file.commentCount === 1 ? "comment" : "comments"}` : ""}`}
                    aria-current={activePath === file.path ? "true" : undefined}
                    className="file-row"
                    data-active={activePath === file.path}
                    data-review-status={file.reviewStatus}
                    onClick={() => {
                      setActivePath(file.path);
                      setSelectedLines([]);
                      setCommentBody("");
                      if (filePanelOverlay) {
                        closeFilePanel(false);
                        window.requestAnimationFrame(() =>
                          document.getElementById("diff-content")?.focus(),
                        );
                      }
                    }}
                    type="button"
                  >
                    <span className="file-status-mark" aria-hidden="true">
                      {file.reviewStatus === "approved" ? (
                        <CheckIcon />
                      ) : file.reviewStatus === "changed" ? (
                        "↻"
                      ) : (
                        "•"
                      )}
                    </span>
                    <span className="file-copy">
                      <strong>{file.name}</strong>
                      <small>{file.directory || "workspace root"}</small>
                    </span>
                    <span className="file-meta">
                      <span>{file.statusCode.trim() || "M"}</span>
                      {file.commentCount > 0 ? (
                        <span className="file-comment-count">
                          <CommentIcon />
                          {file.commentCount}
                        </span>
                      ) : null}
                    </span>
                    <span aria-hidden="true" className="file-focus-path">
                      {file.path}
                    </span>
                    <span className="visually-hidden">
                      {statusLabel(file)}, {changeLabel(file)}
                    </span>
                  </button>
                </div>
              ))
            ) : (
              <div className="file-list-empty">
                {filter === "needs-review" && workspace.counts.approved > 0 ? (
                  <>
                    <CheckIcon />
                    <strong>Review is current.</strong>
                    <span>
                      Approved files return here only when they change.
                    </span>
                  </>
                ) : (
                  <>
                    <SearchIcon />
                    <strong>No matching files.</strong>
                    <span>Change the filter or search.</span>
                  </>
                )}
              </div>
            )}
          </div>

          {workspace.deferredFiles.length > 0 ? (
            <section
              className="deferred-files"
              aria-labelledby="deferred-files-heading"
            >
              <h2 id="deferred-files-heading">Deferred</h2>
              <p>Unapproved changes outside the active queue.</p>
              <div role="list">
                {workspace.deferredFiles.map((file) => (
                  <div
                    className="deferred-file-row"
                    key={file.path}
                    role="listitem"
                  >
                    <button
                      aria-current={
                        activePath === file.path ? "true" : undefined
                      }
                      onClick={() => setActivePath(file.path)}
                      type="button"
                    >
                      <strong>{file.name}</strong>
                      <small>{file.directory || "workspace root"}</small>
                      <span className="visually-hidden">
                        Deferred, {file.path}
                      </span>
                    </button>
                    <button
                      onClick={() => void restoreFile(file.path)}
                      type="button"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {visibleApprovalFiles.length >= 2 ||
          visibleApprovalMessage ||
          visibleApprovalError ? (
            <section
              className="visible-approval"
              aria-label="Visible file approval"
            >
              {visibleApprovalFiles.length >= 2 ? (
                <button
                  aria-busy={approvingVisibleCount > 0}
                  data-loading={approvingVisibleCount > 0}
                  disabled={approvingVisibleCount > 0}
                  onClick={() => void approveVisibleFiles()}
                  title="Approves the current filtered queue. Does not stage or commit."
                  type="button"
                >
                  <CheckIcon />
                  <span>
                    <strong>
                      {approvingVisibleCount > 0
                        ? `Approving ${approvingVisibleCount} files`
                        : `Approve ${visibleApprovalFiles.length} visible files`}
                    </strong>
                    <small>
                      Current filtered queue. Does not stage or commit.
                    </small>
                  </span>
                </button>
              ) : null}
              {visibleBinaryCount > 0 && visibleApprovalFiles.length >= 2 ? (
                <p>
                  {visibleBinaryCount} binary file
                  {visibleBinaryCount === 1 ? "" : "s"} excluded.
                </p>
              ) : null}
              <p
                aria-live="polite"
                className="visible-approval-result"
                data-error={Boolean(visibleApprovalError)}
              >
                {visibleApprovalError || visibleApprovalMessage}
              </p>
            </section>
          ) : null}

          <div className="rail-footer">
            <button
              className="settings-nav-button"
              onClick={() => {
                setReviewPanelOpen(false);
                setActivePage("settings");
              }}
              ref={settingsNavRef}
              type="button"
            >
              <SettingsIcon />
              <span>Settings</span>
              <small>
                {settings.keyboardLayout === "vim" ? "Vim" : "Normie"} ·{" "}
                {settings.diffContextLines} lines
              </small>
            </button>
            <div className="rail-utilities">
              <div className="workspace-watch-state" data-state={watchState}>
                <span aria-hidden="true" />
                {refreshing
                  ? "Refreshing changes"
                  : watchState === "live"
                    ? "Watching files"
                    : watchState === "polling"
                      ? "Polling for changes"
                      : "Connecting watcher"}
              </div>
              <details className="shortcut-guide">
                <summary>Shortcuts</summary>
                <div aria-label="Keyboard shortcuts">
                  {settings.keyboardLayout === "vim" ? (
                    <>
                      <span>
                        <kbd>Enter</kbd> Navigate the diff
                      </span>
                      <span>
                        <kbd>J</kbd>
                        <kbd>K</kbd> Move files or diff lines
                      </span>
                      <span>
                        <kbd>V</kbd> Select lines in diff mode
                      </span>
                      <span>
                        <kbd>Ctrl+D</kbd>
                        <kbd>Ctrl+U</kbd> Half-page
                      </span>
                      <span>
                        <kbd>gg</kbd>
                        <kbd>G</kbd> First or last line
                      </span>
                      <span>
                        <kbd>C</kbd> Comment on selected lines
                      </span>
                      <span>
                        <kbd>A</kbd> Approve in diff mode
                      </span>
                    </>
                  ) : (
                    <>
                      <span>
                        <kbd>J</kbd>
                        <kbd>K</kbd> Next or previous file
                      </span>
                      <span>
                        <kbd>C</kbd> Comment on selected lines
                      </span>
                    </>
                  )}
                  <span>
                    <kbd>/</kbd> Search this diff
                  </span>
                  <span>
                    <kbd>G</kbd> Go to a visible line
                  </span>
                  <span>
                    <kbd>[</kbd>
                    <kbd>]</kbd> Toggle side panels
                  </span>
                </div>
              </details>
            </div>
          </div>
        </aside>

        {filePanelOpen && filePanelOverlay ? (
          <button
            aria-label="Close changed files panel"
            className="file-panel-scrim"
            onClick={() => closeFilePanel()}
            type="button"
          />
        ) : null}

        <section
          className="diff-workspace"
          id="diff-content"
          inert={
            (filePanelOverlay && filePanelOpen) ||
            (reviewPanelOverlay && reviewPanelOpen)
              ? true
              : undefined
          }
          tabIndex={-1}
        >
          {!filePanelOpen && !activeFile ? (
            <button
              aria-controls="changed-files-panel"
              aria-expanded="false"
              aria-label="Open changed files panel"
              className="file-panel-toggle file-panel-toggle-floating"
              onClick={() => openFilePanel(true)}
              ref={filePanelToggleRef}
              title="Open changed files panel ([)"
              type="button"
            >
              <LeftPanelIcon />
              Files
              <span>{workspace.counts.total}</span>
            </button>
          ) : null}
          {activeFile ? (
            <>
              <header className="diff-toolbar">
                <div className="active-file-heading">
                  {!filePanelOpen ? (
                    <button
                      aria-controls="changed-files-panel"
                      aria-expanded="false"
                      aria-label="Open changed files panel"
                      className="file-panel-toggle"
                      onClick={() => openFilePanel(true)}
                      ref={filePanelToggleRef}
                      title="Open changed files panel ([)"
                      type="button"
                    >
                      <LeftPanelIcon />
                      Files
                      <span>{workspace.counts.total}</span>
                    </button>
                  ) : null}
                  <div className="file-breadcrumb">
                    {activeFile.directory ? (
                      <span>{activeFile.directory} /</span>
                    ) : null}
                    <strong>{activeFile.name}</strong>
                  </div>
                  <div className="active-file-meta">
                    <span className="change-kind">
                      {changeLabel(activeFile)}
                    </span>
                    {displayedDiff ? (
                      <>
                        <span className="added-stat">
                          +{displayedDiff.stats.additions}
                        </span>
                        <span className="deleted-stat">
                          −{displayedDiff.stats.deletions}
                        </span>
                      </>
                    ) : null}
                    {activeFile.reviewStatus === "changed" ? (
                      <span className="changed-warning">
                        Changed since approval
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="diff-tools">
                  <div className="diff-search-control">
                    {lineJumpOpen ? (
                      <label className="diff-search line-jump">
                        <span aria-hidden="true" className="line-jump-mark">
                          #
                        </span>
                        <span className="visually-hidden">
                          Go to visible diff line
                        </span>
                        <input
                          aria-describedby={
                            lineJumpError ? "line-jump-error" : undefined
                          }
                          aria-invalid={lineJumpError ? true : undefined}
                          inputMode="numeric"
                          onChange={(event) => {
                            setLineJumpValue(event.target.value);
                            setLineJumpError("");
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              submitLineJump();
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              exitToDiff();
                            }
                          }}
                          placeholder="Visible line"
                          ref={lineJumpRef}
                          value={lineJumpValue}
                        />
                        {lineJumpError ? (
                          <span
                            className="line-jump-status"
                            id="line-jump-error"
                            role="alert"
                          >
                            Not visible
                          </span>
                        ) : (
                          <kbd>Enter</kbd>
                        )}
                      </label>
                    ) : (
                      <label className="diff-search">
                        <span className="visually-hidden">
                          Search this diff
                        </span>
                        <SearchIcon />
                        <input
                          onChange={(event) =>
                            setDiffSearch(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              diffViewRef.current?.navigateSearch(
                                event.shiftKey ? -1 : 1,
                              );
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              diffViewRef.current?.focusCurrentLine();
                              setDiffSearch("");
                            }
                          }}
                          placeholder="Find in diff"
                          ref={diffSearchRef}
                          value={diffSearch}
                        />
                        {diffSearch ? (
                          <span
                            aria-live="polite"
                            className="diff-search-count"
                          >
                            {diffSearchStatus.total
                              ? `${diffSearchStatus.current}/${diffSearchStatus.total}`
                              : "0/0"}
                          </span>
                        ) : null}
                      </label>
                    )}
                    {!lineJumpOpen && diffSearch ? (
                      <div className="diff-search-nav">
                        <button
                          aria-label="Previous diff match"
                          disabled={diffSearchStatus.total === 0}
                          onClick={() =>
                            diffViewRef.current?.navigateSearch(-1)
                          }
                          type="button"
                        >
                          <PreviousIcon />
                        </button>
                        <button
                          aria-label="Next diff match"
                          disabled={diffSearchStatus.total === 0}
                          onClick={() => diffViewRef.current?.navigateSearch(1)}
                          type="button"
                        >
                          <NextIcon />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div
                    className="layout-switch"
                    aria-label="Diff layout"
                    role="group"
                  >
                    <button
                      aria-pressed={layout === "adaptive"}
                      onClick={() => setLayout("adaptive")}
                      type="button"
                    >
                      Adaptive
                    </button>
                    <button
                      aria-pressed={layout === "unified"}
                      onClick={() => setLayout("unified")}
                      type="button"
                    >
                      Unified
                    </button>
                  </div>
                  {settings.keyboardLayout === "vim" ? (
                    <button
                      aria-pressed={vimDiffMode}
                      className="vim-mode-button"
                      data-visual={vimVisualMode}
                      onClick={() => {
                        if (vimDiffMode) {
                          setVimDiffMode(false);
                          setVimVisualMode(false);
                          setSelectedLines([]);
                        } else {
                          setVimDiffMode(true);
                          setVimVisualMode(false);
                          diffViewRef.current?.focusCurrentLine();
                        }
                      }}
                      title="Toggle Vim diff navigation"
                      type="button"
                    >
                      {vimVisualMode
                        ? "Vim · Visual"
                        : vimDiffMode
                          ? "Vim · Normal"
                          : "Enter Vim"}
                    </button>
                  ) : null}
                  <button
                    aria-expanded={reviewPanelOpen}
                    className="review-panel-toggle"
                    data-active={reviewPanelOpen}
                    onClick={() =>
                      reviewPanelOpen
                        ? closeReviewPanel(false)
                        : openReviewPanel("panel")
                    }
                    ref={reviewToggleRef}
                    title="Toggle snapshot and comments panel (])"
                    type="button"
                  >
                    <SnapshotIcon />
                    Snapshot
                    <span>{workspace.counts.needsReview}</span>
                  </button>
                  <button
                    className="defer-file-button"
                    disabled={
                      !displayedDiff ||
                      activeFileDeferred ||
                      displayedDiff.reviewStatus === "approved"
                    }
                    onClick={() => void deferFile()}
                    type="button"
                  >
                    Defer file
                  </button>
                  <button
                    className="approve-file-button"
                    disabled={
                      !displayedDiff ||
                      activeFileDeferred ||
                      displayedDiff.reviewStatus === "approved" ||
                      approving === "file"
                    }
                    onClick={() => void approveFile()}
                    ref={approveFileButtonRef}
                    type="button"
                  >
                    <CheckIcon />
                    {approving === "file"
                      ? "Approving file"
                      : displayedDiff?.reviewStatus === "approved"
                        ? "File approved"
                        : "Approve file"}
                  </button>
                </div>
              </header>

              {settings.keyboardLayout === "vim" && vimDiffMode ? (
                <div
                  aria-live="polite"
                  className="vim-mode-guide"
                  role="status"
                >
                  <strong>{vimVisualMode ? "Visual line" : "Normal"}</strong>
                  <span>
                    <kbd>J</kbd>
                    <kbd>K</kbd> move
                  </span>
                  <span>
                    <kbd>Ctrl+D</kbd>
                    <kbd>Ctrl+U</kbd> page
                  </span>
                  <span>
                    <kbd>gg</kbd>
                    <kbd>G</kbd> ends
                  </span>
                  <span>
                    <kbd>V</kbd> {vimVisualMode ? "finish selection" : "select"}
                  </span>
                  <span>
                    <kbd>C</kbd> comment
                  </span>
                  <span>
                    <kbd>A</kbd> approve
                  </span>
                  <span>
                    <kbd>Esc</kbd> exit
                  </span>
                </div>
              ) : null}

              {reviewHintVisible && displayedDiff ? (
                <div className="review-hint" role="note">
                  <CommentIcon />
                  <span>
                    <strong>Select line numbers to leave a note.</strong>
                    {settings.keyboardLayout === "vim"
                      ? "Press Enter over the diff for Vim navigation, or / to search. On a narrow screen, swipe code sideways to inspect long lines."
                      : "Use J and K to move between files, or / to search. On a narrow screen, swipe code sideways to inspect long lines."}
                  </span>
                  <button onClick={dismissReviewHint} type="button">
                    Got it
                  </button>
                </div>
              ) : null}

              {actionError ? (
                <div className="action-error" role="alert">
                  {actionError}
                </div>
              ) : null}
              {draftInvalidationNotice ? (
                <div className="draft-invalidation-notice" role="status">
                  <span>{draftInvalidationNotice}</span>
                  <button
                    onClick={() => setDraftInvalidationNotice("")}
                    type="button"
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
              {diffLoading ? (
                <div className="diff-loading" aria-label="Loading file diff">
                  {Array.from({ length: 14 }, (_, index) => (
                    <span
                      className="skeleton skeleton-code"
                      key={index}
                      style={{ width: `${44 + ((index * 19) % 50)}%` }}
                    />
                  ))}
                </div>
              ) : displayedDiff ? (
                <div
                  className="diff-scroll"
                  data-vim-mode={
                    settings.keyboardLayout === "vim" && vimDiffMode
                  }
                >
                  {displayedDiff.truncated ? (
                    <p className="truncated-notice">
                      Showing the first 5 MB of this file.
                    </p>
                  ) : null}
                  <DiffView
                    canExpandContext={contextLines < 20}
                    diff={displayedDiff}
                    onExpandContext={() =>
                      setContextLines((current) => (current < 8 ? 8 : 20))
                    }
                    onSearchStatusChange={setDiffSearchStatus}
                    onSelectionChange={(lines) => {
                      setSelectedLines(lines);
                      setCommentBody("");
                    }}
                    search={diffSearch}
                    selectedLines={selectedLines}
                    ref={diffViewRef}
                    vimMode={settings.keyboardLayout === "vim" && vimDiffMode}
                    view={layout}
                  />
                </div>
              ) : (
                <div className="diff-error-empty">
                  <strong>Diff unavailable.</strong>
                  <span>
                    {actionError ||
                      "Refresh the workspace and choose the file again."}
                  </span>
                  <button onClick={() => void loadDiff()} type="button">
                    Retry diff
                  </button>
                </div>
              )}
              {selectedLines.length > 0 && !reviewPanelOpen ? (
                <div className="line-selection-toolbar" role="status">
                  <strong>{selectionLabel(selectedLines)}</strong>
                  <span>
                    {settings.keyboardLayout === "vim" && vimDiffMode
                      ? "J/K extends in Visual line"
                      : "Shift extends, Ctrl or Cmd toggles"}
                  </span>
                  <button onClick={() => setSelectedLines([])} type="button">
                    Clear
                  </button>
                  <button
                    aria-keyshortcuts="c"
                    className="selection-comment-button"
                    onClick={() => openReviewPanel("composer")}
                    title="Comment on selected lines (C)"
                    type="button"
                  >
                    <CommentIcon /> Comment <kbd aria-hidden="true">C</kbd>
                  </button>
                </div>
              ) : null}
              {pendingCommentDeletion ? (
                <div className="comment-delete-undo" role="status">
                  <span>
                    Review note removed from{" "}
                    <strong>{pendingCommentDeletion.comment.path}</strong>.
                  </span>
                  <button autoFocus onClick={undoCommentDeletion} type="button">
                    Undo
                  </button>
                </div>
              ) : null}
            </>
          ) : workspace.files.length === 0 &&
            workspace.deferredFiles.length > 0 ? (
            <div className="clean-workspace-state">
              <p className="eyebrow">Deferred queue</p>
              <h2>All changed files are deferred.</h2>
              <p>
                Choose a deferred file from the sidebar to inspect or restore
                it.
              </p>
            </div>
          ) : workspace.files.length === 0 ? (
            <div className="clean-workspace-state">
              <span className="clean-mark">
                <CheckIcon />
              </span>
              <p className="eyebrow">Working tree</p>
              <h2>No local changes.</h2>
              <p>
                Redline is watching this checkout. Modified files will appear
                here without a browser upload.
              </p>
              <button onClick={() => void loadWorkspace(true)} type="button">
                <RefreshIcon /> Check again
              </button>
            </div>
          ) : (
            <div className="clean-workspace-state">
              <span className="clean-mark">
                <CheckIcon />
              </span>
              <p className="eyebrow">Snapshot holds</p>
              <h2>Everything visible is still approved.</h2>
              <p>
                Choose Approved or All to revisit a file. If its bytes change,
                it returns to Needs review.
              </p>
            </div>
          )}
        </section>

        <aside
          aria-label="Snapshot and comments"
          aria-modal={reviewPanelOverlay && reviewPanelOpen ? true : undefined}
          className="approval-ledger"
          data-open={reviewPanelOpen}
          inert={filePanelOverlay && filePanelOpen ? true : undefined}
          onKeyDown={reviewPanelOverlay ? trapOverlayFocus : undefined}
          ref={reviewPanelRef}
          role={reviewPanelOverlay ? "dialog" : undefined}
          tabIndex={-1}
        >
          <div className="ledger-heading">
            <div>
              <p className="rail-label">Approval ledger</p>
              <h2>
                {workspace.latestSnapshot
                  ? "Current snapshot"
                  : "No snapshot yet"}
              </h2>
            </div>
            <span
              className="ledger-status"
              data-state={
                workspace.latestSnapshot?.changedCount ? "changed" : "current"
              }
            >
              {workspace.latestSnapshot?.changedCount
                ? `${workspace.latestSnapshot.changedCount} changed`
                : workspace.latestSnapshot
                  ? "Holds"
                  : "Open"}
            </span>
            <button
              aria-label="Collapse review panel"
              className="close-ledger-button"
              onClick={() => closeReviewPanel()}
              title="Collapse review panel (])"
              type="button"
            >
              <RightPanelIcon />
            </button>
          </div>

          <div className="snapshot-status">
            {workspace.latestSnapshot ? (
              workspace.latestSnapshot.changedCount > 0 ? (
                <>
                  <strong>
                    {workspace.latestSnapshot.changedCount} file
                    {workspace.latestSnapshot.changedCount === 1
                      ? ""
                      : "s"}{" "}
                    changed since approval.
                  </strong>
                  <p>Only those files need another look.</p>
                </>
              ) : (
                <>
                  <strong>Snapshot holds.</strong>
                  <p>
                    {workspace.latestSnapshot.unchangedCount} approved file
                    {workspace.latestSnapshot.unchangedCount === 1
                      ? ""
                      : "s"}{" "}
                    remain unchanged.
                  </p>
                </>
              )
            ) : (
              <>
                <strong>Approve a point in time.</strong>
                <p>
                  Redline will remember the exact file fingerprints you
                  reviewed.
                </p>
              </>
            )}
          </div>

          <dl className="ledger-facts">
            <div>
              <dt>Needs review</dt>
              <dd>{workspace.counts.needsReview}</dd>
            </div>
            <div>
              <dt>Still approved</dt>
              <dd>{workspace.counts.approved}</dd>
            </div>
            <div>
              <dt>Last approved</dt>
              <dd>
                {formatRelativeTime(workspace.latestSnapshot?.approvedAt)}
              </dd>
            </div>
          </dl>

          <button
            className="snapshot-button"
            disabled={workspace.files.length === 0 || approving === "snapshot"}
            onClick={() => void approveSnapshot()}
            type="button"
          >
            <span>
              <CheckIcon />
            </span>
            <span>
              <strong>
                {approving === "snapshot"
                  ? "Approving snapshot"
                  : "Approve current snapshot"}
              </strong>
              <small>Does not stage or commit</small>
            </span>
            <ChevronIcon />
          </button>

          <section
            aria-busy={githubRefreshing}
            className="github-import"
            aria-label="GitHub review comments"
          >
            <div>
              <p className="rail-label">GitHub</p>
              <h2>
                {githubStatus?.repository && githubStatus.pullRequest
                  ? `${githubStatus.repository} #${githubStatus.pullRequest}`
                  : "Pull request comments"}
              </h2>
            </div>
            <p aria-live="polite">
              {githubStatus?.message ?? "Discovering matching pull request…"}
            </p>
            {githubStatus?.state === "available" ||
            githubStatus?.state === "failed" ? (
              <button
                disabled={githubRefreshing}
                onClick={() => void refreshGitHubComments()}
                type="button"
              >
                <RefreshIcon />
                {githubRefreshing
                  ? "Synchronizing"
                  : githubStatus.retained
                    ? "Refresh GitHub comments"
                    : "Import GitHub comments"}
              </button>
            ) : null}
            {githubStatus &&
            githubStatus.state !== "available" &&
            githubStatus.state !== "failed" &&
            githubStatus.state !== "none" ? (
              <button
                disabled={githubRefreshing}
                onClick={() => void retryGithubDiscovery()}
                type="button"
              >
                <RefreshIcon /> Retry discovery
              </button>
            ) : null}
            {githubStatus?.lastSuccessAt ? (
              <small>
                Last synchronized{" "}
                {formatRelativeTime(githubStatus.lastSuccessAt)}
              </small>
            ) : null}
          </section>

          <section className="comments-section" aria-label="Review comments">
            <div className="comments-heading">
              <div>
                <p className="rail-label">Comments</p>
                <h2>{displayedDiff?.comments.length ?? 0} on this file</h2>
              </div>
              <button
                className="copy-comments-button"
                disabled={
                  workspace.counts.comments +
                    workspace.deferredFiles.reduce(
                      (total, file) => total + file.commentCount,
                      0,
                    ) ===
                    0 && !githubStatus?.retained
                }
                onClick={() => void copyComments()}
                type="button"
              >
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Copy failed"
                    : "Copy all"}
              </button>
            </div>

            {selectedLines.length > 0 ? (
              <form
                className="comment-composer"
                onSubmit={(event) => void addComment(event)}
              >
                <label htmlFor="comment-body">
                  {selectionLabel(selectedLines)}
                </label>
                <textarea
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  id="comment-body"
                  onChange={(event) => setCommentBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.ctrlKey || event.metaKey) &&
                      commentBody.trim() &&
                      !savingComment
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Leave a local review note"
                  ref={commentTextareaRef}
                  rows={4}
                  value={commentBody}
                />
                <p className="composer-shortcut">
                  <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> saves
                </p>
                <div>
                  <button
                    className="text-button"
                    onClick={() => setSelectedLines([])}
                    type="button"
                  >
                    Clear selection
                  </button>
                  <button
                    className="save-comment-button"
                    disabled={!commentBody.trim() || savingComment}
                    type="submit"
                  >
                    {savingComment ? "Saving note" : "Save note"}
                  </button>
                </div>
              </form>
            ) : null}

            <div className="comment-list">
              {displayedDiff?.comments.map((comment) => (
                <article
                  className="review-comment"
                  data-outdated={comment.outdated}
                  data-source={comment.source ?? "local"}
                  data-thread-state={comment.state}
                  key={comment.id}
                >
                  <header>
                    {comment.author ? (
                      <AuthorBadge author={comment.author} />
                    ) : null}
                    <span>
                      {comment.outdated
                        ? `Was ${commentLineLabel(comment)}`
                        : commentLineLabel(comment)}
                    </span>
                    {comment.outdated ? (
                      <em>Stale anchor</em>
                    ) : (
                      <time>{formatRelativeTime(comment.createdAt)}</time>
                    )}
                  </header>
                  {comment.source === "github" ? (
                    <>
                      <div className="github-markdown">
                        <MarkdownBody value={comment.body} />
                      </div>
                      <p className="github-thread-meta">
                        <a
                          href={comment.github?.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          View on GitHub
                        </a>
                        <span>Read-only</span>
                        {comment.github?.mapping !== "mapped" ? (
                          <span>
                            Anchor unavailable: {comment.github?.unmappedReason}
                          </span>
                        ) : null}
                      </p>
                    </>
                  ) : (
                    <p>
                      {comment.deleted
                        ? "Original note deleted."
                        : comment.body}
                    </p>
                  )}
                  <p
                    className="thread-state"
                    aria-label={`Thread state: ${comment.state ?? "pending"}`}
                  >
                    {!comment.state || comment.state === "pending"
                      ? "Pending review"
                      : `Thread ${comment.state}`}
                  </p>
                  {comment.replies.length > 0 ? (
                    <ol className="thread-replies" aria-label="Thread replies">
                      {comment.replies.map((reply) => (
                        <li key={reply.id}>
                          <div>
                            {reply.author ? (
                              <AuthorBadge author={reply.author} />
                            ) : (
                              <strong>
                                {reply.actor === "agent"
                                  ? "Agent"
                                  : reply.actor === "user"
                                    ? "You"
                                    : reply.actor}
                              </strong>
                            )}
                            {reply.decision ? (
                              <span>{reply.decision}</span>
                            ) : null}
                            <time>{formatRelativeTime(reply.createdAt)}</time>
                          </div>
                          {comment.source === "github" ? (
                            <>
                              <div className="github-markdown">
                                <MarkdownBody value={reply.body} />
                              </div>
                              {reply.url ? (
                                <a
                                  href={reply.url}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  View reply on GitHub
                                </a>
                              ) : null}
                            </>
                          ) : (
                            <p>{reply.body}</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {comment.outdated ? (
                    <p className="stale-comment-note">
                      {comment.source === "github"
                        ? "This GitHub thread is outdated or cannot be mapped uniquely to the displayed diff."
                        : "The file changed after this note. It stays on the reviewed version and is not attached to the current line."}
                    </p>
                  ) : null}
                  {!comment.deleted && !comment.readOnly ? (
                    <button
                      onClick={() => scheduleCommentDeletion(comment)}
                      type="button"
                    >
                      Delete note
                    </button>
                  ) : null}
                </article>
              )) ?? null}
              {displayedDiff &&
              displayedDiff.comments.length === 0 &&
              selectedLines.length === 0 ? (
                <p className="comments-empty">
                  Select line numbers to leave a local note.
                </p>
              ) : null}
            </div>
          </section>

          <p className="local-promise">
            <LockIcon /> Files and review state stay on this machine.
          </p>
        </aside>
      </div>
    </main>
  );
}

function WorkspaceForm({
  error,
  loading,
  onSubmit,
  path,
  setPath,
}: {
  error: string;
  loading: boolean;
  onSubmit: (event: FormEvent) => void;
  path: string;
  setPath: (path: string) => void;
}) {
  return (
    <form className="open-workspace-form" onSubmit={onSubmit}>
      <label htmlFor="open-workspace-path">Local repository path</label>
      <div>
        <input
          aria-describedby={error ? "workspace-path-error" : undefined}
          id="open-workspace-path"
          onChange={(event) => setPath(event.target.value)}
          placeholder="/home/you/code/project"
          spellCheck={false}
          value={path}
        />
        <button disabled={loading || !path.trim()} type="submit">
          {loading ? "Opening workspace" : "Open workspace"}
        </button>
      </div>
      {error ? (
        <p id="workspace-path-error" role="alert">
          {error}
        </p>
      ) : null}
      <span>
        Only the path is sent to Redline's localhost service. Browser file
        upload is not used.
      </span>
    </form>
  );
}
