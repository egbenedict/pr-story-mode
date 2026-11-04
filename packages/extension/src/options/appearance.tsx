// The Appearance section of the settings page: theme, accent, diff colours, fonts and sizes, with a
// small preview of a story step drawn with the chosen values.

import {
  ACCENTS,
  CODE_FONT_SUGGESTIONS,
  CODE_SIZES,
  DEFAULT_APPEARANCE,
  TEXT_FONT_SUGGESTIONS,
  TEXT_SIZES,
  accentColors,
  cleanFontName,
  isDark,
  type Appearance,
  type DiffColors,
  type Theme,
} from "../appearance";
import { useEffect, useState } from "react";

export const APPEARANCE_CSS = `
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; padding: 2px; background: var(--bg); }
.seg label { margin: 0; }
.seg input { position: absolute; opacity: 0; pointer-events: none; }
.seg span { display: block; margin: 0; padding: 4px 14px; border-radius: 6px; font-size: 13.5px; cursor: pointer; color: var(--muted); }
.seg input:checked + span { background: var(--panel); color: var(--ink); box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgba(0,0,0,.06); font-weight: 500; }
.seg input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }
.field { margin: 0 0 16px; font-size: 14px; }
.field > .name { display: block; font-weight: 500; margin-bottom: 6px; }
.swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.swatch { all: unset; box-sizing: border-box; width: 26px; height: 26px; border-radius: 50%; cursor: pointer; display: grid; place-items: center; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--ink); }
.swatch:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.swatch.custom { position: relative; background: conic-gradient(#f43f5e, #f59e0b, #22c55e, #06b6d4, #6366f1, #d946ef, #f43f5e); overflow: hidden; }
.swatch.custom input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; border: 0; padding: 0; }
.swatch.custom .dot { width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 0 2px #fff; pointer-events: none; }
.swatch-label { color: var(--muted); font-size: 13px; margin-left: 4px; }
.diff-opts { display: flex; flex-wrap: wrap; gap: 10px; }
.diff-opt { margin: 0; display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px 6px 10px; cursor: pointer; background: var(--bg); font-size: 13.5px; }
.diff-opt:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.diff-opt input { accent-color: var(--accent); margin: 0; }
.chips { display: inline-flex; gap: 3px; }
.chips i { width: 14px; height: 14px; border-radius: 3px; display: block; }
.two { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 0 14px; align-items: end; }
.range { display: flex; align-items: center; gap: 10px; height: 34px; }
.range input { flex: 1; accent-color: var(--accent); min-width: 0; }
.range output { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 3.6em; text-align: right; }
@media (max-width: 520px) { .two { grid-template-columns: 1fr; } }
.preview { border: 1px solid var(--line); border-radius: 10px; background: var(--bg); padding: 14px 16px 16px; margin: 4px 0 14px; }
.preview .pv-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; }
.pv-step { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; }
.pv-marker { width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; font-size: 12px; font-weight: 600; margin-top: 1px; }
.pv-text { font: var(--text-size)/1.6 var(--sans); margin: 0 0 10px; }
.pv-text code { font: 0.9em var(--mono); background: var(--ctx-bg); padding: 0.05em 0.3em; border-radius: 4px; }
.pv-text a { color: var(--accent); }
.pv-atom { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.pv-head { display: flex; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--line); font: 12.5px var(--mono); }
.pv-head .plus { color: var(--add-ink); } .pv-head .minus { color: var(--del-ink); }
.pv-diff { width: 100%; border-collapse: collapse; font: var(--code-size)/1.5 var(--mono); color: var(--code); }
.pv-diff td { padding: 0 10px; white-space: pre; }
.pv-diff .ln { width: 1%; text-align: right; color: var(--muted); font-size: calc(var(--code-size) - 1px); opacity: .8; }
.pv-diff tr.add { background: var(--add-bg); } .pv-diff tr.add .s { color: var(--add-ink); }
.pv-diff tr.del { background: var(--del-bg); } .pv-diff tr.del .s { color: var(--del-ink); }
.pv-diff .s { display: inline-block; width: 1.2em; }
.pv-actions { display: flex; gap: 8px; margin-top: 12px; }
.pv-actions span { font: 500 12.5px var(--sans); border-radius: 6px; padding: 4px 10px; }
.pv-actions .primary { background: var(--accent); color: var(--on-accent); }
.pv-actions .plain { border: 1px solid var(--line); color: var(--ink); }
`;

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const DIFF_OPTS: { id: DiffColors; label: string; chips: [string, string] }[] = [
  { id: "green-red", label: "Green and red", chips: ["#2da44e", "#cf222e"] },
  { id: "blue-orange", label: "Blue and orange (color-blind friendly)", chips: ["#0969da", "#d4651d"] },
];

/** Re-renders when the system switches between light and dark, so swatches show the shade in use. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => isDark("system"));
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

function FontField(props: { id: string; label: string; value: string; placeholder: string; suggestions: string[]; onChange: (v: string) => void }) {
  // The text is kept as typed; only a valid name is applied.
  const [text, setText] = useState(props.value);
  useEffect(() => setText((t) => (cleanFontName(t) === props.value ? t : props.value)), [props.value]);
  const bad = text.trim() !== "" && !cleanFontName(text);
  return (
    <label>
      <span>{props.label}</span>
      <input
        type="text"
        list={props.id}
        value={text}
        spellCheck={false}
        placeholder={props.placeholder}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim() || cleanFontName(e.target.value)) props.onChange(cleanFontName(e.target.value));
        }}
      />
      <datalist id={props.id}>
        {props.suggestions.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      {bad ? <span className="warn">Use just the font's name, without quotes or punctuation.</span> : null}
    </label>
  );
}

function SizeField(props: { label: string; value: number; range: { min: number; max: number; step: number }; onChange: (v: number) => void }) {
  return (
    <label>
      <span>{props.label}</span>
      <span className="range">
        <input type="range" min={props.range.min} max={props.range.max} step={props.range.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} aria-label={props.label} />
        <output>{props.value}px</output>
      </span>
    </label>
  );
}

function Preview() {
  return (
    <div className="preview" aria-label="Preview">
      <p className="pv-label">Preview</p>
      <div className="pv-step">
        <div className="pv-marker">2</div>
        <div>
          <p className="pv-text">
            <code>readHeader</code> now checks the length before reading the body, so a short packet fails early instead of reading past the end. <a href="#preview">Why this matters</a>
          </p>
          <div className="pv-atom">
            <div className="pv-head">
              <span>src/packet.ts</span>
              <span className="plus">+2</span>
              <span className="minus">−1</span>
            </div>
            <table className="pv-diff">
              <tbody>
                <tr>
                  <td className="ln">41</td>
                  <td>
                    <span className="s"> </span>function readHeader(buf: Buffer) {"{"}
                  </td>
                </tr>
                <tr className="del">
                  <td className="ln">42</td>
                  <td>
                    <span className="s">-</span>  const len = buf.readUInt16BE(0);
                  </td>
                </tr>
                <tr className="add">
                  <td className="ln">42</td>
                  <td>
                    <span className="s">+</span>  if (buf.length {"<"} 2) throw new ShortPacket();
                  </td>
                </tr>
                <tr className="add">
                  <td className="ln">43</td>
                  <td>
                    <span className="s">+</span>  const len = buf.readUInt16BE(0);
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="pv-actions">
            <span className="primary">Review</span>
            <span className="plain">Raw diff</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppearanceSettings({ value: a, onChange }: { value: Appearance; onChange: (a: Appearance) => void }) {
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => onChange({ ...a, [k]: v });
  const systemDark = useSystemDark();
  const dark = a.theme === "system" ? systemDark : a.theme === "dark";
  const custom = a.accent.startsWith("#");
  const customColor = custom ? a.accent : accentColors(a.accent)[dark ? "dark" : "light"];
  const changed = JSON.stringify(a) !== JSON.stringify(DEFAULT_APPEARANCE);

  return (
    <fieldset>
      <legend>Appearance</legend>
      <p className="hint" style={{ marginTop: 0 }}>
        Changes are saved and show in open stories right away.
      </p>

      <div className="field">
        <span className="name">Theme</span>
        <div className="seg" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <label key={t.id}>
              <input type="radio" name="theme" checked={a.theme === t.id} onChange={() => set("theme", t.id)} />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="name">Accent color</span>
        <div className="swatches">
          {ACCENTS.map((p) => (
            <button key={p.id} type="button" className="swatch" title={p.label} aria-label={p.label} aria-pressed={a.accent === p.id} style={{ background: dark ? p.dark : p.light }} onClick={() => set("accent", p.id)} />
          ))}
          <span className="swatch custom" title="Custom color" aria-pressed={custom}>
            <input type="color" aria-label="Custom accent color" value={customColor} onChange={(e) => set("accent", e.target.value.toLowerCase())} />
            {custom ? <span className="dot" style={{ background: a.accent }} /> : null}
          </span>
          <span className="swatch-label">{custom ? `Custom ${a.accent}` : ACCENTS.find((p) => p.id === a.accent)?.label}</span>
        </div>
      </div>

      <div className="field">
        <span className="name">Diff colors</span>
        <div className="diff-opts">
          {DIFF_OPTS.map((d) => (
            <label className="diff-opt" key={d.id}>
              <input type="radio" name="diff" checked={a.diffColors === d.id} onChange={() => set("diffColors", d.id)} />
              <span className="chips" aria-hidden="true">
                <i style={{ background: d.chips[0] }} />
                <i style={{ background: d.chips[1] }} />
              </span>
              {d.label}
            </label>
          ))}
        </div>
      </div>

      <div className="two">
        <FontField id="text-fonts" label="Text font" value={a.textFont} placeholder="System default" suggestions={TEXT_FONT_SUGGESTIONS} onChange={(v) => set("textFont", v)} />
        <SizeField label="Text size" value={a.textSize} range={TEXT_SIZES} onChange={(v) => set("textSize", v)} />
        <FontField id="code-fonts" label="Code font" value={a.codeFont} placeholder="System monospace" suggestions={CODE_FONT_SUGGESTIONS} onChange={(v) => set("codeFont", v)} />
        <SizeField label="Code size" value={a.codeSize} range={CODE_SIZES} onChange={(v) => set("codeSize", v)} />
      </div>
      <p className="hint" style={{ margin: "-6px 0 14px" }}>
        Fonts must be installed on this computer. A name that isn't installed falls back to the default.
      </p>

      <Preview />

      {changed ? (
        <button type="button" className="quiet" onClick={() => onChange(DEFAULT_APPEARANCE)}>
          Reset appearance
        </button>
      ) : null}
    </fieldset>
  );
}
