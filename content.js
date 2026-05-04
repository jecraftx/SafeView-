/**
 * SafeView Content Script
 * ========================
 * Monitors all video elements on the page in real-time.
 * Detects harmful flashing/strobing by sampling video frames
 * via an offscreen canvas and measuring luminance changes.
 * Responds with dimming, flash suppression, or warnings
 * based on user settings.
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────
  const SAMPLE_INTERVAL_MS = 50;       // how often we sample (20fps analysis)
  const FLASH_WINDOW_MS    = 1000;     // rolling window to count flashes
  const FLASH_THRESHOLD    = 3;        // flashes per second = danger (W3C guideline: >3/s)
  const LUMINANCE_DELTA    = 0.10;     // min relative luminance change to count as a flash
  const DIM_OVERLAY_ID     = 'safeview-dim-overlay';
  const HUD_ID             = 'safeview-hud';

  // ─── State ────────────────────────────────────────────────────
  let settings = {
    enabled: true,
    mode: null,           // 'dim' | 'suppress' | 'warn' — null until onboarding complete
    dimLevel: 0.65,       // 0–1, how much to dim
    sensitivity: 0.10,    // luminance delta threshold
  };

  let flashTimestamps = [];   // timestamps of recent flash events
  let lastLuminance   = null;
  let isProtecting    = false;
  let protectTimer    = null;
  let eventsBlocked   = 0;
  let canvas, ctx;

  // ─── Load settings from storage ───────────────────────────────
  chrome.storage.sync.get(['safeview_settings'], (result) => {
    if (result.safeview_settings) {
      settings = Object.assign(settings, result.safeview_settings);
    }
    if (settings.enabled && settings.mode) {
      init();
    }
  });

  // ─── Listen for settings updates from popup ───────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_UPDATE') {
      settings = Object.assign(settings, msg.settings);
      if (!settings.enabled) {
        stopProtection();
        removeOverlay();
        removeHUD();
      } else if (settings.mode) {
        init();
      }
    }
    if (msg.type === 'GET_STATS') {
      // FIX: use callback form to avoid uncaught Promise rejection
      chrome.runtime.sendMessage({ type: 'STATS', eventsBlocked }, () => {
        void chrome.runtime.lastError;
      });
    }
  });

  // ─── Init ─────────────────────────────────────────────────────
  function init() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width  = 64;   // low-res sample — fast enough for real-time
      canvas.height = 36;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    injectOverlay();
    injectHUD();
    observeVideos();
    startAnalysisLoop();
  }

  // ─── Find & watch all video elements (including dynamically added) ──
  function observeVideos() {
    const mo = new MutationObserver(() => {
      document.querySelectorAll('video').forEach(attachToVideo);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('video').forEach(attachToVideo);
  }

  const watchedVideos = new WeakSet();
  function attachToVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
  }

  // ─── Main analysis loop ───────────────────────────────────────
  function startAnalysisLoop() {
    setInterval(() => {
      if (!settings.enabled || !settings.mode) return;
      const video = getPrimaryVideo();
      if (!video || video.paused || video.ended) return;
      analyzeFrame(video);
    }, SAMPLE_INTERVAL_MS);
  }

  function getPrimaryVideo() {
    // Pick largest visible video on page (most likely the main content)
    const videos = Array.from(document.querySelectorAll('video'));
    return videos
      .filter(v => v.readyState >= 2 && !v.paused)
      .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0] || null;
  }

  // ─── Frame analysis ───────────────────────────────────────────
  function analyzeFrame(video) {
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      return; // cross-origin or not ready
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const luminance  = computeAverageLuminance(imageData.data);

    if (lastLuminance !== null) {
      const delta = Math.abs(luminance - lastLuminance);
      const sensitivityThreshold = settings.sensitivity || LUMINANCE_DELTA;

      if (delta >= sensitivityThreshold) {
        recordFlash();
      }
    }

    lastLuminance = luminance;
    checkFlashRate();
  }

  // ─── Relative luminance (ITU-R BT.709) ───────────────────────
  function computeAverageLuminance(pixels) {
    let total = 0;
    const len = pixels.length;
    for (let i = 0; i < len; i += 4) {
      const r = pixels[i]   / 255;
      const g = pixels[i+1] / 255;
      const b = pixels[i+2] / 255;
      // Linearize
      const rl = r <= 0.04045 ? r/12.92 : Math.pow((r+0.055)/1.055, 2.4);
      const gl = g <= 0.04045 ? g/12.92 : Math.pow((g+0.055)/1.055, 2.4);
      const bl = b <= 0.04045 ? b/12.92 : Math.pow((b+0.055)/1.055, 2.4);
      total += 0.2126*rl + 0.7152*gl + 0.0722*bl;
    }
    return total / (len / 4);
  }

  function recordFlash() {
    flashTimestamps.push(Date.now());
  }

  function checkFlashRate() {
    const now = Date.now();
    // Keep only flashes within the rolling window
    flashTimestamps = flashTimestamps.filter(t => now - t <= FLASH_WINDOW_MS);
    const flashesPerSecond = flashTimestamps.length;

    if (flashesPerSecond >= FLASH_THRESHOLD) {
      triggerProtection(flashesPerSecond);
    } else if (isProtecting && flashesPerSecond < FLASH_THRESHOLD - 1) {
      scheduleProtectionEnd();
    }
  }

  // ─── Protection response ──────────────────────────────────────
  function triggerProtection(rate) {
    if (!isProtecting) {
      isProtecting = true;
      eventsBlocked++;
      updateHUD(`Protected — ${rate} flashes/s detected`, true);
      notifyBackground();
    }
    clearTimeout(protectTimer);

    const overlay = document.getElementById(DIM_OVERLAY_ID);
    if (!overlay) return;

    if (settings.mode === 'dim') {
      overlay.style.opacity = String(settings.dimLevel || 0.65);
      overlay.style.backdropFilter = 'none';
      overlay.style.background = '#000';

    } else if (settings.mode === 'suppress') {
      overlay.style.opacity = '0';
      // Apply CSS filter to the video element itself
      const video = getPrimaryVideo();
      if (video) {
        video.style.transition = 'filter 0.1s';
        video.style.filter = 'saturate(0.15) brightness(0.6) contrast(0.8)';
      }

    } else if (settings.mode === 'warn') {
      overlay.style.opacity = '0';
      showWarningBanner(rate);
    }
  }

  function scheduleProtectionEnd() {
    clearTimeout(protectTimer);
    protectTimer = setTimeout(() => {
      stopProtection();
    }, 800); // hold protection briefly after flashing stops
  }

  function stopProtection() {
    isProtecting = false;
    clearTimeout(protectTimer);

    const overlay = document.getElementById(DIM_OVERLAY_ID);
    if (overlay) overlay.style.opacity = '0';

    const video = getPrimaryVideo();
    if (video && settings.mode === 'suppress') {
      video.style.filter = '';
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
      position: fixed;
      inset: 0;
      background: #000;
      opacity: 0;
      pointer-events: none;
      z-index: 2147483646;
      transition: opacity 0.08s ease;
    `;
    document.documentElement.appendChild(el);
  }

  function removeOverlay() {
    const el = document.getElementById(DIM_OVERLAY_ID);
    if (el) el.remove();
  }

  // ─── Warning banner ───────────────────────────────────────────
  const WARN_ID = 'safeview-warning';

  function showWarningBanner(rate) {
    if (document.getElementById(WARN_ID)) return;
    const el = document.createElement('div');
    el.id = WARN_ID;
    el.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(20, 20, 20, 0.96);
      border: 1px solid rgba(216, 90, 48, 0.7);
      border-radius: 12px;
      padding: 12px 20px;
      z-index: 2147483647;
      font-family: -apple-system, system-ui, sans-serif;
      font-size: 13px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      animation: svSlideIn 0.25s ease;
    `;
    el.innerHTML = `
      <style>@keyframes svSlideIn{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}</style>
      <span style="width:8px;height:8px;border-radius:50%;background:#D85A30;flex-shrink:0;animation:svPulse 1s infinite;display:block;"></span>
      <style>@keyframes svPulse{0%,100%{opacity:1}50%{opacity:0.4}}</style>
      <span><strong style="color:#F09575;">Flashing content detected</strong> — ${rate} flashes/sec. Look away or skip.</span>
      <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:16px;padding:0;line-height:1;">×</button>
    `;
    document.documentElement.appendChild(el);
    setTimeout(removeWarningBanner, 5000);
  }

  function removeWarningBanner() {
    const el = document.getElementById(WARN_ID);
    if (el) el.remove();
  }

  // ─── HUD (small status indicator) ────────────────────────────
  function injectHUD() {
    if (document.getElementById(HUD_ID)) return;
    const el = document.createElement('div');
    el.id = HUD_ID;
    el.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(13, 31, 26, 0.92);
      border: 1px solid rgba(29, 158, 117, 0.45);
      border-radius: 999px;
      padding: 6px 14px;
      z-index: 2147483645;
      font-family: -apple-system, system-ui, sans-serif;
      font-size: 11px;
      color: rgba(255,255,255,0.75);
      display: flex;
      align-items: center;
      gap: 6px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    `;
    el.innerHTML = `
      <span id="safeview-hud-dot" style="width:6px;height:6px;border-radius:50%;background:#1D9E75;flex-shrink:0;display:block;"></span>
      <span id="safeview-hud-text">SafeView active</span>
    `;
    document.documentElement.appendChild(el);

    // Show briefly on load, then fade
    setTimeout(() => { el.style.opacity = '1'; }, 500);
    setTimeout(() => { if (!isProtecting) el.style.opacity = '0'; }, 3000);
  }

  function updateHUD(text, alert) {
    const hud  = document.getElementById(HUD_ID);
    const dot  = document.getElementById('safeview-hud-dot');
    const span = document.getElementById('safeview-hud-text');
    if (!hud || !dot || !span) return;
    span.textContent = text;
    dot.style.background = alert ? '#D85A30' : '#1D9E75';
    hud.style.borderColor = alert ? 'rgba(216,90,48,0.5)' : 'rgba(29,158,117,0.45)';
    hud.style.opacity = '1';
    if (!alert) setTimeout(() => { hud.style.opacity = '0'; }, 4000);
  }

  function removeHUD() {
    const el = document.getElementById(HUD_ID);
    if (el) el.remove();
  }

  // ─── Notify background (badge counter) ───────────────────────
  function notifyBackground() {
    // FIX: use callback form instead of .catch() — chrome.runtime.sendMessage
    // in MV3 content scripts does not reliably return a thenable, and calling
    // .catch() on the return value throws when the background SW is inactive.
    chrome.runtime.sendMessage({ type: 'FLASH_DETECTED', eventsBlocked }, () => {
      void chrome.runtime.lastError;
    });
  }

})();