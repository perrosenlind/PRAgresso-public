// Background service worker.
//
// Responsibilities:
//   1. Listen for the `toggle-autosave` keyboard command and broadcast it to
//      every content-script frame of the active tab.
//   2. Relay cross-frame messages for content scripts that cannot reach each
//      other directly (e.g. when the Agresso app is framed by an origin that
//      breaks window.top access).
//
// The service worker does not hold state — everything is persisted via
// `chrome.storage.local` and read directly from the content scripts.

function broadcast(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // Best-effort: ignore frames that aren't listening.
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-autosave') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null) broadcast(tab.id, { type: 'toggle-autosave' });
    }
  });
});

// Clicking the toolbar icon opens the options page. The content script runs
// automatically on matched hosts via host_permissions, so the icon itself is
// purely a shortcut to configuration.
chrome.action.onClicked.addListener(() => {
  try { chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'relay-activity' && sender.tab && sender.tab.id != null) {
    broadcast(sender.tab.id, { type: 'activity-broadcast', from: sender.frameId ?? null });
  }
});
