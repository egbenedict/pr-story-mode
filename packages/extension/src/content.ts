// Runs on github.com. Adds one "Story mode" button to pull request pages and opens the reader in an
// overlay. Nothing else on GitHub's page is touched, since its markup changes often.

const BUTTON_ID = "prstory-button";
const OVERLAY_ID = "prstory-overlay";

/** `https://github.com/owner/repo/pull/12/files?x` → `https://github.com/owner/repo/pull/12`; null off PR pages. */
export function prUrlOf(href: string): string | null {
  const u = new URL(href);
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(u.pathname);
  return m ? `${u.origin}/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

const readerOrigin = () => new URL(chrome.runtime.getURL("")).origin;

function openOverlay(prUrl: string) {
  if (document.getElementById(OVERLAY_ID)) return;
  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .wrap { position: fixed; inset: 0; z-index: 2147483646; background: rgba(0,0,0,.35); display: flex; }
    iframe { flex: 1; border: 0; margin: 12px; border-radius: 10px; background: #fbfaf8; box-shadow: 0 12px 48px rgba(0,0,0,.35); }
    @media (prefers-color-scheme: dark) { iframe { background: #161614; } }
  </style><div class="wrap"><iframe title="PR Story Mode" allow="clipboard-write"></iframe></div>`;
  const iframe = root.querySelector("iframe")!;
  // Match the reader's chosen theme while it loads.
  void chrome.storage.local.get("settings").then((got) => {
    const theme = (got.settings as { appearance?: { theme?: string } } | undefined)?.appearance?.theme;
    if (theme === "light" || theme === "dark") iframe.style.background = theme === "dark" ? "#161614" : "#fbfaf8";
  }).catch(() => {});
  iframe.src = chrome.runtime.getURL(`reader.html?pr=${encodeURIComponent(prUrl)}`);
  root.querySelector(".wrap")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeOverlay();
  });
  document.documentElement.appendChild(host);
  document.documentElement.style.overflow = "hidden";
  iframe.focus();
}

function closeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  document.documentElement.style.overflow = "";
}

function makeButton(prUrl: string, floating: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.id = BUTTON_ID;
  b.type = "button";
  b.textContent = "Story mode";
  b.title = "Read this pull request as a narrated story (PR Story Mode)";
  b.className = floating ? "" : "btn btn-sm";
  if (floating) {
    Object.assign(b.style, {
      position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483645", padding: "8px 14px", borderRadius: "999px",
      border: "1px solid rgba(0,0,0,.15)", background: "#c2410c", color: "#fff", font: "600 13px -apple-system, BlinkMacSystemFont, sans-serif",
      cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,.2)",
    } satisfies Partial<CSSStyleDeclaration>);
  } else {
    b.style.marginRight = "8px";
  }
  b.addEventListener("click", () => openOverlay(prUrl));
  return b;
}

const visible = (el: Element) => el.getClientRects().length > 0;

/**
 * Where the button goes: the PR header's action area (classic or React layout) when one is on
 * screen, else a floating button. GitHub renders hidden copies of the header for other widths.
 */
function headerSlot(): Element | null {
  return [...document.querySelectorAll('.gh-header-actions, [data-component="PH_Actions"]')].find(visible) ?? null;
}

function sync() {
  const prUrl = prUrlOf(location.href);
  const existing = document.getElementById(BUTTON_ID);
  if (!prUrl) {
    existing?.remove();
    closeOverlay();
    return;
  }
  // Keep the button unless the page re-rendered or resized it out of view.
  if (existing?.dataset.pr === prUrl && existing.isConnected && visible(existing)) return;
  existing?.remove();
  const slot = headerSlot();
  const b = makeButton(prUrl, !slot);
  b.dataset.pr = prUrl;
  if (slot) slot.prepend(b);
  else document.body.appendChild(b);
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  window.addEventListener("message", (e) => {
    if (e.origin === readerOrigin() && e.data?.type === "prstory:close") closeOverlay();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOverlay();
  });
  // GitHub navigates without page loads (Turbo), and re-renders the header, so check often and cheaply.
  document.addEventListener("turbo:load", sync);
  window.addEventListener("popstate", sync);
  setInterval(sync, 1000);
  sync();
}
