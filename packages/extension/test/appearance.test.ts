import { READER_CSS } from "@prstory/core";
import { describe, expect, it } from "vitest";
import { accentColors, appearanceVars, cleanFontName, DEFAULT_APPEARANCE, onAccent, styledCss, withAppearanceDefaults } from "../src/appearance";
import { withDefaults } from "../src/settings";

describe("appearance", () => {
  it("fills in older settings and repairs bad values", () => {
    expect(withDefaults({}).appearance).toEqual(DEFAULT_APPEARANCE);
    const a = withAppearanceDefaults({ theme: "neon" as never, accent: "red; }", textSize: 99, codeSize: Number.NaN, textFont: 'x"; } body { display:none', codeFont: " Fira   Code " });
    expect(a.theme).toBe("system");
    expect(a.accent).toBe("orange");
    expect(a.textSize).toBe(19);
    expect(a.codeSize).toBe(12.5);
    expect(a.textFont).toBe("");
    expect(a.codeFont).toBe("Fira Code");
    expect(withAppearanceDefaults({ accent: "#ABCDEF" }).accent).toBe("#abcdef");
  });

  it("allows only plain font names into the stylesheet", () => {
    expect(cleanFontName("JetBrains Mono")).toBe("JetBrains Mono");
    expect(cleanFontName("Source Han Sans 思源")).toBe("Source Han Sans 思源");
    for (const bad of ['Inter"', "a;b", "a{b}", "url(x)", "a\\b"]) expect(cleanFontName(bad)).toBe("");
  });

  it("puts readable text on the accent", () => {
    expect(onAccent("#c2410c")).toBe("#ffffff");
    expect(onAccent("#fb923c")).toBe("#1f1307");
    expect(onAccent("#ffff00")).toBe("#1f1307");
    expect(onAccent("#000080")).toBe("#ffffff");
    expect(accentColors("#123456")).toEqual({ light: "#123456", dark: "#123456" });
    expect(accentColors("blue").dark).toBe("#58a6ff");
  });

  it("sets fonts, sizes and diff colors as variables", () => {
    const v = appearanceVars({ ...DEFAULT_APPEARANCE, codeFont: "Fira Code", textSize: 17, diffColors: "blue-orange" }, false);
    expect(v["--mono"]).toMatch(/^"Fira Code", ui-monospace/);
    expect(v["--text-size"]).toBe("17px");
    expect(v["--add-ink"]).toBe("#0550ae");
  });

  it("follows the system, or pins the theme by rewriting dark-mode rules", () => {
    const system = styledCss(READER_CSS, DEFAULT_APPEARANCE);
    expect(system).toContain("@media (prefers-color-scheme: dark)");
    const light = styledCss(READER_CSS, { ...DEFAULT_APPEARANCE, theme: "light" });
    expect(light).not.toContain("prefers-color-scheme");
    expect(light).toContain("@media not all");
    expect(light).toContain("color-scheme: light;");
    const dark = styledCss(READER_CSS, { ...DEFAULT_APPEARANCE, theme: "dark" });
    expect(dark).toContain("@media all {");
    expect(dark).toContain("color-scheme: dark;");
  });
});
