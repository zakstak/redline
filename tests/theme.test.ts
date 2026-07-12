import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR_ROLES,
  THEME_PRESETS,
  THEME_VALIDATION_MATRIX,
  contrastRatio,
  evaluateTheme,
  parseThemePreference,
  resolveTheme,
  themeCssVariables,
} from "../shared/theme.js";

describe("theme contract", () => {
  it("covers every customizable role in the validation matrix", () => {
    const covered = new Set(
      THEME_VALIDATION_MATRIX.flatMap((entry) => [
        entry.foreground,
        entry.background,
      ]),
    );
    expect(THEME_COLOR_ROLES.every((role) => covered.has(role))).toBe(true);
  });

  it("keeps every immutable preset above all essential thresholds", () => {
    for (const preset of Object.values(THEME_PRESETS)) {
      expect(evaluateTheme(preset.colors).errors, preset.name).toEqual([]);
    }
  });

  it("calculates opaque and translucent contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#00000080", "#ffffff")).toBeCloseTo(4, 2);
    expect(
      contrastRatio("#ffffff", "#00000080", "#00000080", true),
    ).toBeCloseTo(4.0041, 3);
  });

  it("requires primary and syntax text to remain readable on rendered surfaces", () => {
    const checks = new Set(
      THEME_VALIDATION_MATRIX.map(
        ({ foreground, background }) => `${foreground}:${background}`,
      ),
    );
    expect(checks).toContain("ink:paper");
    expect(checks).toContain("accent:paper");
    expect(checks).toContain("accentStrong:paper");
    expect(checks).toContain("onAccent:accentStrong");
    expect(checks).toContain("success:canvas");
    expect(checks).toContain("warning:paper");
    expect(checks).toContain("syntaxText:paper");
    expect(checks).toContain("syntaxText:added");
    expect(checks).toContain("syntaxComment:addedStrong");
    expect(checks).toContain("syntaxKeyword:removed");
    expect(checks).toContain("syntaxKeyword:removedStrong");
  });

  it("evaluates values immediately below, at, and above text and UI thresholds", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#959595", "#ffffff")).toBeLessThan(3);
    expect(contrastRatio("#949494", "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("rejects unknown, malformed, incomplete, and inaccessible preferences", () => {
    expect(
      parseThemePreference({ version: 2, preset: "redline", overrides: {} }),
    ).toBeNull();
    expect(
      parseThemePreference({ version: 1, preset: "unknown", overrides: {} }),
    ).toBeNull();
    expect(
      parseThemePreference({ version: 1, preset: "toString", overrides: {} }),
    ).toBeNull();
    expect(
      parseThemePreference({
        version: 1,
        preset: "redline",
        overrides: { ink: "nope" },
      }),
    ).toBeNull();
    expect(
      parseThemePreference({
        version: 1,
        preset: "redline",
        overrides: { ink: "#191a1f" },
      }),
    ).toBeNull();
    expect(parseThemePreference({ version: 1, preset: "redline" })).toBeNull();
  });

  it("resolves deterministic preset and override preferences", () => {
    const custom = parseThemePreference({
      version: 1,
      preset: "redline",
      overrides: { paperDeep: "#303139" },
    });
    expect(custom).not.toBeNull();
    expect(resolveTheme(custom!).paperDeep).toBe("#303139");
    expect(resolveTheme(DEFAULT_THEME_PREFERENCE)).toEqual(
      THEME_PRESETS.redline.colors,
    );
    expect(
      themeCssVariables(DEFAULT_THEME_PREFERENCE)["--syntax-keyword"],
    ).toBe(THEME_PRESETS.redline.colors.syntaxKeyword);
  });
});
