export const UI_FONT_OPTIONS = {
  system: {
    label: "System sans",
    stack:
      'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  humanist: {
    label: "Humanist sans",
    stack: '"Trebuchet MS", "Segoe UI", ui-sans-serif, sans-serif',
  },
  serif: {
    label: "System serif",
    stack: 'Charter, "Bitstream Charter", "Sitka Text", Georgia, serif',
  },
} as const;

export const CODE_FONT_OPTIONS = {
  system: {
    label: "System mono",
    stack: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
  },
  modern: {
    label: "Modern mono",
    stack: '"Cascadia Mono", "DejaVu Sans Mono", monospace',
  },
  compact: {
    label: "Compact mono",
    stack: 'Consolas, "Liberation Mono", monospace',
  },
} as const;

export type UiFontId = keyof typeof UI_FONT_OPTIONS;
export type CodeFontId = keyof typeof CODE_FONT_OPTIONS;

export const TYPOGRAPHY_SIZE_CONTRACT = {
  interface: { default: 14, min: 12, max: 18, step: 1, label: "Interface" },
  code: { default: 16, min: 12, max: 20, step: 1, label: "Code" },
} as const;

export interface TypographyPreference {
  version: 1;
  uiFont: UiFontId;
  codeFont: CodeFontId;
  interfaceFontSize: number;
  codeFontSize: number;
}

export const DEFAULT_TYPOGRAPHY_PREFERENCE: TypographyPreference =
  Object.freeze({
    version: 1,
    uiFont: "system",
    codeFont: "system",
    interfaceFontSize: TYPOGRAPHY_SIZE_CONTRACT.interface.default,
    codeFontSize: TYPOGRAPHY_SIZE_CONTRACT.code.default,
  });

function hasExactKeys(value: Record<string, unknown>) {
  return (
    Object.keys(value).sort().join(",") ===
    "codeFont,codeFontSize,interfaceFontSize,uiFont,version"
  );
}

function isSteppedSize(
  value: unknown,
  contract: { min: number; max: number; step: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= contract.min &&
    value <= contract.max &&
    (value - contract.min) % contract.step === 0
  );
}

export function parseTypographyPreference(
  value: unknown,
): TypographyPreference | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>)
  )
    return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.uiFont !== "string" ||
    !Object.hasOwn(UI_FONT_OPTIONS, candidate.uiFont) ||
    typeof candidate.codeFont !== "string" ||
    !Object.hasOwn(CODE_FONT_OPTIONS, candidate.codeFont) ||
    !isSteppedSize(
      candidate.interfaceFontSize,
      TYPOGRAPHY_SIZE_CONTRACT.interface,
    ) ||
    !isSteppedSize(candidate.codeFontSize, TYPOGRAPHY_SIZE_CONTRACT.code)
  )
    return null;
  return {
    version: 1,
    uiFont: candidate.uiFont as UiFontId,
    codeFont: candidate.codeFont as CodeFontId,
    interfaceFontSize: candidate.interfaceFontSize,
    codeFontSize: candidate.codeFontSize,
  };
}

export function typographyCssVariables(preference: TypographyPreference) {
  return {
    "--font-ui": UI_FONT_OPTIONS[preference.uiFont].stack,
    "--font-code": CODE_FONT_OPTIONS[preference.codeFont].stack,
    "--typography-ui-scale": String(
      preference.interfaceFontSize / TYPOGRAPHY_SIZE_CONTRACT.interface.default,
    ),
    "--typography-code-scale": String(
      preference.codeFontSize / TYPOGRAPHY_SIZE_CONTRACT.code.default,
    ),
  } as const;
}
