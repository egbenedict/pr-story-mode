// The toolbar button opens settings. The pipeline itself runs in the reader page, not here:
// Chrome stops idle service workers after about 30 seconds, and one model call can take longer.
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});
