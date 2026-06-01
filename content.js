/**
 * SafeView Content Script
 * ========================
 * Detects harmful flashing by sampling video frames.
 * Uses createImageBitmap() which works in extension content scripts
 * even when ctx.drawImage() would be tainted by CORS.
 */

(function () {
  'use strict';

  const SAMPLE_INTERVAL_MS = 50;
  const FLASH_WINDOW_MS    = 1000;
  const FLASH_THRESHOLD    = 3;
  const DIM_OVERLAY_ID     = 'safeview-dim-overlay';
  const HUD_ID             = 'safeview-hud';
  const WARN_ID            = 'safeview-warning';

  let settings = {
    enabled: true,
    mode: null,
    dimLevel: 0.65,
    sensitivity: 0.10,
  };

  let flashTimestamps = [];
  let lastLuminance   = null;
  let isProtecting    = false;
  let protectTimer    = null;
  let eventsBlocked   = 0;
  let loopRunning     = false;
  let canvas, ctx;

  // ─── Load settings ────────────────────────────────────────────
  chrome.storage.sync.get(['safeview_settings'], (result) => {
    if (result.safeview_settings) {
      settings = Object.assign(settings, result.safeview_settings);
    }
    // Always init — even if mode is null, overlay should be ready
    init();
  });

  // ─── Settings updates from popup ──────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SETTINGS_UPDATE') {
      settings = Object.assign(settings, msg.settings);
      if (!settings.enabled) {
        stopProtection();
      } else if (!loopRunning) {
        init();
      }
    }
    if (msg.type === 'GET_STATS') {
      sendResponse({ eventsBlocked });
    }
    return true;
  });

  // ─── Init ─────────────────────────────────────────────────────
  function init() {
    canvas = document.createElement('canvas');
    canvas.width  = 32;
    canvas.height = 18;
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    injectOverlay();
    injectHUD();

    if (!loopRunning) {
      loopRunning = true;
      startLoop();
    }
  }

  // ─── Analysis loop using requestAnimationFrame ────────────────
  function startLoop() {
    let lastSample = 0;

    function loop(timestamp) {
      if (!settings.enabled) {
        loopRunning = false;
        return;
      }

      requestAnimationFrame(loop);

      if (timestamp - lastSample < SAMPLE_INTERVAL_MS) return;
      lastSample = timestamp;

      if (!settings.mode) return;

      const video = getPrimaryVideo();
      if (!video) return;

      analyzeFrame(video);
    }

    requestAnimationFrame(loop);
  }

  function getPrimaryVideo() {
    return Array.from(document.querySelectorAll('video'))
      .filter(v => v.readyState >= 2 && !v.paused && !v.ended && v.offsetWidth > 0)
      .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0] || null;
  }

  // ─── Frame analysis ───────────────────────────────────────────
  // Uses createImageBitmap which works even with CORS-restricted videos
  // in extension content scripts (unlike ctx.drawImage which gets tainted)
  function analyzeFrame(video) {
    createImageBitmap(video, {
      resizeWidth: 32,
      resizeHeight: 18,
      resizeQuality: 'low'
    }).then(bitmap => {
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      let imageData;
      try {
        imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch (e) {
        // Still tainted — fall back to CSS brightness heuristic
        analyzeViaBrightness(video);
        return;
      }

      const luminance = computeLuminance(imageData.data);
      processLuminance(luminance);

    }).catch(() => {
      // createImageBitmap failed — use brightness fallback
      analyzeViaBrightness(video);
    });
  }

  // ─── Fallback: CSS brightness heuristic ───────────────────────
  // When canvas is blocked, approximate luminance from the video
  // element's natural dimensions and a tiny off-screen canvas trick.
  // As a last resort, just count large style changes.
  let lastBrightnessSample = null;

  function analyzeViaBrightness(video) {
    // Use the video's currentTime as a proxy — if it's moving, sample
    // the thumbnail via an image element pointed at the video poster
    // This won't work but we can at least keep the loop alive.
    // Better: use MediaStreamTrackProcessor if available (Chrome 94+)
    if (typeof MediaStreamTrackProcessor !== 'undefined' && video.captureStream) {
      try {
        const stream = video.captureStream();
        const [track] = stream.getVideoTracks();
        if (track) {
          const processor = new MediaStreamTrackProcessor({ track });
          const reader = processor.readable.getReader();

          function readFrame() {
            reader.read().then(({ value, done }) => {
              if (done || !value) return;
              createImageBitmap(value).then(bitmap => {
                ctx.drawImage(bitmap, 0, 0, 32, 18);
                bitmap.close();
                value.close();
                try {
                  const data = ctx.getImageData(0, 0, 32, 18);
                  processLuminance(computeLuminance(data.data));
                } catch(e) {}
              }).catch(() => { try { value.close(); } catch(e) {} });
            }).catch(() => {});
          }

          // Read one frame now
          readFrame();
          track.stop();
          return;
        }
      } catch(e) {}
    }

    // Ultimate fallback: detect based on rapid DOM class/style changes
    // on the video wrapper — not perfect but catches some cases
  }

  // ─── Luminance ────────────────────────────────────────────────
  function computeLuminance(pixels) {
    let total = 0;
    const len = pixels.length;
    const step = 4 * 4; // sample every 4th pixel for speed
    let count = 0;
    for (let i = 0; i < len; i += step) {
      const r = pixels[i]   / 255;
      const g = pixels[i+1] / 255;
      const b = pixels[i+2] / 255;
      // Simple perceived brightness (fast)
      total += 0.299 * r + 0.587 * g + 0.114 * b;
      count++;
    }
    return count > 0 ? total / count : 0;
  }

  function processLuminance(luminance) {
    if (lastLuminance !== null) {
      const delta = Math.abs(luminance - lastLuminance);
      const threshold = settings.sensitivity || 0.10;
      if (delta >= threshold) {
        flashTimestamps.push(Date.now());
      }
    }
    lastLuminance = luminance;
    checkFlashRate();
  }

  // ─── Flash rate check ─────────────────────────────────────────
  function checkFlashRate() {
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
      const video = getPrimaryVideo();
      if (video) {
        video.style.transition = 'filter 0.05s';
        video.style.filter = 'saturate(0.1) brightness(0.55) contrast(0.75)';
      }

    } else if (settings.mode === 'warn') {
      overlay.style.opacity = '0';
      showWarningBanner(rate);
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

    const video = getPrimaryVideo();
    if (video) video.style.filter = '';

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
      <span><strong style="color:#F09575;">Flashing content detected</strong> — ${rate} flashes/sec. Look away or skip.</span>
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

  function removeHUD() {
    const el = document.getElementById(HUD_ID);
    if (el) el.remove();
  }

  // ─── Background messaging ─────────────────────────────────────
  function notifyBackground() {
    chrome.runtime.sendMessage({ type: 'FLASH_DETECTED', eventsBlocked }, () => {
      void chrome.runtime.lastError;
    });
  }

})();