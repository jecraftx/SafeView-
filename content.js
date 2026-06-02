/**
 * SafeView Content Script
 */

(function () {
  'use strict';

  const DIM_OVERLAY_ID = 'safeview-dim-overlay';
  const HUD_ID         = 'safeview-hud';
  const WARN_ID        = 'safeview-warning';

  let settings = {
    enabled: true,
    mode: null,
    dimLevel: 0.65,
    sensitivity: 0.10,
  };

  let isProtecting    = false;
  let protectTimer    = null;
  let eventsBlocked   = 0;
  let flashTimestamps = [];
  let lastLuminance   = null;

  const FLASH_WINDOW_MS = 1000;
  const FLASH_THRESHOLD = 3;

  // ─── Load settings ────────────────────────────────────────────
  try {
    chrome.storage.sync.get(['safeview_settings'], (result) => {
      if (result.safeview_settings) {
        settings = Object.assign(settings, result.safeview_settings);
      }
      start();
    });
  } catch(e) {
    start();
  }

  // ─── Message listener ─────────────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'SETTINGS_UPDATE') {
        settings = Object.assign(settings, msg.settings);
        window.postMessage({ type: 'SAFEVIEW_SETTINGS', settings }, '*');
        if (!settings.enabled) stopProtection();
      }
      if (msg.type === 'GET_STATS') {
        sendResponse({ eventsBlocked });
      }
      return true;
    });
  } catch(e) {}

  // ─── Start ────────────────────────────────────────────────────
  function start() {
    injectOverlay();
    injectHUD();
    injectPageScript();

    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data && e.data.type === 'SAFEVIEW_LUMINANCE') {
        handleLuminance(e.data.luminance);
      }
    });
  }

  // ─── Inject page-world script (bypasses CORS) ─────────────────
  function injectPageScript() {
    const script = document.createElement('script');
    script.textContent = `
(function() {
  const SAMPLE_MS = 50;
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let lastSample = 0;

  function getVideo() {
    return Array.from(document.querySelectorAll('video'))
      .filter(v => v.readyState >= 2 && !v.paused && !v.ended && v.offsetWidth > 0)
      .sort((a,b) => (b.offsetWidth*b.offsetHeight) - (a.offsetWidth*a.offsetHeight))[0] || null;
  }

  function computeLuminance(pixels) {
    let total = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      total += 0.299*(pixels[i]/255) + 0.587*(pixels[i+1]/255) + 0.114*(pixels[i+2]/255);
      count++;
    }
    return count > 0 ? total/count : -1;
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    if (ts - lastSample < SAMPLE_MS) return;
    lastSample = ts;
    const vid = getVideo();
    if (!vid) return;
    try {
      ctx.drawImage(vid, 0, 0, 32, 18);
      const data = ctx.getImageData(0, 0, 32, 18);
      const lum = computeLuminance(data.data);
      if (lum >= 0) {
        window.postMessage({ type: 'SAFEVIEW_LUMINANCE', luminance: lum }, '*');
      }
    } catch(e) {}
  }

  requestAnimationFrame(loop);
})();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // ─── Process luminance ────────────────────────────────────────
  function handleLuminance(luminance) {
    if (!settings.enabled || !settings.mode) return;

    if (lastLuminance !== null) {
      const delta = Math.abs(luminance - lastLuminance);
      const threshold = settings.sensitivity || 0.10;
      if (delta >= threshold) {
        flashTimestamps.push(Date.now());
      }
    }
    lastLuminance = luminance;

    const now = Date.now();
    flashTimestamps = flashTimestamps.filter(t => now - t <= FLASH_WINDOW_MS);
    const rate = flashTimestamps.length;

    if (rate >= FLASH_THRESHOLD) {
      triggerProtection(rate);
    } else if (isProtecting && rate < FLASH_THRESHOLD - 1) {
      scheduleProtectionEnd();
    }
  }

  // ─── Protection ───────────────────────────────────────────────
  function triggerProtection(rate) {
    if (!isProtecting) {
      isProtecting = true;
      eventsBlocked++;
      updateHUD(`⚠ ${rate} flashes/s — protected`, true);
      notifyBackground();
    }
    clearTimeout(protectTimer);

    const overlay = document.getElementById(DIM_OVERLAY_ID);
    if (!overlay) return;

    if (settings.mode === 'dim') {
      overlay.style.opacity = String(settings.dimLevel || 0.65);

    } else if (settings.mode === 'suppress') {
      overlay.style.opacity = '0';
      const vid = document.querySelector('video');
      if (vid) {
        vid.style.transition = 'filter 0.05s';
        vid.style.filter = 'saturate(0.1) brightness(0.55) contrast(0.75)';
      }

    } else if (settings.mode === 'warn') {
      overlay.style.opacity = '0';
      showWarningBanner(rate);
      const vid = document.querySelector('video');
      if (vid && !vid.paused) {
        vid.pause();
      }
    }
  }

  function scheduleProtectionEnd() {
    clearTimeout(protectTimer);
    protectTimer = setTimeout(stopProtection, 600);
  }

  function stopProtection() {
    isProtecting = false;
    clearTimeout(protectTimer);

    const overlay = document.getElementById(DIM_OVERLAY_ID);
    if (overlay) overlay.style.opacity = '0';

    const vid = document.querySelector('video');
    if (vid) {
      vid.style.filter = '';
      if (vid.paused) vid.play();
    }

    removeWarningBanner();
    updateHUD('SafeView active', false);
  }

  // ─── Overlay ──────────────────────────────────────────────────
  function injectOverlay() {
    if (document.getElementById(DIM_OVERLAY_ID)) return;
    const el = document.createElement('div');
    el.id = DIM_OVERLAY_ID;
    el.style.cssText = `
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      background: #000 !important;
      opacity: 0;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      transition: opacity 0.06s ease;
    `;
    document.documentElement.appendChild(el);
  }

  // ─── Warning banner ───────────────────────────────────────────
  function showWarningBanner(rate) {
    if (document.getElementById(WARN_ID)) return;
    const el = document.createElement('div');
    el.id = WARN_ID;
    el.style.cssText = `
      position: fixed; top: 20px; left: 50%;
      transform: translateX(-50%);
      background: rgba(20,20,20,0.96);
      border: 1px solid rgba(216,90,48,0.7);
      border-radius: 12px; padding: 12px 20px;
      z-index: 2147483647;
      font-family: -apple-system, system-ui, sans-serif;
      font-size: 13px; color: #fff;
      display: flex; align-items: center; gap: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    `;
    el.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:#D85A30;flex-shrink:0;display:block;"></span>
      <span><strong style="color:#F09575;">Flashing content detected</strong> — ${rate} flashes/sec. Video paused for safety.</span>
      <button id="safeview-warn-close" style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:16px;padding:0;line-height:1;">×</button>
    `;
    document.documentElement.appendChild(el);
    document.getElementById('safeview-warn-close').addEventListener('click', removeWarningBanner);
    setTimeout(removeWarningBanner, 5000);
  }

  function removeWarningBanner() {
    const el = document.getElementById(WARN_ID);
    if (el) el.remove();
  }

  // ─── HUD ──────────────────────────────────────────────────────
  function injectHUD() {
    if (document.getElementById(HUD_ID)) return;
    const el = document.createElement('div');
    el.id = HUD_ID;
    el.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      background: rgba(13,31,26,0.92);
      border: 1px solid rgba(29,158,117,0.45);
      border-radius: 999px; padding: 6px 14px;
      z-index: 2147483645;
      font-family: -apple-system, system-ui, sans-serif;
      font-size: 11px; color: rgba(255,255,255,0.75);
      display: flex; align-items: center; gap: 6px;
      opacity: 0; transition: opacity 0.3s;
      pointer-events: none;
    `;
    el.innerHTML = `
      <span id="safeview-hud-dot" style="width:6px;height:6px;border-radius:50%;background:#1D9E75;flex-shrink:0;display:block;"></span>
      <span id="safeview-hud-text">SafeView active</span>
    `;
    document.documentElement.appendChild(el);
    setTimeout(() => { el.style.opacity = '1'; }, 500);
    setTimeout(() => { if (!isProtecting) el.style.opacity = '0'; }, 3000);
  }

  function updateHUD(text, isAlert) {
    const hud  = document.getElementById(HUD_ID);
    const dot  = document.getElementById('safeview-hud-dot');
    const span = document.getElementById('safeview-hud-text');
    if (!hud || !dot || !span) return;
    span.textContent = text;
    dot.style.background  = isAlert ? '#D85A30' : '#1D9E75';
    hud.style.borderColor = isAlert ? 'rgba(216,90,48,0.5)' : 'rgba(29,158,117,0.45)';
    hud.style.opacity = '1';
    if (!isAlert) setTimeout(() => { hud.style.opacity = '0'; }, 4000);
  }

  // ─── Background messaging ─────────────────────────────────────
  function notifyBackground() {
    try {
      chrome.runtime.sendMessage({ type: 'FLASH_DETECTED', eventsBlocked }, () => {
        void chrome.runtime.lastError;
      });
    } catch(e) {}
  }

})();