// HTML from GitHub (rendered comments and previews) is sanitized by GitHub already. The reader page
// can read the user's API keys, so it is cleaned again here against a strict allowlist before it
// is shown: only formatting tags survive, with only the attributes listed, and only safe URLs.

const KEEP = new Set([
  "p", "br", "hr", "strong", "b", "em", "i", "del", "s", "ins", "code", "pre", "kbd", "samp", "blockquote",
  "ul", "ol", "li", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot",
  "tr", "th", "td", "span", "div", "details", "summary", "sup", "sub", "dl", "dt", "dd", "input",
]);
/** Removed with everything inside them. Any other unknown tag is dropped but its text is kept. */
const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "form", "svg", "math", "template", "noscript", "link", "meta", "base", "textarea", "select", "button", "video", "audio", "canvas"]);
const ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  td: ["align"],
  th: ["align"],
  ol: ["start"],
  input: ["type", "checked"],
  details: ["open"],
};
/** GitHub's classes for highlighted code and suggestion blocks; harmless, and useful for styling. */
const CLASSY = new Set(["span", "div", "pre", "code", "table", "td", "tr"]);

function safeUrl(url: string, images: boolean): string | null {
  const u = url.trim();
  if (images) return /^https:\/\//i.test(u) ? u : null;
  if (/^(https?:|mailto:)/i.test(u) || u.startsWith("#")) return u;
  return null;
}

/** GitHub HTML → HTML safe to put in the page. */
export function sanitizeHtml(html: string): string {
  // A detached document: nothing in it loads or runs while it is parsed and copied.
  const src = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const out = document.implementation.createHTMLDocument("");
  const copy = (from: Node, to: Node) => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        to.appendChild(out.createTextNode(n.textContent ?? ""));
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) continue;
      if (!KEEP.has(tag)) {
        copy(el, to);
        continue;
      }
      if (tag === "input" && el.getAttribute("type") !== "checkbox") continue;
      const clean = out.createElement(tag);
      for (const name of ATTRS[tag] ?? []) {
        const v = el.getAttribute(name);
        if (v == null) continue;
        if (name === "href" || name === "src") {
          const url = safeUrl(v, name === "src");
          if (url) clean.setAttribute(name, url);
        } else clean.setAttribute(name, v);
      }
      if (CLASSY.has(tag)) {
        const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => /^[\w-]{1,40}$/.test(c));
        if (cls.length) clean.setAttribute("class", cls.join(" "));
      }
      if (tag === "a" && clean.hasAttribute("href") && !clean.getAttribute("href")!.startsWith("#")) {
        clean.setAttribute("target", "_blank");
        clean.setAttribute("rel", "noopener noreferrer");
      }
      if (tag === "img") clean.setAttribute("loading", "lazy");
      if (tag === "input") clean.setAttribute("disabled", "");
      copy(el, clean);
      to.appendChild(clean);
    }
  };
  copy(src, out.body);
  return out.body.innerHTML;
}
