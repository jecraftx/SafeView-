/**
 * SafeView Popup Script
 * ======================
 * Handles the popup UI, reads/writes settings via chrome.storage,
 * and pushes updates to content scripts on active tab.
 *
 * NOTE: No inline event handlers are used in popup.html — Chrome
 * extensions block them via CSP. All listeners are registered here.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────
let settings = {
  enabled: true,
  mode: null,
  dimLevel: 0.65,
  sensitivity: 0.10,
  onboarded: false,
};

const SENS_MAP = {
  1: { label: 'Low',    value: 0.18 },
  2: { label: 'Medium', value: 0.10 },
  3: { label: 'High',   value: 0.05 },
};

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['safeview_settings'], (result) => {
    if (result.safeview_settings) {
      settings = Object.assign(settings, result.safeview_settings);
    }
    if (settings.onboarded && settings.mode) {
      showMain();
    } else {
      showOnboard();
    }
  });

  // ── Onboarding: mode card selection ──
  const modesList = document.getElementById('ob-modes-list');
  if (modesList) {
    modesList.addEventListener('click', (e) => {
      const card = e.target.closest('.ob-mode');
      if (!card) return;
      document.querySelectorAll('.ob-mode').forEach(m => m.classList.remove('selected'));
      card.classList.add('selected');
      selectedOnboardMode = card.dataset.mode;
      document.getElementById('ob-confirm').disabled = false;
    });
  }

  // ── Onboarding: confirm button ──
  document.getElementById('ob-confirm').addEventListener('click', completeOnboarding);

  // ── Master toggle ──
  document.getElementById('master-toggle').addEventListener('click', toggleMaster);

  // ── Mode pills ──
  document.querySelectorAll('.mode-pill').forEach(pill => {
    pill.addEventListener('click', () => setMode(pill.dataset.mode));
  });

  // ── Dim slider ──
  document.getElementById('dim-slider').addEventListener('input', function () {
    updateDim(this);
  });

  // ── Sensitivity slider ──
  document.getElementById('sens-slider').addEventListener('input', function () {
    updateSens(this);
  });

  // ── Site toggles ──
  document.querySelectorAll('.site-toggle').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('on'));
  });

  // ── Footer: change mode ──
  document.getElementById('btn-change-mode').addEventListener('click', resetOnboarding);

  // Poll for events blocked stat
  setInterval(refreshStats, 2000);
});

// ─── Onboarding ───────────────────────────────────────────────
let selectedOnboardMode = null;

function completeOnboarding() {
  if (!selectedOnboardMode) return;
  settings.mode      = selectedOnboardMode;
  settings.onboarded = true;
  saveSettings();
  showMain();
}

function resetOnboarding() {
  settings.onboarded = false;
  settings.mode      = null;
  selectedOnboardMode = null;
  saveSettings();
  showOnboard();
}

function showOnboard() {
  document.getElementById('screen-onboard').classList.add('active');
  document.getElementById('screen-main').classList.remove('active');
}

function showMain() {
  document.getElementById('screen-onboard').classList.remove('active');
  document.getElementById('screen-main').classList.add('active');
  renderMain();
}

// ─── Main render ──────────────────────────────────────────────
function renderMain() {
  // Master toggle
  const masterToggle = document.getElementById('master-toggle');
  const masterLabel  = document.getElementById('master-label');
  masterToggle.className = 'toggle' + (settings.enabled ? ' on' : '');
  masterLabel.textContent = settings.enabled ? 'On' : 'Off';
  document.body.className = settings.enabled ? '' : 'disabled';

  // Mode pills
  document.querySelectorAll('.mode-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.mode === settings.mode);
  });

  // Dim slider visibility
  const dimRow = document.getElementById('dim-level-row');
  dimRow.style.display = settings.mode === 'dim' ? 'block' : 'none';

  // Dim slider value
  const dimPct = Math.round((settings.dimLevel || 0.65) * 100);
  document.getElementById('dim-slider').value = dimPct;
  document.getElementById('dim-val').textContent = dimPct + '%';

  // Sensitivity slider
  const sensEntry = Object.entries(SENS_MAP).find(([,v]) => v.value === settings.sensitivity);
  const sensLevel = sensEntry ? parseInt(sensEntry[0]) : 2;
  document.getElementById('sens-slider').value = sensLevel;
  document.getElementById('sens-val').textContent = SENS_MAP[sensLevel].label;

  // Mode stat label
  const modeLabels = { dim: 'Dim', suppress: 'Filter', warn: 'Warn' };
  document.getElementById('stat-mode-label').textContent = modeLabels[settings.mode] || '—';

  // Status bar
  updateStatusBar();
}

function updateStatusBar() {
  const bar  = document.getElementById('status-bar');
  const text = document.getElementById('status-text');
  if (settings.enabled) {
    bar.className = 'status-bar';
    text.textContent = 'Monitoring — no threats detected';
  } else {
    bar.className = 'status-bar';
    text.textContent = 'Protection paused';
    document.querySelector('.status-dot').style.background = 'rgba(255,255,255,0.3)';
  }
}

// ─── Controls ─────────────────────────────────────────────────
function toggleMaster() {
  settings.enabled = !settings.enabled;
  saveSettings();
  renderMain();
  pushToContentScript();
}

function setMode(mode) {
  settings.mode = mode;
  saveSettings();
  renderMain();
  pushToContentScript();
}

function updateDim(el) {
  settings.dimLevel = parseInt(el.value) / 100;
  document.getElementById('dim-val').textContent = el.value + '%';
  saveSettings();
  pushToContentScript();
}

function updateSens(el) {
  const level = parseInt(el.value);
  settings.sensitivity = SENS_MAP[level].value;
  document.getElementById('sens-val').textContent = SENS_MAP[level].label;
  saveSettings();
  pushToContentScript();
}

// ─── Stats refresh ────────────────────────────────────────────
function refreshStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATS' }, () => {
      void chrome.runtime.lastError;
    });
  });

  chrome.runtime.sendMessage({ type: 'GET_TOTAL_EVENTS' }, (response) => {
    void chrome.runtime.lastError;
    if (!response) return;
    const n = response.total || 0;
    document.getElementById('stat-blocked').textContent = n;
    document.getElementById('events-badge').textContent = n + ' blocked';
  });
}

// ─── Persistence & messaging ──────────────────────────────────
function saveSettings() {
  chrome.storage.sync.set({ safeview_settings: settings });
}

function pushToContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: 'SETTINGS_UPDATE', settings },
      () => { void chrome.runtime.lastError; }
    );
  });
}