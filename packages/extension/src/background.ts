// The toolbar button opens settings. The pipeline itself runs in the reader page, not here:
// Chrome stops idle service workers after about 30 seconds, and one model call can take longer.
import { loadSettings } from "./settings";

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
  void syncEnterpriseScripts();
});

// The Story mode button on GitHub Enterprise hosts: the content script runs on exactly the hosts
// saved in settings that the user has granted access to, and nowhere else.
const SCRIPT_ID = "prstory-enterprise";

async function syncEnterpriseScripts() {
  try {
    const s = await loadSettings();
    const matches: string[] = [];
    for (const e of s.enterprise) {
      const origin = `https://${e.host}/*`;
      if (await chrome.permissions.contains({ origins: [origin] })) matches.push(origin);
    }
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    if (matches.length) await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, matches, js: ["content.js"], runAt: "document_idle" }]);
  } catch (err) {
    console.warn("PR Story Mode: couldn't update the enterprise hosts", err);
  }
}

chrome.runtime.onStartup.addListener(() => void syncEnterpriseScripts());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "settings" in changes) void syncEnterpriseScripts();
});
chrome.permissions.onAdded.addListener(() => void syncEnterpriseScripts());
chrome.permissions.onRemoved.addListener(() => void syncEnterpriseScripts());
