// Small line icons for the reader's top bar (16px grid, drawn with the current text colour).

const paths = {
  regenerate: "M13 3.5v3h-3 M12.6 6.5A5 5 0 1 0 13 9",
  review: "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0.5A1.5 1.5 0 0 1 3 9.5z M5.8 7l1.5 1.5 2.9-3",
  settings: "M3 4.5h6 M12 4.5h1 M3 8h1 M7 8h6 M3 11.5h4 M10 11.5h3 M10.5 3v3 M5.5 6.5v3 M8.5 10v3",
  close: "M4.5 4.5l7 7 M11.5 4.5l-7 7",
  bold: "M5 3h4a2.5 2.5 0 0 1 0 5H5z M5 8h4.8a2.5 2.5 0 0 1 0 5H5z",
  italic: "M7 3h5 M4 13h5 M9.5 3l-3 10",
  code: "M5.5 4.5L2 8l3.5 3.5 M10.5 4.5L14 8l-3.5 3.5",
  link: "M7 9a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8 M9 7a2.8 2.8 0 0 0-4 0L3 9a2.8 2.8 0 0 0 4 4l.8-.8",
  quote: "M3 4v8 M6 5h7 M6 8h7 M6 11h5",
  bullets: "M6 4.5h7 M6 8h7 M6 11.5h7 M3 4.5h.01 M3 8h.01 M3 11.5h.01",
  numbers: "M6.5 4.5h6.5 M6.5 8h6.5 M6.5 11.5h6.5 M2.5 3.5l1-.5v3 M2.5 9.2a1 1 0 0 1 2 .1c0 .7-2 1.5-2 2.2h2",
  suggest: "M3 4h6 M6 1v6 M3 12h6 M11 3v10 M11 13l-2-2 M11 13l2-2",
  sparkle: "M7 2.5l1.2 3.3 3.3 1.2-3.3 1.2L7 11.5 5.8 8.2 2.5 7l3.3-1.2z M12.2 10.5v3.5 M10.5 12.2h3.5",
  send: "M2.5 8h10 M9 4.5L12.5 8 9 11.5",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The brand mark: a page of story lines with one highlighted, in an accent tile. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <rect width="20" height="20" rx="5.5" fill="var(--accent)" />
      <path d="M6 6.5h8 M6 10h5 M6 13.5h7" fill="none" stroke="var(--on-accent, #fff)" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="14" cy="10" r="1.3" fill="var(--on-accent, #fff)" />
    </svg>
  );
}
