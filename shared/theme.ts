export const THEME_COLOR_ROLES = [
  "canvas",
  "paper",
  "paperDeep",
  "paperHover",
  "ink",
  "inkSoft",
  "inkMuted",
  "line",
  "lineStrong",
  "accent",
  "accentStrong",
  "accentSoft",
  "accentQuiet",
  "success",
  "successSoft",
  "warning",
  "warningSoft",
  "added",
  "addedStrong",
  "removed",
  "removedStrong",
  "moved",
  "focus",
  "onAccent",
  "syntaxText",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxType",
  "syntaxFunction",
  "syntaxString",
  "syntaxNumber",
  "syntaxConstant",
  "syntaxProperty",
  "syntaxTag",
  "syntaxOperator",
  "syntaxInvalid",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeColors = Record<ThemeColorRole, string>;
export type ThemePresetId = "redline" | "dusk" | "paper";

export interface ThemePreference {
  version: 1;
  preset: ThemePresetId;
  overrides: Partial<Record<ThemeColorRole, string>>;
}

export interface ThemePreset {
  id: ThemePresetId;
  name: string;
  description: string;
  colorScheme: "dark" | "light";
  colors: ThemeColors;
}

export interface ThemeMatrixEntry {
  id: string;
  foreground: ThemeColorRole;
  background: ThemeColorRole;
  classification: "essential" | "warning";
  criterion: "WCAG 1.4.3" | "WCAG 1.4.11";
  threshold: number;
  textAssumption: "normal text" | "non-text UI";
  compositing: "foreground over background; translucent background over canvas";
  nonColorCue?: string;
}

export interface ThemeFinding extends ThemeMatrixEntry {
  ratio: number;
}

export interface ThemeEvaluation {
  valid: boolean;
  errors: ThemeFinding[];
  warnings: ThemeFinding[];
}

const redlineColors: ThemeColors = {
  canvas: "#191a1f",
  paper: "#202126",
  paperDeep: "#2b2c33",
  paperHover: "#33343c",
  ink: "#e5e5e9",
  inkSoft: "#c2c3ca",
  inkMuted: "#a7a9b2",
  line: "#4a4c56",
  lineStrong: "#6a6d79",
  accent: "#a52f3d",
  accentStrong: "#ff7b87",
  accentSoft: "#4a252b",
  accentQuiet: "#2e2024",
  success: "#7ed69e",
  successSoft: "#243c2d",
  warning: "#c5a2ff",
  warningSoft: "#342947",
  added: "#1d2b22",
  addedStrong: "#4d8c62",
  removed: "#332125",
  removedStrong: "#a35460",
  moved: "#382d4c",
  focus: "#ff7b87",
  onAccent: "#fff5f5",
  syntaxText: "#d1d2d8",
  syntaxComment: "#a6adbd",
  syntaxKeyword: "#c6a8ee",
  syntaxType: "#8fc8d8",
  syntaxFunction: "#e1c387",
  syntaxString: "#95c7a2",
  syntaxNumber: "#dfa88c",
  syntaxConstant: "#d9a3c5",
  syntaxProperty: "#9bc0d7",
  syntaxTag: "#d59a9b",
  syntaxOperator: "#b8bac3",
  syntaxInvalid: "#ff8f98",
};

export const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  redline: {
    id: "redline",
    name: "Redline",
    description: "The quiet graphite proof desk.",
    colorScheme: "dark",
    colors: redlineColors,
  },
  dusk: {
    id: "dusk",
    name: "Dusk",
    description: "Warm charcoal with amber proof marks.",
    colorScheme: "dark",
    colors: {
      ...redlineColors,
      canvas: "#1d1917",
      paper: "#26211e",
      paperDeep: "#322b27",
      paperHover: "#3b332e",
      ink: "#eee7df",
      inkSoft: "#d0c4b8",
      inkMuted: "#b5a79a",
      line: "#554b43",
      lineStrong: "#786c61",
      accent: "#8f4b18",
      accentStrong: "#ffad62",
      accentSoft: "#49301f",
      accentQuiet: "#2e241d",
      focus: "#ffad62",
      onAccent: "#fff8ef",
      syntaxText: "#ded5cc",
      syntaxComment: "#b6aa9f",
      syntaxKeyword: "#d9a5bd",
      syntaxType: "#8fc6c1",
      syntaxFunction: "#e1bd78",
      syntaxString: "#9ac18e",
      syntaxNumber: "#e3a27f",
      syntaxConstant: "#cfa4cf",
      syntaxProperty: "#9ebbd0",
      syntaxTag: "#dc9b88",
      syntaxOperator: "#c2b7ad",
      syntaxInvalid: "#ff9589",
    },
  },
  paper: {
    id: "paper",
    name: "Paper",
    description: "A bright neutral desk for daylight review.",
    colorScheme: "light",
    colors: {
      canvas: "#f4f2ee",
      paper: "#ebe8e2",
      paperDeep: "#ddd9d1",
      paperHover: "#d3cec5",
      ink: "#242326",
      inkSoft: "#444248",
      inkMuted: "#605d65",
      line: "#aaa59d",
      lineStrong: "#77736d",
      accent: "#a12b38",
      accentStrong: "#821f2c",
      accentSoft: "#f2d9dc",
      accentQuiet: "#eadfe0",
      success: "#176538",
      successSoft: "#d7e9dc",
      warning: "#67409a",
      warningSoft: "#e5dcf0",
      added: "#dfebe2",
      addedStrong: "#477657",
      removed: "#f1dfe1",
      removedStrong: "#98515b",
      moved: "#e5dded",
      focus: "#821f2c",
      onAccent: "#fff7f7",
      syntaxText: "#343238",
      syntaxComment: "#5e626b",
      syntaxKeyword: "#70439b",
      syntaxType: "#176477",
      syntaxFunction: "#765208",
      syntaxString: "#27683c",
      syntaxNumber: "#8a401c",
      syntaxConstant: "#853d6a",
      syntaxProperty: "#315e7a",
      syntaxTag: "#943d42",
      syntaxOperator: "#4f4c54",
      syntaxInvalid: "#9c1727",
    },
  },
};

for (const preset of Object.values(THEME_PRESETS)) {
  Object.freeze(preset.colors);
  Object.freeze(preset);
}
Object.freeze(THEME_PRESETS);

export const DEFAULT_THEME_PREFERENCE: ThemePreference = Object.freeze({
  version: 1,
  preset: "redline",
  overrides: Object.freeze({}),
});

const normalText = (
  foreground: ThemeColorRole,
  background: ThemeColorRole,
): ThemeMatrixEntry => ({
  id: `${foreground}-on-${background}`,
  foreground,
  background,
  classification: "essential",
  criterion: "WCAG 1.4.3",
  threshold: 4.5,
  textAssumption: "normal text",
  compositing: "foreground over background; translucent background over canvas",
});

const nonText = (
  foreground: ThemeColorRole,
  background: ThemeColorRole,
): ThemeMatrixEntry => ({
  id: `${foreground}-on-${background}`,
  foreground,
  background,
  classification: "essential",
  criterion: "WCAG 1.4.11",
  threshold: 3,
  textAssumption: "non-text UI",
  compositing: "foreground over background; translucent background over canvas",
});

const warning = (
  foreground: ThemeColorRole,
  background: ThemeColorRole,
  nonColorCue: string,
): ThemeMatrixEntry => ({
  ...nonText(foreground, background),
  classification: "warning",
  nonColorCue,
});

export const THEME_VALIDATION_MATRIX: readonly ThemeMatrixEntry[] = [
  normalText("ink", "canvas"),
  normalText("inkSoft", "paper"),
  normalText("inkMuted", "paper"),
  normalText("onAccent", "accent"),
  normalText("success", "successSoft"),
  normalText("warning", "warningSoft"),
  nonText("lineStrong", "paper"),
  nonText("focus", "canvas"),
  nonText("accentStrong", "paper"),
  warning("paper", "canvas", "Structural rails also use a one-pixel boundary."),
  warning(
    "paperDeep",
    "paper",
    "Selected surfaces include borders and state text.",
  ),
  warning(
    "paperHover",
    "paper",
    "Hover state is also exposed by pointer position.",
  ),
  warning("line", "paper", "Quiet dividers separate already grouped regions."),
  warning(
    "accentSoft",
    "paper",
    "Accent washes always include a text or icon label.",
  ),
  warning(
    "accentQuiet",
    "paper",
    "Selected filters expose aria-pressed state.",
  ),
  warning(
    "added",
    "canvas",
    "Added lines include a plus marker and line metadata.",
  ),
  warning(
    "addedStrong",
    "added",
    "Added lines include a plus marker and Add label.",
  ),
  warning(
    "removed",
    "canvas",
    "Removed lines include a minus marker and line metadata.",
  ),
  warning(
    "removedStrong",
    "removed",
    "Removed lines include a minus marker and Remove label.",
  ),
  warning(
    "moved",
    "canvas",
    "Moved/search state includes text and location context.",
  ),
  ...(
    [
      "syntaxText",
      "syntaxComment",
      "syntaxKeyword",
      "syntaxType",
      "syntaxFunction",
      "syntaxString",
      "syntaxNumber",
      "syntaxConstant",
      "syntaxProperty",
      "syntaxTag",
      "syntaxOperator",
      "syntaxInvalid",
    ] as const
  ).map((role) => normalText(role, "canvas")),
];

interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function parseHexColor(value: string): Rgba | null {
  const match = value
    .trim()
    .match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!match) return null;
  let hex = match[1].toLowerCase();
  if (hex.length === 3 || hex.length === 4)
    hex = [...hex].map((character) => character + character).join("");
  if (hex.length === 6) hex += "ff";
  return {
    red: Number.parseInt(hex.slice(0, 2), 16) / 255,
    green: Number.parseInt(hex.slice(2, 4), 16) / 255,
    blue: Number.parseInt(hex.slice(4, 6), 16) / 255,
    alpha: Number.parseInt(hex.slice(6, 8), 16) / 255,
  };
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  return {
    red:
      (foreground.red * foreground.alpha +
        background.red * background.alpha * (1 - foreground.alpha)) /
      alpha,
    green:
      (foreground.green * foreground.alpha +
        background.green * background.alpha * (1 - foreground.alpha)) /
      alpha,
    blue:
      (foreground.blue * foreground.alpha +
        background.blue * background.alpha * (1 - foreground.alpha)) /
      alpha,
    alpha,
  };
}

function luminance(color: Rgba) {
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * linear(color.red) +
    0.7152 * linear(color.green) +
    0.0722 * linear(color.blue)
  );
}

export function contrastRatio(
  foregroundValue: string,
  backgroundValue: string,
  canvasValue = "#ffffff",
) {
  const foreground = parseHexColor(foregroundValue);
  const background = parseHexColor(backgroundValue);
  const canvas = parseHexColor(canvasValue);
  if (!foreground || !background || !canvas) return null;
  const opaqueCanvas = composite(canvas, {
    red: 1,
    green: 1,
    blue: 1,
    alpha: 1,
  });
  const renderedBackground = composite(background, opaqueCanvas);
  const renderedForeground = composite(foreground, renderedBackground);
  const first = luminance(renderedForeground);
  const second = luminance(renderedBackground);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function normalizeThemeColor(value: string) {
  return parseHexColor(value) ? value.trim().toLowerCase() : null;
}

export function resolveTheme(preference: ThemePreference): ThemeColors {
  return {
    ...THEME_PRESETS[preference.preset].colors,
    ...preference.overrides,
  };
}

export function evaluateTheme(colors: ThemeColors): ThemeEvaluation {
  const findings = THEME_VALIDATION_MATRIX.flatMap((entry) => {
    const ratio = contrastRatio(
      colors[entry.foreground],
      colors[entry.background],
      colors.canvas,
    );
    return ratio === null || ratio + Number.EPSILON < entry.threshold
      ? [{ ...entry, ratio: ratio ?? 0 }]
      : [];
  });
  const errors = findings.filter(
    (finding) => finding.classification === "essential",
  );
  const warnings = findings.filter(
    (finding) => finding.classification === "warning",
  );
  return { valid: errors.length === 0, errors, warnings };
}

export function parseThemePreference(value: unknown): ThemePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["version", "preset", "overrides"].includes(key),
    )
  )
    return null;
  if (
    record.version !== 1 ||
    typeof record.preset !== "string" ||
    !Object.hasOwn(THEME_PRESETS, record.preset)
  )
    return null;
  if (
    !record.overrides ||
    typeof record.overrides !== "object" ||
    Array.isArray(record.overrides)
  )
    return null;
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, rawColor] of Object.entries(record.overrides)) {
    if (
      !THEME_COLOR_ROLES.includes(role as ThemeColorRole) ||
      typeof rawColor !== "string"
    )
      return null;
    const color = normalizeThemeColor(rawColor);
    if (!color) return null;
    overrides[role as ThemeColorRole] = color;
  }
  const preference = {
    version: 1,
    preset: record.preset as ThemePresetId,
    overrides,
  } satisfies ThemePreference;
  return evaluateTheme(resolveTheme(preference)).valid ? preference : null;
}

export function themeCssVariables(
  preference: ThemePreference,
): Record<string, string> {
  const colors = resolveTheme(preference);
  return Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => [
      `--${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      colors[role],
    ]),
  );
}
