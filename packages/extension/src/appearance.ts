// How the reader looks: theme, accent, diff colours, fonts and sizes. Each choice becomes CSS
// variables layered over the shared stylesheet, so the reader's own rules stay unchanged.

export type Theme = "system" | "light" | "dark";
export type DiffColors = "green-red" | "blue-orange";

export type Appearance = {
  theme: Theme;
  /** A preset name from ACCENTS, or a custom colour as "#rrggbb". */
  accent: string;
  diffColors: DiffColors;
  /** A font family installed on this computer; empty for the default. */
  textFont: string;
  codeFont: string;
  textSize: number; // px
  codeSize: number; // px
};

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", accent: "orange", diffColors: "green-red", textFont: "", codeFont: "", textSize: 15, codeSize: 12.5 };

export const TEXT_SIZES = { min: 13, max: 19, step: 1 };
export const CODE_SIZES = { min: 10.5, max: 16, step: 0.5 };

/** Accent presets: one shade for light pages and a lighter one for dark pages. */
export const ACCENTS: { id: string; label: string; light: string; dark: string }[] = [
  { id: "orange", label: "Orange", light: "#c2410c", dark: "#fb923c" },
  { id: "blue", label: "Blue", light: "#0969da", dark: "#58a6ff" },
  { id: "green", label: "Green", light: "#1a7f37", dark: "#3fb950" },
  { id: "purple", label: "Purple", light: "#8250df", dark: "#bc8cff" },
  { id: "pink", label: "Pink", light: "#bf3989", dark: "#f778ba" },
  { id: "teal", label: "Teal", light: "#0f766e", dark: "#2dd4bf" },
];

const DIFFS: Record<DiffColors, { light: Record<string, string>; dark: Record<string, string> }> = {
  "green-red": {
    light: { "add-bg": "#e9f6ec", "add-ink": "#1a6b34", "del-bg": "#fbeaea", "del-ink": "#a12a2a" },
    dark: { "add-bg": "#15301e", "add-ink": "#7fd69a", "del-bg": "#3a1a1a", "del-ink": "#f2a0a0" },
  },
  // Blue and orange stay apart for red-green colour blindness, as GitHub's colour-blind themes do.
  "blue-orange": {
    light: { "add-bg": "#ddf0ff", "add-ink": "#0550ae", "del-bg": "#fff0e3", "del-ink": "#a8430a" },
    dark: { "add-bg": "#0c2d4a", "add-ink": "#79c0ff", "del-bg": "#3d2410", "del-ink": "#ffa657" },
  },
};

export const DEFAULT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`;
export const DEFAULT_MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

/** Suggestions for the font fields. Only fonts installed on the computer show up. */
export const TEXT_FONT_SUGGESTIONS = ["Inter", "Helvetica Neue", "Avenir Next", "Segoe UI", "Georgia", "Charter", "Iowan Old Style", "Palatino"];
export const CODE_FONT_SUGGESTIONS = ["JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", "Menlo", "Monaco", "Consolas", "Source Code Pro", "IBM Plex Mono"];

const HEX = /^#[0-9a-f]{6}$/i;

/** Font family names go into CSS text, so only plain names are allowed (no quotes, semicolons or braces). */
export function cleanFontName(name: string): string {
  const t = name.trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N} ._-]{1,60}$/u.test(t) ? t : "";
}

const clamp = (n: unknown, r: { min: number; max: number }, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : d);

/** Saved appearance (possibly from an older version, or edited by hand) → a valid one. */
export function withAppearanceDefaults(saved: Partial<Appearance> | undefined): Appearance {
  const a = { ...DEFAULT_APPEARANCE, ...(saved && typeof saved === "object" ? saved : {}) };
  return {
    theme: a.theme === "light" || a.theme === "dark" ? a.theme : "system",
    accent: typeof a.accent === "string" && (HEX.test(a.accent) || ACCENTS.some((x) => x.id === a.accent)) ? a.accent.toLowerCase() : DEFAULT_APPEARANCE.accent,
    diffColors: a.diffColors === "blue-orange" ? "blue-orange" : "green-red",
    textFont: typeof a.textFont === "string" ? cleanFontName(a.textFont) : "",
    codeFont: typeof a.codeFont === "string" ? cleanFontName(a.codeFont) : "",
    textSize: clamp(a.textSize, TEXT_SIZES, DEFAULT_APPEARANCE.textSize),
    codeSize: clamp(a.codeSize, CODE_SIZES, DEFAULT_APPEARANCE.codeSize),
  };
}

/** The accent for each theme: a preset's two shades, or the custom colour for both. */
export function accentColors(accent: string): { light: string; dark: string } {
  if (HEX.test(accent)) return { light: accent, dark: accent };
  const p = ACCENTS.find((x) => x.id === accent) ?? ACCENTS[0]!;
  return { light: p.light, dark: p.dark };
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** Text on an accent background: white or near-black, whichever contrasts more. */
export function onAccent(hex: string): string {
  const l = luminance(hex);
  const dark = 0.011; // #1f1307
  return 1.05 / (l + 0.05) >= (l + 0.05) / (dark + 0.05) ? "#ffffff" : "#1f1307";
}

const fontStack = (name: string, fallback: string) => (name ? `"${name}", ${fallback}` : fallback);

/** The CSS variables for one theme. */
export function appearanceVars(a: Appearance, dark: boolean): Record<string, string> {
  const accent = accentColors(a.accent)[dark ? "dark" : "light"];
  return {
    "--accent": accent,
    "--on-accent": onAccent(accent),
    ...Object.fromEntries(Object.entries(DIFFS[a.diffColors][dark ? "dark" : "light"]).map(([k, v]) => [`--${k}`, v])),
    "--sans": fontStack(a.textFont, DEFAULT_SANS),
    "--mono": fontStack(a.codeFont, DEFAULT_MONO),
    "--text-size": `${a.textSize}px`,
    "--code-size": `${a.codeSize}px`,
  };
}

const block = (vars: Record<string, string>) => `:root { ${Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(" ")} }`;

const DARK_QUERY = "@media (prefers-color-scheme: dark)";

/**
 * The page's stylesheet with the appearance applied. A fixed theme rewrites the stylesheet's dark
 * mode queries to always or never match, so every dark rule follows the choice, not the system.
 */
export function styledCss(base: string, a: Appearance): string {
  const scheme = a.theme === "system" ? "light dark" : a.theme;
  const css = `${base}\n${block(appearanceVars(a, false))}\n${DARK_QUERY} { ${block(appearanceVars(a, true))} }\n:root { color-scheme: ${scheme}; }`;
  if (a.theme === "system") return css;
  return css.split(DARK_QUERY).join(a.theme === "dark" ? "@media all" : "@media not all");
}

/** Whether the page shows dark: the fixed theme, or the system's. */
export function isDark(theme: Theme): boolean {
  if (theme !== "system") return theme === "dark";
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}
