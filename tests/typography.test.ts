import { describe, expect, it } from "vitest";
import {
  CODE_FONT_OPTIONS,
  DEFAULT_TYPOGRAPHY_PREFERENCE,
  TYPOGRAPHY_SIZE_CONTRACT,
  UI_FONT_OPTIONS,
  parseTypographyPreference,
  typographyCssVariables,
} from "../shared/typography.js";

describe("typography preference", () => {
  it("defines offline fallback stacks and exact existing defaults", () => {
    expect(DEFAULT_TYPOGRAPHY_PREFERENCE).toEqual({
      version: 1,
      uiFont: "system",
      codeFont: "system",
      interfaceFontSize: 14,
      codeFontSize: 16,
    });
    for (const option of [
      ...Object.values(UI_FONT_OPTIONS),
      ...Object.values(CODE_FONT_OPTIONS),
    ]) {
      expect(option.stack).not.toMatch(/https?:|url\(/i);
      expect(option.stack).toMatch(/sans-serif|serif|monospace/);
    }
  });

  it.each([
    null,
    {},
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, version: 2 },
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, uiFont: "toString" },
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, codeFont: "unknown" },
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, interfaceFontSize: Number.NaN },
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, interfaceFontSize: 12.5 },
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, interfaceFontSize: 11 },
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, codeFontSize: 21 },
    { ...DEFAULT_TYPOGRAPHY_PREFERENCE, extra: true },
  ])("rejects malformed, unbounded, off-step, or unknown input %#", (value) => {
    expect(parseTypographyPreference(value)).toBeNull();
  });

  it("accepts every inclusive control bound and keeps scopes independent", () => {
    const preference = {
      ...DEFAULT_TYPOGRAPHY_PREFERENCE,
      uiFont: "serif" as const,
      codeFont: "modern" as const,
      interfaceFontSize: TYPOGRAPHY_SIZE_CONTRACT.interface.max,
      codeFontSize: TYPOGRAPHY_SIZE_CONTRACT.code.min,
    };
    expect(parseTypographyPreference(preference)).toEqual(preference);
    const variables = typographyCssVariables(preference);
    expect(variables["--font-ui"]).toBe(UI_FONT_OPTIONS.serif.stack);
    expect(variables["--font-code"]).toBe(CODE_FONT_OPTIONS.modern.stack);
    expect(variables["--typography-ui-scale"]).toBe(String(18 / 14));
    expect(variables["--typography-code-scale"]).toBe(String(12 / 16));
  });
});
