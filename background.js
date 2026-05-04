/**
 * SafeView Background Service Worker
 * ====================================
 * Manages extension lifecycle, badge updates, and
 * communicates settings between popup and content scripts.
 */

let totalEventsBlocked = 0;

// ─── Listen for messages from content scripts ──────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'FLASH_DETECTED') {
    totalEventsBlocked = msg.eventsBlocked || 0;

    // Update badge on the extension icon
    chrome.action.setBadgeText({
      text: totalEventsBlocked > 0 ? String(totalEventsBlocked) : '',
      tabId: sender.tab?.id
    });
    chrome.action.setBadgeBackgroundColor({ color: '#1D9E75' });
  }

  if (msg.type === 'GET_TOTAL_EVENTS') {
    sendResponse({ total: totalEventsBlocked });
    // FIX: return true so the message channel stays open long enough
    // for sendResponse() to be received. Without this, the channel closes
    // immediately and the popup gets no response (runtime.lastError fires).
    return true;
  }

  if (msg.type === 'RESET_BADGE') {
    totalEventsBlocked = 0;
    chrome.action.setBadgeText({ text: '' });
  }
});

// ─── On install: open onboarding ──────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Default settings — mode is null so onboarding triggers
    chrome.storage.sync.set({
      safeview_settings: {
        enabled: true,
        mode: null,
        dimLevel: 0.65,
        sensitivity: 0.10,
        onboarded: false,
      }
    });
  }
});