// Small line icons for the reader's top bar (16px grid, drawn with the current text colour).

const paths = {
  regenerate: "M13 3.5v3h-3 M12.6 6.5A5 5 0 1 0 13 9",
  review: "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0.5A1.5 1.5 0 0 1 3 9.5z M5.8 7l1.5 1.5 2.9-3",
  settings: "M3 4.5h6 M12 4.5h1 M3 8h1 M7 8h6 M3 11.5h4 M10 11.5h3 M10.5 3v3 M5.5 6.5v3 M8.5 10v3",
  close: "M4.5 4.5l7 7 M11.5 4.5l-7 7",
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
      <path d="M6 6.5h8 M6 10h5 M6 13.5h7" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="14" cy="10" r="1.3" fill="#fff" />
    </svg>
  );
}
