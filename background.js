/**
 * SafeView Background Service Worker
 */

let totalEventsBlocked = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'FLASH_DETECTED') {
    totalEventsBlocked = msg.eventsBlocked || 0;
    chrome.action.setBadgeText({
      text: totalEventsBlocked > 0 ? String(totalEventsBlocked) : '',
      tabId: sender.tab?.id
    });
    chrome.action.setBadgeBackgroundColor({ color: '#1D9E75' });
  }

  if (msg.type === 'GET_TOTAL_EVENTS') {
    sendResponse({ total: totalEventsBlocked });
  }

  if (msg.type === 'RESET_BADGE') {
    totalEventsBlocked = 0;
    chrome.action.setBadgeText({ text: '' });
  }

  return true; // keep message channel open for all messages
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
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