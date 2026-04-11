"use strict";

// ─── Config ─────────────────────────────────────────────────────────────────
const MAX_REC_SECS  = 15;
const COUNTDOWN_FROM = 3;
const MPH_TO_KPH    = 1.60934;
const MPH_TO_FPS    = 1.46667;
const MPH_TO_MPS    = 0.44704;

// ─── Settings ────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  tableSize:      "9ft",
  theme:          "dark",
  units:          "mph",
  targetAttempts: 3,
};

// ─── Coaching Config ──────────────────────────────────────────────────────────
// Tweak these constants to adjust coaching dashboard sensitivity.
const COACH_CONFIG = {
  ZONE_LOW_PCT:    0.90,  // bottom of target zone = 90% of benchmark
  ZONE_HIGH_PCT:   1.00,  // top of zone = 100% (benchmark itself)
  RECENT_WINDOW:   6,     // how many recent attempts to show in consistency dots
  MIN_HIGH_READS:  1,     // minimum HIGH-conf reads required to set a benchmark
};

// ─── Outcome Tagging Config ────────────────────────────────────────────────────
// Mirrors the server-side OUTCOME_WEIGHTS — adjust for display and UX timing.
const OUTCOME_CONFIG = {
  TAG_DELAY_MS:   1100,   // ms to wait after results screen before sheet appears
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("bsa_settings") || "{}");
    return { ...DEFAULT_SETTINGS, ...s };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  try { localStorage.setItem("bsa_settings", JSON.stringify(s)); } catch {}
}

let settings = loadSettings();

function applyTheme() {
  document.body.setAttribute("data-theme", settings.theme);
}

// ─── Profile state ────────────────────────────────────────────────────────────
let profiles      = [];
let activeProfile = null;   // full profile object or null

function loadActiveProfileId() {
  try { return localStorage.getItem("bsa_active_profile") || null; } catch { return null; }
}
function saveActiveProfileId(id) {
  try { localStorage.setItem("bsa_active_profile", id || ""); } catch {}
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function apiGet(path) {
  const r = await fetch("/api" + path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch("/api" + path, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function apiPut(path, body) {
  const r = await fetch("/api" + path, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function apiDelete(path) {
  const r = await fetch("/api" + path, { method: "DELETE" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function apiPatch(path, body) {
  const r = await fetch("/api" + path, { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

// ─── State ───────────────────────────────────────────────────────────────────
let recordings     = [];
let selectedFiles  = [];
let isRecording    = false;
let stage          = "idle";

let mediaRecorder  = null;
let recChunks      = [];
let recStartMs     = null;
let micStream      = null;
let audioCtx       = null;
let analyserNode   = null;

let countdownTimer   = null;
let recTimerInterval = null;
let recAutoStop      = null;
let levelRaf         = null;
let savedAutoAdvance = null;

// Outcome tag sheet state
let tagSessionId    = null;   // session to tag
let tagProfileId    = null;   // profile that owns the session
let tagRackConfig   = null;   // rackConfig for money-ball label
let tagBestSpeed    = null;   // best speed for subtitle display
let tagBestConf     = null;   // confidence of best reading
let tagSheetTimer   = null;   // delayed show timer
let tagToggles      = { scratched: false, objectBallPocketed: false, moneyBallOnBreak: false };

// History state
let historyData    = [];
let histFilter     = "all";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const screenHero      = document.getElementById("screenHero");
const screenSession   = document.getElementById("screenSession");
const screenAnalyzing = document.getElementById("screenAnalyzing");
const screenResults   = document.getElementById("screenResults");
const screenDashboard = document.getElementById("screenDashboard");

const bottomNav       = document.getElementById("bottomNav");
const bnavAnalyze     = document.getElementById("bnavAnalyze");
const bnavStats       = document.getElementById("bnavStats");
const bnavSettings    = document.getElementById("bnavSettings");

const settingsOverlay = document.getElementById("settingsOverlay");
const settingsClose   = document.getElementById("settingsClose");

const profileOverlay     = document.getElementById("profileOverlay");
const profileDrawerClose = document.getElementById("profileDrawerClose");
const profileList        = document.getElementById("profileList");
const newProfileBtn      = document.getElementById("newProfileBtn");

const profileModal       = document.getElementById("profileModal");
const profileModalTitle  = document.getElementById("profileModalTitle");
const profileModalName   = document.getElementById("profileModalName");
const profileModalCancel = document.getElementById("profileModalCancel");
const profileModalSave   = document.getElementById("profileModalSave");
const profileColorPicker = document.getElementById("profileColorPicker");

const confirmModal  = document.getElementById("confirmModal");
const confirmTitle  = document.getElementById("confirmTitle");
const confirmMsg    = document.getElementById("confirmMsg");
const confirmCancel = document.getElementById("confirmCancel");
const confirmOk     = document.getElementById("confirmOk");

const toastEl       = document.getElementById("toast");

const startSessionBtn = document.getElementById("startSessionBtn");
const backToHeroBtn   = document.getElementById("backToHeroBtn");
const newSessionBtn   = document.getElementById("newSessionBtn");
const heroSub         = document.getElementById("heroSub");

const panelCountdown  = document.getElementById("panelCountdown");
const panelRecording  = document.getElementById("panelRecording");
const panelSaved      = document.getElementById("panelSaved");
const panelRack       = document.getElementById("panelRack");
const panelIdle       = document.getElementById("panelIdle");
const rackReadyBtn    = document.getElementById("rackReadyBtn");
const rackReadyBtnLabel = document.getElementById("rackReadyBtnLabel");
const rackSub         = document.getElementById("rackSub");

const countdownNum    = document.getElementById("countdownNum");
const recAttemptLabel = document.getElementById("recAttemptLabel");
const recElapsed      = document.getElementById("recElapsed");
const levelFill       = document.getElementById("levelFill");
const stopRecBtn      = document.getElementById("stopRecBtn");
const nextRecBtn      = document.getElementById("nextRecBtn");
const nextRecBtnLabel = document.getElementById("nextRecBtnLabel");
const savedList       = document.getElementById("savedList");
const analyzeBtn      = document.getElementById("analyzeBtn");
const addMoreBtn      = document.getElementById("addMoreBtn");
const sessionError    = document.getElementById("sessionError");

const tDots  = [0,1,2].map(i => document.getElementById(`tDot${i}`));
const tSteps = [0,1,2].map(i => document.getElementById(`tStep${i}`));
const tLines = [
  document.getElementById("tLine01"),
  document.getElementById("tLine12"),
];

const dropZone        = document.getElementById("dropZone");
const fileInput       = document.getElementById("fileInput");
const fileListEl      = document.getElementById("fileList");
const analyzeUploadBtn= document.getElementById("analyzeUploadBtn");
const clearUploadBtn  = document.getElementById("clearUploadBtn");

const resultsBestSpeed= document.getElementById("resultsBestSpeed");
const resultsBestLabel= document.getElementById("resultsBestLabel");
const resultsBestBadge= document.getElementById("resultsBestBadge");
const resultsSavedTag = document.getElementById("resultsSavedTag");
const resultsUnit     = document.getElementById("resultsUnit");
const statsAvg        = document.getElementById("statsAvg");
const statsAvgSub     = document.getElementById("statsAvgSub");
const statsConsistency= document.getElementById("statsConsistency");
const statsConsistencySub = document.getElementById("statsConsistencySub");
const insightCard     = document.getElementById("insightCard");
const insightText     = document.getElementById("insightText");
const tierCards       = document.getElementById("tierCards");
const diagBody        = document.getElementById("diagBody");
const diagSection     = document.querySelector(".diag-section");
const analyzingCount  = document.getElementById("analyzingCount");

// Dashboard
const dashEmpty     = document.getElementById("dashEmpty");
const dashInsight   = document.getElementById("dashInsight");
const dashInsightText = document.getElementById("dashInsightText");
const dashStatsGrid = document.getElementById("dashStatsGrid");
const dAvg          = document.getElementById("dAvg");
const dAvgSub       = document.getElementById("dAvgSub");
const dBest         = document.getElementById("dBest");
const dLast10       = document.getElementById("dLast10");
const dConsistency  = document.getElementById("dConsistency");
const dConsistencySub = document.getElementById("dConsistencySub");
const dTotal        = document.getElementById("dTotal");
const dTotalSub     = document.getElementById("dTotalSub");
const dHighPct      = document.getElementById("dHighPct");
const dHighSub      = document.getElementById("dHighSub");

// Outcome tag sheet
const tagOverlay  = document.getElementById("tagOverlay");
const tagRowsEl   = document.getElementById("tagRows");
const tagSubtitle = document.getElementById("tagSubtitle");
const tagSkipBtn  = document.getElementById("tagSkipBtn");
const tagSaveBtn  = document.getElementById("tagSaveBtn");
const tagCloseBtn = document.getElementById("tagCloseBtn");

// Coaching section
const coachingSection      = document.getElementById("coachingSection");
const coachBenchCard       = document.getElementById("coachBenchCard");
const coachBenchSpeed      = document.getElementById("coachBenchSpeed");
const coachBenchUnit       = document.getElementById("coachBenchUnit");
const coachLatestSpeed     = document.getElementById("coachLatestSpeed");
const coachLatestUnit      = document.getElementById("coachLatestUnit");
const coachLatestBadge     = document.getElementById("coachLatestBadge");
const coachLatestStatus    = document.getElementById("coachLatestStatus");
const coachLatestMsg       = document.getElementById("coachLatestMsg");
const coachConsistFraction = document.getElementById("coachConsistFraction");
const coachConsistWindow   = document.getElementById("coachConsistWindow");
const coachConsistDots     = document.getElementById("coachConsistDots");
const coachGaugeWrap       = document.getElementById("coachGaugeWrap");
const cglLatest            = document.getElementById("cglLatest");
const dashSectionHdr       = document.getElementById("dashSectionHdr");

// Pro gating elements
const proModalOverlay       = document.getElementById("proModalOverlay");
const proModalClose         = document.getElementById("proModalClose");
const proModalCta           = document.getElementById("proModalCta");
const proModalCtaText       = document.getElementById("proModalCtaText");
const proModalSpinner       = document.getElementById("proModalSpinner");
const proModalRestore       = document.getElementById("proModalRestore");
const proModalFeatureLbl    = document.getElementById("proModalFeatureLbl");
const proModalRestoreForm   = document.getElementById("proModalRestoreForm");
const proModalRestoreEmail  = document.getElementById("proModalRestoreEmail");
const proModalRestoreSubmit = document.getElementById("proModalRestoreSubmit");
const proModalRestoreCancel = document.getElementById("proModalRestoreCancel");
const proCoachPreview    = document.getElementById("proCoachPreview");
const proConsistPreview  = document.getElementById("proConsistPreview");
const consistChartCard   = document.getElementById("consistChartCard");
const proExtrasSection   = document.getElementById("proExtrasSection");
const settingsProLbl     = document.getElementById("settingsProLbl");
const settingsProIcon    = document.getElementById("settingsProIcon");
const settingsProBtn     = document.getElementById("settingsProBtn");

// History
const histList      = document.getElementById("histList");
const histEmpty     = document.getElementById("histEmpty");
const histFilters   = document.getElementById("histFilters");
const histClearBtn  = document.getElementById("histClearBtn");

// Profile pills (one per nav-bar-visible screen)
const pillElements = [
  { dot: document.getElementById("profilePillHeroDot"),  name: document.getElementById("profilePillHeroName"),  btn: document.getElementById("profilePillHero")  },
  { dot: document.getElementById("profilePillDashDot"),  name: document.getElementById("profilePillDashName"),  btn: document.getElementById("profilePillDash")  },
];

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, durationMs = 2800) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastEl.classList.remove("toast-hide");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add("toast-hide");
    setTimeout(() => { toastEl.hidden = true; toastEl.classList.remove("toast-hide"); }, 350);
  }, durationMs);
}

// ─── Confirm modal ────────────────────────────────────────────────────────────
let confirmResolver = null;
function showConfirm(title, msg, okLabel = "Delete") {
  confirmTitle.textContent = title;
  confirmMsg.textContent = msg;
  confirmOk.textContent = okLabel;
  confirmModal.hidden = false;
  return new Promise(resolve => { confirmResolver = resolve; });
}
confirmCancel.addEventListener("click", () => { confirmModal.hidden = true; confirmResolver?.(false); });
confirmOk.addEventListener("click",     () => { confirmModal.hidden = true; confirmResolver?.(true); });
confirmModal.addEventListener("click",  e => { if (e.target === confirmModal) { confirmModal.hidden = true; confirmResolver?.(false); } });

// ─── Settings UI ─────────────────────────────────────────────────────────────
function initSettings() {
  applyTheme();
  updateHeroSub();

  function syncOpts(containerId, key) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.querySelectorAll(".opt-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.value === String(settings[key]));
      btn.addEventListener("click", () => {
        settings[key] = btn.dataset.value;
        saveSettings(settings);
        c.querySelectorAll(".opt-btn").forEach(b => b.classList.toggle("active", b === btn));
        if (key === "theme") applyTheme();
        if (key === "units") chalUpdateUnitLabels();
        if (key === "targetAttempts") { updateHeroSub(); syncTrackerDots(); }
        if (key === "tableSize") {
          if (settings.tableSize === "custom") {
            setupState.tableMode = "custom";
          } else {
            setupState.tableMode = "standard";
            setupState.tableSize = settings.tableSize;
          }
          applySetupToUI();
          saveSetupToProfile();
          updateSettingsCustomTableUI();
        }
      });
    });
  }
  syncOpts("tableSizeOpts",  "tableSize");
  syncOpts("themeOpts",      "theme");
  syncOpts("unitsOpts",      "units");
  syncOpts("targetOpts",     "targetAttempts");
  updateSettingsCustomTableUI();
}

function updateSettingsCustomTableUI() {
  const customDiv = document.getElementById("settingsCustomTable");
  const lenInput  = document.getElementById("settingsTableLength");
  const widInput  = document.getElementById("settingsTableWidth");
  if (!customDiv) return;
  const isCustom = settings.tableSize === "custom";
  customDiv.hidden = !isCustom;
  if (isCustom && lenInput && widInput) {
    lenInput.value = setupState.customLengthIn;
    widInput.value = setupState.customWidthIn;
  }
}

document.getElementById("settingsTableLength")?.addEventListener("change", e => {
  const v = Math.min(120, Math.max(70, parseInt(e.target.value, 10) || setupState.customLengthIn));
  e.target.value = v;
  setupState.customLengthIn = v;
  updateSetupSummary();
  saveSetupToProfile();
});

document.getElementById("settingsTableWidth")?.addEventListener("change", e => {
  const v = Math.min(60, Math.max(35, parseInt(e.target.value, 10) || setupState.customWidthIn));
  e.target.value = v;
  setupState.customWidthIn = v;
  updateSetupSummary();
  saveSetupToProfile();
});

function updateHeroSub() {
  const t = Number(settings.targetAttempts);
  heroSub.textContent = `Record ${t} break${t !== 1 ? "s" : ""} for your most accurate reading`;
}

settingsClose.addEventListener("click", () => {
  settingsOverlay.hidden = true;
  bnavSettings.classList.toggle("active", false);
});
settingsOverlay.addEventListener("click", e => {
  if (e.target === settingsOverlay) {
    settingsOverlay.hidden = true;
    bnavSettings.classList.toggle("active", false);
  }
});

// History accordion inside settings
const histAccordionBtn  = document.getElementById("histAccordionBtn");
const histAccordionBody = document.getElementById("histAccordionBody");
const histAccordionArrow = document.getElementById("histAccordionArrow");
let histAccordionLoaded = false;
if (histAccordionBtn) {
  histAccordionBtn.addEventListener("click", () => {
    const open = !histAccordionBody.hidden;
    histAccordionBody.hidden = open;
    histAccordionArrow.textContent = open ? "▼" : "▲";
    if (!open && !histAccordionLoaded) {
      histAccordionLoaded = true;
      loadHistory();
    }
  });
}

// ─── Delete All Data ──────────────────────────────────────────────────────────
document.getElementById("deleteAllDataBtn")?.addEventListener("click", async () => {
  const yes = await showConfirm(
    "Delete All Data",
    "This will permanently delete all player profiles and break history. This cannot be undone.",
    "Delete All"
  );
  if (!yes) return;
  try {
    const allProfiles = await apiGet("/profiles");
    const list = Array.isArray(allProfiles) ? allProfiles : (allProfiles?.profiles ?? []);
    for (const p of list) {
      await apiDelete("/profiles/" + p.id);
    }
    profiles = [];
    activeProfile = null;
    saveActiveProfileId(null);
    updateProfilePills();
    settingsOverlay.hidden = true;
    showToast("All data deleted");
  } catch (err) {
    console.error("Delete all data failed:", err);
    showToast("Failed to delete data");
  }
});

// ─── Screen switching ─────────────────────────────────────────────────────────
const NAV_SCREENS = new Set([screenHero, screenResults, screenDashboard]);

function showScreen(screen) {
  [screenHero, screenSession, screenAnalyzing, screenResults, screenDashboard]
    .forEach(s => { if (s) s.hidden = s !== screen; });
  const showNav = NAV_SCREENS.has(screen);
  if (bottomNav) bottomNav.hidden = !showNav;
  // sync active tab
  if (screen === screenHero || screen === screenResults) setActiveTab("analyze");
  else if (screen === screenDashboard) setActiveTab("stats");
  // Signal Android layer: hide native banner during analysis/results, show elsewhere
  const adsAllowedOnScreen = screen !== screenAnalyzing && screen !== screenResults;
  window.Android?.setAdVisible(adsAllowedOnScreen);
}

function setActiveTab(tab) {
  bnavAnalyze.classList.toggle("active", tab === "analyze");
  bnavStats.classList.toggle("active",   tab === "stats");
  bnavSettings.classList.toggle("active", false);
}

// Bottom nav
bnavAnalyze.addEventListener("click", () => showScreen(screenHero));
bnavStats.addEventListener("click",   () => {
  showScreen(screenDashboard);
  if (dashActiveTabId === "compare") {
    if (compareViewEl) compareViewEl.hidden = false;
    if (personalViewEl) personalViewEl.hidden = true;
    loadCompareView();
  } else {
    if (compareViewEl) compareViewEl.hidden = true;
    if (personalViewEl) personalViewEl.hidden = false;
    loadDashboard();
  }
});
bnavSettings.addEventListener("click", () => {
  settingsOverlay.hidden = false;
  bnavSettings.classList.toggle("active", true);
});

// ─── Profile pills ─────────────────────────────────────────────────────────────
function updateProfilePills() {
  const name  = activeProfile?.displayName || "No Player";
  const color = activeProfile?.colorAccent || "#aaa";
  pillElements.forEach(({ dot, name: nameEl, btn }) => {
    if (dot) dot.style.background = color;
    if (nameEl) nameEl.textContent = name;
    if (btn) btn.style.setProperty("--pill-color", color);
  });
}

pillElements.forEach(({ btn }) => {
  btn?.addEventListener("click", () => openProfileDrawer());
});

// ─── Profile drawer ────────────────────────────────────────────────────────────
function openProfileDrawer() {
  renderProfileList();
  profileOverlay.hidden = false;
}
function closeProfileDrawer() { profileOverlay.hidden = true; }

profileDrawerClose.addEventListener("click", closeProfileDrawer);
profileOverlay.addEventListener("click", e => {
  if (e.target === profileOverlay) closeProfileDrawer();
});

function renderProfileList() {
  profileList.innerHTML = "";
  if (profiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "profile-list-empty";
    empty.textContent = "No players yet. Add your first player.";
    profileList.appendChild(empty);
    return;
  }
  profiles.forEach(p => {
    const item = document.createElement("div");
    item.className = "profile-item" + (p.id === activeProfile?.id ? " active" : "");
    item.innerHTML =
      `<span class="profile-item-dot" style="background:${p.colorAccent}"></span>` +
      `<span class="profile-item-name">${p.displayName}</span>`;

    const actions = document.createElement("div");
    actions.className = "profile-item-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "profile-action-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", e => { e.stopPropagation(); openEditProfile(p); });

    const delBtn = document.createElement("button");
    delBtn.className = "profile-action-btn profile-action-del";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", e => { e.stopPropagation(); deleteProfileFlow(p); });

    actions.append(editBtn, delBtn);
    item.appendChild(actions);

    item.addEventListener("click", () => {
      setActiveProfile(p);
      closeProfileDrawer();
    });
    profileList.appendChild(item);
  });
}

newProfileBtn.addEventListener("click", () => openNewProfile());

// ─── Profile modal ─────────────────────────────────────────────────────────────
let profileModalMode = "new"; // "new" | "edit"
let profileModalTarget = null;
let selectedColor = "#00d4ff";

function openNewProfile() {
  profileModalMode = "new";
  profileModalTarget = null;
  profileModalTitle.textContent = "New Player";
  profileModalName.value = "";
  selectedColor = "#00d4ff";
  syncColorPicker();
  closeProfileDrawer();
  profileModal.hidden = false;
  setTimeout(() => profileModalName.focus(), 100);
}

function openEditProfile(profile) {
  profileModalMode = "edit";
  profileModalTarget = profile;
  profileModalTitle.textContent = "Edit Player";
  profileModalName.value = profile.displayName;
  selectedColor = profile.colorAccent || "#00d4ff";
  syncColorPicker();
  closeProfileDrawer();
  profileModal.hidden = false;
  setTimeout(() => profileModalName.focus(), 100);
}

function syncColorPicker() {
  profileColorPicker.querySelectorAll(".color-swatch").forEach(s => {
    s.classList.toggle("active", s.dataset.color === selectedColor);
  });
}

profileColorPicker.querySelectorAll(".color-swatch").forEach(s => {
  s.addEventListener("click", () => {
    selectedColor = s.dataset.color;
    syncColorPicker();
  });
});

profileModalCancel.addEventListener("click", () => { profileModal.hidden = true; openProfileDrawer(); });
profileModal.addEventListener("click", e => {
  if (e.target === profileModal) { profileModal.hidden = true; openProfileDrawer(); }
});

profileModalSave.addEventListener("click", async () => {
  const name = profileModalName.value.trim();
  if (!name) { profileModalName.focus(); return; }
  profileModalSave.disabled = true;
  try {
    if (profileModalMode === "new") {
      const p = await apiPost("/profiles", { displayName: name, colorAccent: selectedColor });
      profiles.push(p);
      if (!activeProfile) setActiveProfile(p);
      buildDashTabs();
    } else {
      const p = await apiPut("/profiles/" + profileModalTarget.id, { displayName: name, colorAccent: selectedColor });
      const idx = profiles.findIndex(x => x.id === p.id);
      if (idx >= 0) profiles[idx] = p;
      if (activeProfile?.id === p.id) { activeProfile = p; updateProfilePills(); }
      invalidateCmpCache(p.id);
      buildDashTabs();
    }
    profileModal.hidden = false;
  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    profileModalSave.disabled = false;
    profileModal.hidden = true;
  }
});

profileModalName.addEventListener("keydown", e => { if (e.key === "Enter") profileModalSave.click(); });

async function deleteProfileFlow(profile) {
  const yes = await showConfirm(
    `Delete "${profile.displayName}"?`,
    "This will permanently delete the player and all their break history.",
    "Delete Player"
  );
  if (!yes) { openProfileDrawer(); return; }
  try {
    await apiDelete("/profiles/" + profile.id);
    profiles = profiles.filter(p => p.id !== profile.id);
    invalidateCmpCache(profile.id);
    cmpSelectedIds.delete(profile.id);
    if (activeProfile?.id === profile.id) {
      activeProfile = profiles[0] || null;
      saveActiveProfileId(activeProfile?.id || null);
      updateProfilePills();
      if (activeProfile) dashActiveTabId = activeProfile.id;
    }
    buildDashTabs();
    showToast("Player deleted");
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

function setActiveProfile(profile) {
  activeProfile = profile;
  saveActiveProfileId(profile?.id || null);
  updateProfilePills();
  loadSetupFromProfile();
  // Refresh history accordion if it's open
  if (histAccordionBody && !histAccordionBody.hidden) {
    histAccordionLoaded = true;
    loadHistory();
  } else {
    histAccordionLoaded = false;
  }
  // Refresh stats dashboard immediately if it's visible and on a personal tab
  if (!screenDashboard.hidden && dashActiveTabId !== "compare") {
    switchDashTab(profile.id);
  } else if (!screenDashboard.hidden) {
    buildDashTabs(); // update tab highlight only
  }
}

// ─── Load profiles on startup ─────────────────────────────────────────────────
async function loadProfiles() {
  try {
    profiles = await apiGet("/profiles");
    const savedId = loadActiveProfileId();
    const found = profiles.find(p => p.id === savedId);
    activeProfile = found || profiles[0] || null;
    if (activeProfile) saveActiveProfileId(activeProfile.id);
  } catch {
    profiles = [];
    activeProfile = null;
  }
  updateProfilePills();
  buildDashTabs();
}

// ─── Tracker ─────────────────────────────────────────────────────────────────
function syncTrackerDots() {
  const target = Number(settings.targetAttempts);
  tSteps.forEach((step, i) => {
    step.style.display = i < Math.min(target, 3) ? "" : "none";
  });
  tLines.forEach((line, i) => {
    line.style.display = i < Math.min(target, 3) - 1 ? "" : "none";
  });
}

function updateTracker() {
  const target = Math.min(Number(settings.targetAttempts), 3);
  tDots.forEach((dot, i) => {
    const step = tSteps[i];
    dot.classList.remove("active", "done");
    step.classList.remove("active", "done");
    if (i >= target) return;

    if (i < recordings.length) {
      dot.classList.add("done");
      step.classList.add("done");
    } else if (i === recordings.length && (stage === "countdown" || stage === "recording")) {
      dot.classList.add("active");
      step.classList.add("active");
    }
  });
  tLines[0].classList.toggle("done", recordings.length >= 2);
  tLines[1].classList.toggle("done", recordings.length >= 3);
}

// ─── Stage panels ─────────────────────────────────────────────────────────────
function showStage(name) {
  stage = name;
  [panelCountdown, panelRecording, panelSaved, panelRack, panelIdle].forEach(p => p.hidden = true);
  if (name === "countdown") panelCountdown.hidden = false;
  if (name === "recording") panelRecording.hidden = false;
  if (name === "saved")     panelSaved.hidden = false;
  if (name === "rack")      panelRack.hidden = false;
  if (name === "idle")      panelIdle.hidden = false;
  updateTracker();
  // Signal Android layer: hide native banner during countdown and recording
  const adsAllowedOnStage = name === "idle" || name === "rack";
  window.Android?.setAdVisible(adsAllowedOnStage);
}

// ─── Monetization state ───────────────────────────────────────────────────────
const ADS_REMOVED_KEY = "bsc_adsRemoved";

// adsEnabled: master switch (Android layer can override). adsRemoved: user paid.
let adsEnabled = true;
let adsRemoved  = localStorage.getItem(ADS_REMOVED_KEY) === "1";

function setAdsRemoved(val) {
  adsRemoved = !!val;
  localStorage.setItem(ADS_REMOVED_KEY, adsRemoved ? "1" : "0");
  applyAdsState();
}

function setAdsEnabled(val) {
  adsEnabled = !!val;
  applyAdsState();
}

function applyAdsState() {
  const banner     = document.getElementById("adBanner");
  const upgradeRow = document.getElementById("settingsUpgradeEntry");
  const adFreeBadge= document.getElementById("settingsAdFreeBadge");
  const restoreRow = document.getElementById("settingsRestoreBtn");
  const showAds    = adsEnabled && !adsRemoved;

  if (banner)      banner.hidden      = !showAds;
  if (upgradeRow)  upgradeRow.hidden  = adsRemoved;
  if (adFreeBadge) adFreeBadge.hidden = !adsRemoved;
  if (restoreRow)  restoreRow.hidden  = adsRemoved;
}

// ─── Android bridge ───────────────────────────────────────────────────────────
// Called by Android layer to update monetization state or pass other events.
window.onNativeMessage = function(data) {
  if (!data) return;
  if (data.adsRemoved === true)  setAdsRemoved(true);
  if (data.adsRemoved === false) setAdsRemoved(false);
  if (data.adsEnabled === false) setAdsEnabled(false);
  if (data.adsEnabled === true)  setAdsEnabled(true);
};
// Direct handle — Android can call window.setAdsRemoved(true) from WebView
window.setAdsRemoved = setAdsRemoved;
window.setAdsEnabled = setAdsEnabled;

// ─── Upgrade modal ─────────────────────────────────────────────────────────────
function openUpgradeModal() {
  document.getElementById("upgradeOverlay").hidden = false;
}
function closeUpgradeModal() {
  document.getElementById("upgradeOverlay").hidden = true;
}

document.getElementById("settingsUpgradeEntry")?.addEventListener("click", () => {
  settingsOverlay.hidden = true;
  openUpgradeModal();
});

document.getElementById("upgradeClose")?.addEventListener("click", closeUpgradeModal);
document.getElementById("upgradeOverlay")?.addEventListener("click", e => {
  if (e.target === document.getElementById("upgradeOverlay")) closeUpgradeModal();
});

document.getElementById("upgradeBtn")?.addEventListener("click", () => {
  // Production: delegate to Android in-app billing
  if (window.Android?.launchPurchaseFlow) {
    window.Android.launchPurchaseFlow("remove_ads");
  } else {
    // Dev/web simulation — toggle ad-free on
    setAdsRemoved(true);
    closeUpgradeModal();
    showToast("Ad-Free Enabled ✓");
  }
});

function handleRestorePurchase() {
  if (window.Android?.restorePurchases) {
    window.Android.restorePurchases();
    return;
  }
  // Web: open the pro modal and immediately show the restore email form
  openProModal("all");
  // Delay slightly so the modal is visible before we switch to restore mode
  setTimeout(() => {
    proModalRestore.hidden = true;
    proModalRestoreForm.hidden = false;
    setTimeout(() => proModalRestoreEmail.focus(), 50);
  }, 50);
}

document.getElementById("settingsRestoreBtn")?.addEventListener("click", () => {
  settingsOverlay.hidden = true;
  handleRestorePurchase();
});
document.getElementById("upgradeRestoreBtn")?.addEventListener("click", handleRestorePurchase);

// ─── Mic disclosure (shown once before first recording) ───────────────────────
const MIC_DISCLOSED_KEY = "bsc_micDisclosed";
function ensureMicDisclosure() {
  if (localStorage.getItem(MIC_DISCLOSED_KEY)) return Promise.resolve(true);
  return new Promise(resolve => {
    const overlay   = document.getElementById("micDisclosureOverlay");
    const allowBtn  = document.getElementById("micDisclosureAllow");
    const cancelBtn = document.getElementById("micDisclosureCancel");
    if (!overlay) { resolve(true); return; }
    overlay.hidden = false;
    const cleanup = () => {
      overlay.hidden = true;
      allowBtn.removeEventListener("click", onAllow);
      cancelBtn.removeEventListener("click", onCancel);
    };
    const onAllow  = () => { cleanup(); localStorage.setItem(MIC_DISCLOSED_KEY, "1"); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    allowBtn.addEventListener("click", onAllow);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// ─── Mic ─────────────────────────────────────────────────────────────────────
async function ensureMic() {
  if (micStream && micStream.active) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    const src = audioCtx.createMediaStreamSource(micStream);
    src.connect(analyserNode);
    return true;
  } catch (err) {
    const msg = err.name === "NotAllowedError"
      ? "Microphone access denied — check your browser permissions."
      : err.name === "NotFoundError"
        ? "No microphone found on this device."
        : "Could not access microphone: " + err.message;
    showSessionError(msg);
    return false;
  }
}

function showSessionError(msg) {
  sessionError.textContent = msg;
  sessionError.hidden = false;
  setTimeout(() => { sessionError.hidden = true; }, 7000);
}

// ─── Level meter ──────────────────────────────────────────────────────────────
function startLevel() {
  if (!analyserNode) return;
  const buf = new Uint8Array(analyserNode.frequencyBinCount);
  function tick() {
    analyserNode.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += (buf[i] - 128) ** 2;
    levelFill.style.width = Math.min(100, Math.sqrt(sum / buf.length) * 5.5) + "%";
    levelRaf = requestAnimationFrame(tick);
  }
  tick();
}
function stopLevel() {
  if (levelRaf) cancelAnimationFrame(levelRaf);
  levelRaf = null;
  levelFill.style.width = "0%";
}

// ─── Elapsed timer ────────────────────────────────────────────────────────────
function startElapsed() {
  recStartMs = Date.now();
  recElapsed.textContent = "0:00";
  recTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recStartMs) / 1000);
    recElapsed.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 250);
}
function stopElapsed() { clearInterval(recTimerInterval); }

// ─── MIME helpers ─────────────────────────────────────────────────────────────
function bestMime() {
  const c = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/mp4"];
  return c.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || "";
}
function extFromMime(m = "") {
  if (m.includes("webm")) return ".webm";
  if (m.includes("ogg"))  return ".ogg";
  if (m.includes("mp4"))  return ".mp4";
  return ".webm";
}

// ─── Countdown → record ───────────────────────────────────────────────────────
async function startCountdownThenRecord() {
  if (!(await ensureMicDisclosure())) { showStage("idle"); return; }
  if (!(await ensureMic())) { showStage("idle"); return; }
  let n = COUNTDOWN_FROM;
  countdownNum.textContent = n;
  showStage("countdown");

  countdownTimer = setInterval(async () => {
    n--;
    if (n <= 0) {
      clearInterval(countdownTimer); countdownTimer = null;
      beginRecording();
    } else {
      countdownNum.style.animation = "none";
      void countdownNum.offsetWidth;
      countdownNum.style.animation = "";
      countdownNum.textContent = n;
    }
  }, 900);
}

function beginRecording() {
  recChunks = [];
  const mime = bestMime();
  try { mediaRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : {}); }
  catch { mediaRecorder = new MediaRecorder(micStream); }
  mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) recChunks.push(e.data); };
  mediaRecorder.onstop = () => finalizeRecording(mediaRecorder.mimeType);
  mediaRecorder.start(100);
  isRecording = true;

  recAttemptLabel.textContent = `Recording Attempt ${recordings.length + 1}`;
  showStage("recording");
  startElapsed();
  startLevel();
  recAutoStop = setTimeout(() => { if (isRecording) stopRecording(); }, MAX_REC_SECS * 1000);
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  clearTimeout(recAutoStop); recAutoStop = null;
  isRecording = false;
  stopElapsed(); stopLevel();
  mediaRecorder.stop();
}

function finalizeRecording(mimeType) {
  if (recChunks.length === 0) return;
  const durationMs = recStartMs ? Date.now() - recStartMs : MAX_REC_SECS * 1000;
  const ext  = extFromMime(mimeType);
  const num  = recordings.length + 1;
  const blob = new Blob(recChunks, { type: mimeType || "audio/webm" });
  const url  = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => { const r = recordings.find(x => x.audio === audio); if (r) r.playing = false; renderSavedList(); };
  recordings.push({ blob, url, name: `attempt-${num}${ext}`, durationMs, mimeType, audio, playing: false });

  showStage("saved");
  renderSavedList();
  updateAnalyzeCTA();

  const target = Number(settings.targetAttempts);
  savedAutoAdvance = setTimeout(() => {
    if (recordings.length < target) {
      const nextNum = recordings.length + 1;
      rackReadyBtnLabel.textContent = `Break Attempt ${nextNum}`;
      rackSub.textContent = "Re-rack the balls, then tap when you're ready";
      showStage("rack");
    } else {
      nextRecBtnLabel.textContent = `Record Attempt ${recordings.length + 1}`;
      showStage("idle");
    }
  }, 1400);
}

rackReadyBtn.addEventListener("click", () => {
  sessionError.hidden = true;
  startCountdownThenRecord();
});

stopRecBtn.addEventListener("click", () => { if (isRecording) stopRecording(); });

nextRecBtn.addEventListener("click", () => {
  sessionError.hidden = true;
  startCountdownThenRecord();
});

addMoreBtn.addEventListener("click", () => {
  nextRecBtnLabel.textContent = `Record Attempt ${recordings.length + 1}`;
  showStage("idle");
});

// ─── Saved list ───────────────────────────────────────────────────────────────
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function renderSavedList() {
  savedList.innerHTML = "";
  recordings.forEach((rec, idx) => {
    const item = document.createElement("div");
    item.className = "saved-item";

    const numEl = document.createElement("div");
    numEl.className = "saved-item-num";
    numEl.textContent = idx + 1;

    const lbl = document.createElement("div");
    lbl.className = "saved-item-label";
    lbl.textContent = `Attempt ${idx + 1}`;

    const dur = document.createElement("div");
    dur.className = "saved-item-dur";
    dur.textContent = fmtDur(rec.durationMs);

    const playBtn = document.createElement("button");
    playBtn.className = "saved-item-play" + (rec.playing ? " playing" : "");
    playBtn.textContent = rec.playing ? "■ Stop" : "▶ Play";
    playBtn.addEventListener("click", () => togglePlay(rec));

    const delBtn = document.createElement("button");
    delBtn.className = "saved-item-del";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => {
      rec.audio.pause();
      URL.revokeObjectURL(rec.url);
      recordings.splice(idx, 1);
      recordings.forEach((r, i) => { r.name = `attempt-${i + 1}${extFromMime(r.mimeType)}`; });
      renderSavedList();
      updateAnalyzeCTA();
      updateTracker();
      nextRecBtnLabel.textContent = `Record Attempt ${recordings.length + 1}`;
      if (stage !== "recording" && stage !== "countdown") showStage("idle");
    });

    item.append(numEl, lbl, dur, playBtn, delBtn);
    savedList.appendChild(item);
  });
}

function togglePlay(rec) {
  recordings.forEach(r => {
    if (r !== rec && r.playing) { r.audio.pause(); r.audio.currentTime = 0; r.playing = false; }
  });
  if (rec.playing) {
    rec.audio.pause(); rec.audio.currentTime = 0; rec.playing = false;
  } else {
    rec.audio.currentTime = 0; rec.audio.play(); rec.playing = true;
  }
  renderSavedList();
}

function updateAnalyzeCTA() {
  const n = recordings.length;
  const target = Number(settings.targetAttempts);
  if (n === 0) { analyzeBtn.hidden = true; addMoreBtn.hidden = true; return; }
  analyzeBtn.hidden = false;
  addMoreBtn.hidden = n < target;
  analyzeBtn.textContent = n < target
    ? `→ Analyze (${n} attempt${n > 1 ? "s" : ""})`
    : "→ Analyze My Break";
}

// ─── Navigation ───────────────────────────────────────────────────────────────
startSessionBtn.addEventListener("click", () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    document.getElementById("uploadAccordion").open = true;
    return;
  }
  showScreen(screenSession);
  recordings = [];
  renderSavedList();
  updateAnalyzeCTA();
  syncTrackerDots();
  updateTracker();
  nextRecBtnLabel.textContent = "Record Attempt 1";
  showStage("idle");
  startCountdownThenRecord();
});

backToHeroBtn.addEventListener("click", () => {
  clearInterval(countdownTimer); countdownTimer = null;
  clearTimeout(recAutoStop); recAutoStop = null;
  clearTimeout(savedAutoAdvance); savedAutoAdvance = null;
  if (isRecording) { isRecording = false; mediaRecorder?.stop(); stopElapsed(); stopLevel(); }
  stopLevel();
  showScreen(screenHero);
});

newSessionBtn.addEventListener("click", () => {
  recordings = []; selectedFiles = [];
  renderSavedList(); renderFileList();
  updateAnalyzeCTA();
  showScreen(screenHero);
});

// ─── Upload file logic ────────────────────────────────────────────────────────
function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024*1024) return (b/1024).toFixed(1) + " KB";
  return (b/1024/1024).toFixed(1) + " MB";
}
function extOf(n) { return (n.split(".").pop() || "").toUpperCase(); }

function renderFileList() {
  fileListEl.innerHTML = "";
  const show = selectedFiles.length > 0;
  fileListEl.hidden = !show;
  analyzeUploadBtn.hidden = !show;
  clearUploadBtn.hidden = !show;
  selectedFiles.forEach((f, idx) => {
    const div = document.createElement("div");
    div.className = "file-item";
    const del = document.createElement("button");
    del.className = "fi-del";
    del.textContent = "×";
    del.addEventListener("click", () => { selectedFiles.splice(idx, 1); renderFileList(); });
    div.innerHTML =
      `<span class="fi-ext">${extOf(f.name)}</span>` +
      `<span class="fi-name">${f.name}</span>` +
      `<span class="fi-size">${formatBytes(f.size)}</span>`;
    div.appendChild(del);
    fileListEl.appendChild(div);
  });
}

function addFiles(newFiles) {
  const seen = new Set(selectedFiles.map(f => f.name + f.size));
  Array.from(newFiles).forEach(f => { if (!seen.has(f.name + f.size)) selectedFiles.push(f); });
  renderFileList();
}

fileInput.addEventListener("change", () => addFiles(fileInput.files));
dropZone.addEventListener("click", e => { if (!e.target.closest(".file-lbl")) fileInput.click(); });
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => { e.preventDefault(); dropZone.classList.remove("drag-over"); addFiles(e.dataTransfer.files); });
clearUploadBtn.addEventListener("click", () => { selectedFiles = []; fileInput.value = ""; renderFileList(); });

analyzeUploadBtn.addEventListener("click", () => runAnalysis("upload"));
analyzeBtn.addEventListener("click", () => runAnalysis("session"));

// ─── Analysis ─────────────────────────────────────────────────────────────────
async function runAnalysis(source) {
  clearTimeout(savedAutoAdvance); savedAutoAdvance = null;
  if (isRecording) stopRecording();
  if (stage === "countdown") { clearInterval(countdownTimer); countdownTimer = null; }

  const files = [];
  if (source === "session") {
    recordings.forEach(rec => files.push(new File([rec.blob], rec.name, { type: rec.mimeType })));
  } else {
    selectedFiles.forEach(f => files.push(f));
  }
  if (files.length === 0) return;

  analyzingCount.textContent = `${files.length} clip${files.length !== 1 ? "s" : ""}`;
  showScreen(screenAnalyzing);

  const formData = new FormData();
  files.forEach(f => formData.append("files", f));
  if (activeProfile?.id) {
    formData.append("profileId", activeProfile.id);
    formData.append("sourceType", source === "upload" ? "uploaded" : "recorded");
  }
  // Break setup params for distance-aware speed calculation
  formData.append("tableMode",      setupState.tableMode);
  formData.append("tableSize",      setupState.tableSize);
  formData.append("customLengthIn", String(setupState.customLengthIn));
  formData.append("customWidthIn",  String(setupState.customWidthIn));
  formData.append("rackConfig",     setupState.rackConfig);
  formData.append("breakPosition",  setupState.breakPosition);

  try {
    const resp = await fetch("/api/analyze", { method: "POST", body: formData });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(e.error || "Server error");
    }
    const data = await resp.json();
    renderResults(data);
    showScreen(screenResults);
    histAccordionLoaded = false; // history needs refresh after new session

    // Show save toast
    if (data.savedSession && activeProfile) {
      const tag = resultsSavedTag;
      if (tag) {
        tag.textContent = `Saved to ${data.savedSession.profileName}`;
        tag.hidden = false;
      }
      showToast(`Saved to ${data.savedSession.profileName}`);
    } else {
      if (resultsSavedTag) resultsSavedTag.hidden = true;
    }

    // Update active challenge progress after a saved break
    const best = data.session?.bestBreak || data.session?.topEstimate;
    if (best?.speedMph != null) onBreakSaved(best.speedMph);
    // Invalidate compare cache for this profile so next compare visit re-fetches
    if (data.savedSession) invalidateCmpCache(activeProfile?.id);

    // Show outcome tag sheet after a short delay so the user can see their result first
    clearTimeout(tagSheetTimer);
    if (data.savedSession?.sessionId && activeProfile) {
      const sid  = data.savedSession.sessionId;
      tagSheetTimer = setTimeout(
        () => showTagSheet(sid, activeProfile.id, setupState.rackConfig, best?.speedMph ?? null, best?.confidence ?? null),
        OUTCOME_CONFIG.TAG_DELAY_MS
      );
    }
  } catch (err) {
    showScreen(source === "session" ? screenSession : screenHero);
    showSessionError("Analysis failed: " + err.message);
  }
}

// ─── Confidence helpers ───────────────────────────────────────────────────────
const CONF = {
  high:      { sym: "●", label: "HIGH",     cls: "badge-high", coach: "Strong",   open: true  },
  near_high: { sym: "◐", label: "NEAR-HIGH", cls: "badge-near", coach: "Close",   open: true  },
  medium:    { sym: "◑", label: "MEDIUM",   cls: "badge-med",  coach: "Estimate", open: false },
  low:       { sym: "○", label: "LOW",      cls: "badge-low",  coach: "Retake",   open: false },
  very_low:  { sym: "○", label: "LOW",      cls: "badge-low",  coach: "Retake",   open: false },
};
function ci(c) { return CONF[c] || CONF.low; }
function badge(c) { const x = ci(c); return `<span class="badge ${x.cls}">${x.sym} ${x.label}</span>`; }

function convertSpeed(mph) {
  if (mph == null) return null;
  if (settings.units === "kph") return mph * MPH_TO_KPH;
  if (settings.units === "fps") return mph * MPH_TO_FPS;
  if (settings.units === "mps") return mph * MPH_TO_MPS;
  return mph;
}
function fmtSpeed(mph, conf) {
  const v = convertSpeed(mph);
  if (v == null) return "—";
  const precise = conf === "high" || conf === "near_high" || conf === "medium";
  return precise ? v.toFixed(1) : "~" + Math.round(v);
}

function animateSpeed(el, targetMph) {
  const target = convertSpeed(targetMph) || 0;
  const dur = 900;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = (target * e).toFixed(1);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = target.toFixed(1);
  }
  requestAnimationFrame(step);
}

// ─── Render results ───────────────────────────────────────────────────────────
function renderResults(data) {
  const { files, session } = data;

  // Unit label
  resultsUnit.textContent = settings.units;

  // Hero speed
  const best = session.bestBreak || session.topEstimate;
  if (best?.speedMph != null) {
    animateSpeed(resultsBestSpeed, best.speedMph);
    resultsBestLabel.textContent = session.bestBreak ? "Best Break" : "Top Estimate";
    resultsBestBadge.innerHTML = badge(best.confidence);
  } else {
    resultsBestSpeed.textContent = "—";
    resultsBestLabel.textContent = "No high-confidence reading";
    resultsBestBadge.innerHTML = "";
  }

  // Stats
  if (session.sessionAvg != null) {
    statsAvg.textContent = convertSpeed(session.sessionAvg).toFixed(1) + " " + settings.units;
    statsAvgSub.textContent = session.sessionAvgCount + " read" + (session.sessionAvgCount !== 1 ? "s" : "");
  } else {
    statsAvg.textContent = "—"; statsAvgSub.textContent = "";
  }
  statsConsistency.textContent = session.consistency?.label || "—";
  statsConsistencySub.textContent = session.consistency?.stdDev != null
    ? convertSpeed(session.consistency.stdDev).toFixed(2) + " " + settings.units + " σ" : "";

  // Insight
  if (session.interpretation) {
    insightText.textContent = session.interpretation;
    insightCard.hidden = false;
  } else {
    insightCard.hidden = true;
  }

  // Tier cards
  tierCards.innerHTML = "";
  const tiers = [
    { conf: "high",      label: "HIGH",     cls: "badge-high" },
    { conf: "near_high", label: "NEAR-HIGH", cls: "badge-near" },
    { conf: "medium",    label: "MEDIUM",   cls: "badge-med"  },
    { conf: "low",       label: "LOW",      cls: "badge-low"  },
  ];

  let globalRank = 1;
  tiers.forEach(tier => {
    const grp = tier.conf === "low"
      ? files.filter(f => f.confidence === "low" || f.confidence === "very_low")
      : files.filter(f => f.confidence === tier.conf);
    if (grp.length === 0) return;

    const info = ci(tier.conf);
    const isLow = tier.conf === "low";
    const card = document.createElement("div");
    card.className = "tier-card" + (isLow ? " tier-card-low" : "") + (info.open ? " open" : "");

    const header = document.createElement("div");
    header.className = "tier-card-header";
    header.innerHTML =
      `<span class="badge ${tier.cls}">${info.sym} ${tier.label}</span>` +
      (isLow
        ? `<span class="tier-card-count">Retake suggested</span>`
        : `<span class="tier-card-count">${grp.length} reading${grp.length !== 1 ? "s" : ""}</span>`) +
      `<span class="tier-card-chevron">›</span>`;
    header.addEventListener("click", () => card.classList.toggle("open"));

    const body = document.createElement("div");
    body.className = "tier-card-body";
    grp.forEach(f => {
      const row = document.createElement("div");
      row.className = "tier-row";
      const flagHtml = f.speedFlag ? ` <span class="badge badge-flag">${f.speedFlag.replace(/_/g," ")}</span>` : "";
      row.innerHTML =
        `<span class="tr-rank">${globalRank}</span>` +
        `<span class="tr-name" title="${f.filename}">${f.filename}</span>` +
        `<span class="tr-speed">${fmtSpeed(f.speedMph, f.confidence)}</span>` +
        `<span class="tr-label">${info.coach}${flagHtml}</span>`;
      body.appendChild(row);
      globalRank++;
    });

    card.append(header, body);
    tierCards.appendChild(card);
  });

  // Diagnostics — auto-expand when there's nothing useful to show
  const noGoodResult = !session.bestBreak && !session.topEstimate;
  if (diagSection) diagSection.open = noGoodResult;

  diagBody.innerHTML = "";
  files.forEach(f => {
    const tr = document.createElement("tr");
    if (f.confidence === "error") {
      tr.className = "diag-error-row";
      tr.innerHTML =
        `<td style="max-width:90px;overflow:hidden;text-overflow:ellipsis;">${f.filename}</td>` +
        `<td><span class="badge badge-err">✕ ERROR</span></td>` +
        `<td colspan="4" class="diag-err-msg">${f.error || "Could not decode file"}</td>`;
    } else {
      const v = x => x != null ? x.toFixed(3) : "—";
      const ps = f.pairScore, eq = f.eventQuality, tf = f.timingFactor, dr = f.dominanceRatio;
      tr.innerHTML =
        `<td style="color:var(--text-dim);max-width:90px;overflow:hidden;text-overflow:ellipsis;">${f.filename}</td>` +
        `<td>${badge(f.confidence)}</td>` +
        `<td class="${ps != null && ps < 0.72 ? "fail" : ""}">${v(ps)}</td>` +
        `<td class="${eq != null && eq < 1.10 ? "fail" : ""}">${v(eq)}</td>` +
        `<td class="${tf != null && tf < 0.90 ? "fail" : ""}">${v(tf)}</td>` +
        `<td class="${dr != null && dr < 0.20 && ps != null && ps < 0.85 ? "fail" : ""}">${v(dr)}</td>`;
    }
    diagBody.appendChild(tr);
  });

  // Show recording tips card when all files failed or no result
  if (noGoodResult && files.every(f => f.confidence === "error" || f.confidence === "low" || f.confidence === "very_low")) {
    if (insightCard) {
      insightText.textContent = files.some(f => f.confidence === "error")
        ? "Files could not be decoded. Check the error in Diagnostics below — ffmpeg may be unavailable or the file format unsupported."
        : "Signal too weak. Try: hold phone close to the head rail, reduce background noise, and ensure a full-power break.";
      insightCard.hidden = false;
    }
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  if (!activeProfile) {
    dashEmpty.hidden = false;
    dashStatsGrid.hidden = true;
    dashInsight.hidden = true;
    trendsSection.hidden = true;
    coachingSection.hidden = true;
    dashSectionHdr.hidden = true;
    return;
  }
  try {
    const [stats, history, outcomeCoaching] = await Promise.all([
      apiGet("/profiles/" + activeProfile.id + "/stats"),
      apiGet("/profiles/" + activeProfile.id + "/history"),
      apiGet("/profiles/" + activeProfile.id + "/outcome-coaching").catch(() => null),
    ]);
    renderCoachingSection(stats, history, outcomeCoaching);
    renderDashboard(stats);
    if (stats.totalAttempts > 0) loadTrends();
  } catch {
    dashEmpty.hidden = false;
    dashStatsGrid.hidden = true;
    dashInsight.hidden = true;
    trendsSection.hidden = true;
    coachingSection.hidden = true;
    dashSectionHdr.hidden = true;
  }
}

function fmtStat(mph) {
  if (mph == null) return "—";
  const v = convertSpeed(mph);
  return v.toFixed(1) + " " + settings.units;
}

function renderDashboard(stats) {
  const hasData = stats.totalAttempts > 0;
  dashEmpty.hidden = hasData;
  dashStatsGrid.hidden = !hasData;
  trendsSection.hidden = !hasData;
  updateProGatingForDashboard(hasData);

  if (!hasData) { dashInsight.hidden = true; return; }

  dAvg.textContent     = fmtStat(stats.avgSpeed);
  dAvgSub.textContent  = stats.rankableAttempts > 0 ? `${stats.rankableAttempts} rankable read${stats.rankableAttempts !== 1 ? "s" : ""}` : "rankable only";
  dBest.textContent    = fmtStat(stats.bestHighSpeed);
  dLast10.textContent  = fmtStat(stats.last10Avg);
  dConsistency.textContent  = stats.consistency || "—";
  dConsistencySub.textContent = stats.consistencyStdDev != null
    ? `σ ${convertSpeed(stats.consistencyStdDev).toFixed(2)} ${settings.units}` : "";
  dTotal.textContent   = String(stats.totalAttempts);
  dTotalSub.textContent = `${stats.totalSessions} session${stats.totalSessions !== 1 ? "s" : ""}`;
  dHighPct.textContent = stats.highAttempts > 0 ? stats.highPct + "%" : "—";
  dHighSub.textContent = stats.highAttempts > 0 ? `${stats.highAttempts} HIGH read${stats.highAttempts !== 1 ? "s" : ""}` : "no HIGH readings yet";

  if (stats.insightText) {
    dashInsightText.textContent = stats.insightText;
    dashInsight.hidden = false;
  } else {
    dashInsight.hidden = true;
  }
}

// ─── Coaching Layer ───────────────────────────────────────────────────────────

function computeCoaching(stats, historyData) {
  const benchmark   = stats.bestHighSpeed;
  const hasBenchmark = benchmark != null && (stats.highAttempts || 0) >= COACH_CONFIG.MIN_HIGH_READS;

  const zoneMin = hasBenchmark ? benchmark * COACH_CONFIG.ZONE_LOW_PCT  : null;
  const zoneMax = hasBenchmark ? benchmark * COACH_CONFIG.ZONE_HIGH_PCT : null;

  // Latest attempt with a valid speed reading (history is newest-first)
  let latestBreak = null;
  outer: for (const session of (historyData || [])) {
    for (const a of (session.attempts || [])) {
      if (a.estimatedSpeed != null) { latestBreak = a; break outer; }
    }
  }

  // Evaluate latest break vs benchmark zone
  let evalStatus = null;
  let evalMsg    = null;
  if (hasBenchmark && latestBreak?.estimatedSpeed != null) {
    const s      = latestBreak.estimatedSpeed;
    const pctOff = (1 - s / benchmark) * 100;
    if (s < zoneMin) {
      evalStatus = "below";
      evalMsg    = pctOff <= 8 ? "Getting close — keep pushing" : "A little under your pace";
    } else if (s <= zoneMax) {
      evalStatus = "in_zone";
      evalMsg    = "Right in your training zone";
    } else {
      evalStatus = "above";
      evalMsg    = "Great pop — now make it repeatable";
    }
  } else if (!hasBenchmark && latestBreak?.estimatedSpeed != null) {
    evalMsg = "Record more HIGH-confidence breaks to unlock your benchmark.";
  }

  // Collect RECENT_WINDOW most recent valid attempts for consistency dots
  const recent = [];
  for (const session of (historyData || [])) {
    for (const a of (session.attempts || [])) {
      if (a.estimatedSpeed != null) {
        recent.push(a);
        if (recent.length >= COACH_CONFIG.RECENT_WINDOW) break;
      }
    }
    if (recent.length >= COACH_CONFIG.RECENT_WINDOW) break;
  }

  const inZone = hasBenchmark
    ? recent.filter(a => a.estimatedSpeed >= zoneMin && a.estimatedSpeed <= zoneMax).length
    : 0;

  return { benchmark, hasBenchmark, zoneMin, zoneMax, latestBreak, evalStatus, evalMsg, recent, inZone };
}

function buildZoneGaugeSvg(coaching) {
  const { benchmark, zoneMin, zoneMax, latestBreak, evalStatus } = coaching;
  if (!benchmark) return "";

  const W = 260, H = 58, TY = 20, TH = 12, PAD = 12;
  const dMin = benchmark * 0.62;
  const dMax = benchmark * 1.22;
  const span = dMax - dMin;

  const px  = s  => PAD + Math.max(0, Math.min(1, (s - dMin) / span)) * (W - PAD * 2);
  const fv  = s  => convertSpeed(s).toFixed(0);

  const zx1 = px(zoneMin), zx2 = px(zoneMax), bx = px(benchmark);
  const latSpd = latestBreak?.estimatedSpeed;
  const lx     = latSpd != null ? px(latSpd) : null;

  const dotColor =
    evalStatus === "in_zone" ? "#6bcb77" :
    evalStatus === "above"   ? "#ffd93d" : "#ff8c20";

  let s = `<svg class="coach-gauge-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // Track background
  s += `<rect x="${PAD}" y="${TY}" width="${W - PAD * 2}" height="${TH}" rx="6" fill="rgba(255,255,255,0.07)"/>`;

  // Zone band
  s += `<rect x="${zx1.toFixed(1)}" y="${TY}" width="${(zx2 - zx1).toFixed(1)}" height="${TH}" rx="3" ` +
       `fill="rgba(0,212,255,0.20)" stroke="rgba(0,212,255,0.45)" stroke-width="1"/>`;

  // Benchmark tick + label above
  s += `<line x1="${bx.toFixed(1)}" y1="${TY - 5}" x2="${bx.toFixed(1)}" y2="${TY + TH + 5}" ` +
       `stroke="#00d4ff" stroke-width="2" stroke-linecap="round"/>`;
  s += `<text x="${bx.toFixed(1)}" y="${TY - 9}" fill="#00d4ff" font-size="8.5" ` +
       `text-anchor="middle" font-family="monospace" font-weight="700">${fv(benchmark)}</text>`;

  // Latest break dot + label below (only if not too close to benchmark label)
  if (lx != null) {
    s += `<circle cx="${lx.toFixed(1)}" cy="${(TY + TH / 2).toFixed(1)}" r="6.5" ` +
         `fill="${dotColor}" stroke="#0f1420" stroke-width="2"/>`;
    if (Math.abs(lx - bx) > 14) {
      s += `<text x="${lx.toFixed(1)}" y="${TY + TH + 16}" fill="${dotColor}" font-size="8" ` +
           `text-anchor="middle" font-family="monospace">${fv(latSpd)}</text>`;
    }
  }

  // Range boundary labels
  s += `<text x="${PAD}" y="${H}" fill="rgba(255,255,255,0.22)" font-size="8" ` +
       `text-anchor="start" font-family="monospace">${fv(dMin)}</text>`;
  s += `<text x="${W - PAD}" y="${H}" fill="rgba(255,255,255,0.22)" font-size="8" ` +
       `text-anchor="end" font-family="monospace">${fv(dMax)}</text>`;

  s += `</svg>`;
  return s;
}

function renderCoachingSection(stats, historyData, outcomeCoaching) {
  const hasData = stats.totalAttempts > 0;
  if (!hasData) {
    coachingSection.hidden = true;
    proCoachPreview.hidden = true;
    dashSectionHdr.hidden  = true;
    return;
  }

  const isPro = BILLING.isProUser();
  proCoachPreview.hidden = isPro;
  coachingSection.hidden = !isPro;
  dashSectionHdr.hidden  = false;

  const c = computeCoaching(stats, historyData);
  const u = settings.units;

  // ── Benchmark card ──────────────────────────────────────────────────────────
  if (c.hasBenchmark) {
    coachBenchSpeed.textContent = convertSpeed(c.benchmark).toFixed(1);
    coachBenchUnit.textContent  = u;
    coachBenchCard.classList.add("coach-bench-card--set");
    coachBenchCard.classList.remove("coach-bench-card--empty");
  } else {
    coachBenchSpeed.textContent = "—";
    coachBenchUnit.textContent  = "";
    coachBenchCard.classList.add("coach-bench-card--empty");
    coachBenchCard.classList.remove("coach-bench-card--set");
  }

  // ── Latest break card ────────────────────────────────────────────────────────
  const lb = c.latestBreak;
  if (lb) {
    coachLatestSpeed.textContent = convertSpeed(lb.estimatedSpeed).toFixed(1);
    coachLatestUnit.textContent  = u;
    const tierKey = (lb.confidenceTier || "").replace("_", "-");
    coachLatestBadge.innerHTML = lb.confidenceTier
      ? `<span class="badge badge-${tierKey}">${confLabel(lb.confidenceTier)}</span>` : "";
    if (c.hasBenchmark && c.evalStatus) {
      const statusLabels = { below: "Below Benchmark", in_zone: "In the Zone", above: "Above Benchmark" };
      coachLatestStatus.textContent  = statusLabels[c.evalStatus] || "";
      coachLatestStatus.dataset.eval = c.evalStatus;
    } else {
      coachLatestStatus.textContent  = "";
      coachLatestStatus.dataset.eval = "";
    }
    coachLatestMsg.textContent = c.evalMsg || "";
  } else {
    coachLatestSpeed.textContent   = "—";
    coachLatestUnit.textContent    = "";
    coachLatestBadge.innerHTML     = "";
    coachLatestStatus.textContent  = "";
    coachLatestStatus.dataset.eval = "";
    coachLatestMsg.textContent     = "No breaks recorded yet.";
  }

  // ── Consistency dots ─────────────────────────────────────────────────────────
  const { recent, inZone } = c;
  coachConsistWindow.textContent = String(COACH_CONFIG.RECENT_WINDOW);
  if (recent.length === 0) {
    coachConsistFraction.textContent = "—";
    coachConsistDots.innerHTML = "";
  } else {
    coachConsistFraction.textContent = c.hasBenchmark ? `${inZone} / ${recent.length}` : `${recent.length}`;
    coachConsistDots.innerHTML = recent.map(a => {
      const inZ = c.hasBenchmark && a.estimatedSpeed >= c.zoneMin && a.estimatedSpeed <= c.zoneMax;
      return `<span class="coach-dot ${inZ ? "coach-dot--in" : "coach-dot--out"}" ` +
             `title="${convertSpeed(a.estimatedSpeed).toFixed(1)} ${u}"></span>`;
    }).join("");
  }

  // ── Zone gauge ───────────────────────────────────────────────────────────────
  if (c.hasBenchmark) {
    coachGaugeWrap.innerHTML = buildZoneGaugeSvg(c);
    cglLatest.hidden = c.latestBreak == null;
  } else {
    coachGaugeWrap.innerHTML =
      `<div class="coach-gauge-empty">Record more HIGH-confidence breaks to unlock your benchmark and zone gauge.</div>`;
    cglLatest.hidden = true;
  }

  // ── Outcome coaching card ─────────────────────────────────────────────────────
  const coachOutcomeCard     = document.getElementById("coachOutcomeCard");
  const coachOutcomeZoneEl   = document.getElementById("coachOutcomeZone");
  const coachOutcomeInsights = document.getElementById("coachOutcomeInsights");
  const coachOutcomeFooter   = document.getElementById("coachOutcomeFooter");
  if (!coachOutcomeCard) return;

  coachOutcomeCard.hidden = false;

  if (!outcomeCoaching || outcomeCoaching.taggedCount === 0) {
    // Teaser: inform the user about the feature without cluttering
    coachOutcomeZoneEl.innerHTML =
      `<div class="coach-outcome-teaser">Tag your breaks after each session — the app will learn your ideal speed range based on real outcomes.</div>`;
    coachOutcomeInsights.innerHTML = "";
    coachOutcomeFooter.textContent = "";
  } else if (outcomeCoaching.idealZone) {
    // Full ideal zone display
    const low  = convertSpeed(outcomeCoaching.idealZone.lowMph).toFixed(1);
    const high = convertSpeed(outcomeCoaching.idealZone.highMph).toFixed(1);
    coachOutcomeZoneEl.innerHTML =
      `<div class="coach-outcome-range-wrap">
         <span class="coach-outcome-range">${low}–${high}</span>
         <span class="coach-outcome-range-unit">${settings.units}</span>
       </div>
       <div class="coach-outcome-sub">sweet spot based on your outcomes</div>`;
    coachOutcomeInsights.innerHTML = outcomeCoaching.insights.length
      ? outcomeCoaching.insights.map(i => `<div class="coach-outcome-insight">• ${i}</div>`).join("")
      : "";
    coachOutcomeFooter.textContent =
      `${outcomeCoaching.taggedCount} tagged break${outcomeCoaching.taggedCount !== 1 ? "s" : ""} of ${outcomeCoaching.totalCount} recorded`;
  } else {
    // Not enough data in any bucket yet — show progress
    const need = Math.max(0, 2 - outcomeCoaching.taggedCount);
    coachOutcomeZoneEl.innerHTML =
      `<div class="coach-outcome-building">Tag ${need} more break${need !== 1 ? "s" : ""} in the same speed range to unlock your Ideal Zone.</div>`;
    coachOutcomeInsights.innerHTML = outcomeCoaching.insights.length
      ? outcomeCoaching.insights.map(i => `<div class="coach-outcome-insight">• ${i}</div>`).join("")
      : "";
    coachOutcomeFooter.textContent =
      `${outcomeCoaching.taggedCount} tagged break${outcomeCoaching.taggedCount !== 1 ? "s" : ""} so far`;
  }
}

// ─── Outcome Tag Sheet ────────────────────────────────────────────────────────

function renderTagRows(rackConfig) {
  if (!tagRowsEl) return;
  const is9ball = rackConfig === "9ball" || rackConfig === "9ball-9spot";
  const is10ball = rackConfig === "10ball";
  const moneyLabel = is9ball ? "9 on the Break" : is10ball ? "10 on the Break" : "8 on the Break";

  const rowDefs = [
    { key: "scratched",          label: "Scratch",       note: "cue ball in pocket", danger: true  },
    { key: "objectBallPocketed", label: "Ball Pocketed", note: "≥1 object ball in",  danger: false },
    { key: "moneyBallOnBreak",   label: moneyLabel,      note: "money ball on break",danger: false },
  ];

  tagRowsEl.innerHTML = rowDefs.map(({ key, label, note, danger }) => {
    const isYes = tagToggles[key];
    return `<div class="tag-row">
      <div class="tag-row-text">
        <span class="tag-row-label${danger ? " tag-row-label--danger" : ""}">${label}</span>
        <span class="tag-row-note">${note}</span>
      </div>
      <div class="tag-toggle-group" data-key="${key}">
        <button class="tag-tog tag-tog--no${!isYes ? " tag-tog--sel-no" : ""}" data-val="false">No</button>
        <button class="tag-tog tag-tog--yes${isYes ? " tag-tog--sel-yes" : ""}" data-val="true">Yes</button>
      </div>
    </div>`;
  }).join("");

  tagRowsEl.querySelectorAll(".tag-toggle-group").forEach(group => {
    const key = group.dataset.key;
    group.querySelectorAll(".tag-tog").forEach(btn => {
      btn.addEventListener("click", () => {
        tagToggles[key] = (btn.dataset.val === "true");
        renderTagRows(rackConfig);
      });
    });
  });
}

function showTagSheet(sessionId, profileId, rackConfig, bestSpeed, bestConf) {
  tagSessionId  = sessionId;
  tagProfileId  = profileId;
  tagRackConfig = rackConfig;
  tagBestSpeed  = bestSpeed;
  tagBestConf   = bestConf;
  // Reset all toggles to "No"
  tagToggles = { scratched: false, objectBallPocketed: false, moneyBallOnBreak: false };

  if (tagSubtitle) {
    if (bestSpeed != null) {
      const v       = convertSpeed(bestSpeed);
      const precise = bestConf === "high" || bestConf === "near_high" || bestConf === "medium";
      tagSubtitle.textContent = `${precise ? v.toFixed(1) : "~" + Math.round(v)} ${settings.units} — how did this break go?`;
    } else {
      tagSubtitle.textContent = "How did this break go?";
    }
  }

  renderTagRows(rackConfig);
  if (tagOverlay) tagOverlay.hidden = false;
}

function hideTagSheet() {
  if (tagOverlay) tagOverlay.hidden = true;
  clearTimeout(tagSheetTimer);
  tagSessionId = null;
}

async function saveOutcomeTags() {
  if (!tagSessionId || !tagProfileId) return;
  try {
    if (tagSaveBtn) { tagSaveBtn.disabled = true; tagSaveBtn.textContent = "Saving…"; }
    await apiPatch("/sessions/" + tagSessionId + "/outcome", {
      profileId:          tagProfileId,
      scratched:          tagToggles.scratched,
      objectBallPocketed: tagToggles.objectBallPocketed,
      moneyBallOnBreak:   tagToggles.moneyBallOnBreak,
      gameMode:           tagRackConfig,
    });
    showToast("Break tagged ✓");
    hideTagSheet();
  } catch (err) {
    console.error("Tag save failed:", err);
    showToast("Couldn't save — try again");
  } finally {
    if (tagSaveBtn) { tagSaveBtn.disabled = false; tagSaveBtn.textContent = "Save Tags"; }
  }
}

tagSkipBtn?.addEventListener("click", hideTagSheet);
tagCloseBtn?.addEventListener("click", hideTagSheet);
tagSaveBtn?.addEventListener("click", saveOutcomeTags);
tagOverlay?.addEventListener("click", e => { if (e.target === tagOverlay) hideTagSheet(); });

// ─── History ──────────────────────────────────────────────────────────────────
async function loadHistory() {
  if (!activeProfile) {
    histList.innerHTML = "";
    histEmpty.hidden = false;
    return;
  }
  try {
    historyData = await apiGet("/profiles/" + activeProfile.id + "/history");
    renderHistory();
  } catch {
    histList.innerHTML = "";
    histEmpty.hidden = false;
  }
}

histFilters.querySelectorAll(".hist-filter").forEach(btn => {
  btn.addEventListener("click", () => {
    histFilter = btn.dataset.filter;
    histFilters.querySelectorAll(".hist-filter").forEach(b => b.classList.toggle("active", b === btn));
    renderHistory();
  });
});

histClearBtn.addEventListener("click", async () => {
  if (!activeProfile) return;
  const yes = await showConfirm(
    `Clear all history for ${activeProfile.displayName}?`,
    "This will permanently delete all saved break sessions for this player.",
    "Clear History"
  );
  if (!yes) return;
  try {
    await apiDelete("/profiles/" + activeProfile.id + "/history");
    historyData = [];
    renderHistory();
    showToast("History cleared");
  } catch (err) {
    showToast("Error: " + err.message);
  }
});

function confLabel(tier) {
  const map = { high: "HIGH", near_high: "NEAR-HIGH", medium: "MEDIUM", low: "LOW", very_low: "LOW", error: "ERROR" };
  return map[tier] || tier;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function renderHistory() {
  histList.innerHTML = "";
  histList.appendChild(histEmpty);

  let sessions = historyData;
  if (histFilter !== "all") {
    sessions = sessions.filter(s =>
      s.attempts?.some(a => {
        if (histFilter === "low") return a.confidenceTier === "low" || a.confidenceTier === "very_low";
        return a.confidenceTier === histFilter;
      })
    );
  }

  // Cap history for free users
  const isPro = BILLING.isProUser();
  const hiddenCount = !isPro && sessions.length > FREE_HISTORY_LIMIT
    ? sessions.length - FREE_HISTORY_LIMIT : 0;
  if (hiddenCount > 0) sessions = sessions.slice(0, FREE_HISTORY_LIMIT);

  histEmpty.hidden = sessions.length > 0;
  if (sessions.length === 0) return;

  sessions.forEach(sess => {
    const card = document.createElement("div");
    card.className = "hist-card";

    // Session header
    const hdr = document.createElement("div");
    hdr.className = "hist-card-header";

    const bestAttempt = (sess.attempts || []).find(a => a.estimatedSpeed != null && ["high","near_high","medium"].includes(a.confidenceTier))
      || (sess.attempts || [])[0];
    const speedTxt = sess.bestSpeed != null ? fmtStat(sess.bestSpeed) : "—";
    const confTier = sess.bestConf || bestAttempt?.confidenceTier || "low";

    hdr.innerHTML =
      `<div class="hist-hdr-left">` +
        `<div class="hist-speed">${speedTxt}</div>` +
        `<div class="hist-conf">${badge(confTier)}</div>` +
      `</div>` +
      `<div class="hist-hdr-right">` +
        `<div class="hist-date">${fmtDate(sess.createdAt)}</div>` +
        `<div class="hist-meta">${[
          `${sess.attemptCount} attempt${sess.attemptCount !== 1 ? "s" : ""}`,
          sess.rackConfig ? (RACK_LABELS[sess.rackConfig] || sess.rackConfig) : null,
          sess.sourceType,
        ].filter(Boolean).join(" · ")}</div>` +
      `</div>` +
      `<button class="hist-del-btn" title="Delete session">✕</button>`;

    hdr.querySelector(".hist-del-btn").addEventListener("click", async e => {
      e.stopPropagation();
      const yes = await showConfirm("Delete this session?", `Session from ${fmtDate(sess.createdAt)} with ${sess.attemptCount} attempt${sess.attemptCount !== 1 ? "s" : ""}.`);
      if (!yes) return;
      try {
        await apiDelete("/sessions/" + sess.id);
        historyData = historyData.filter(s => s.id !== sess.id);
        renderHistory();
        showToast("Session deleted");
      } catch (err) {
        showToast("Error: " + err.message);
      }
    });

    // Attempts detail (expandable)
    const body = document.createElement("div");
    body.className = "hist-card-body";

    (sess.attempts || []).forEach(a => {
      const row = document.createElement("div");
      row.className = "hist-attempt-row";
      const speedStr = a.estimatedSpeed != null ? fmtStat(a.estimatedSpeed) : "—";
      const confStr  = confLabel(a.confidenceTier);
      const errHtml  = a.errorMessage ? `<span class="hist-err">${a.errorMessage}</span>` : "";
      const metricsHtml = !a.errorMessage && a.pairScore != null
        ? `<span class="hist-metrics">ps:${a.pairScore.toFixed(2)} eq:${(a.eventQuality||0).toFixed(2)}</span>` : "";
      row.innerHTML =
        `<span class="hist-att-name">${a.filename || "attempt"}</span>` +
        `<span class="hist-att-speed">${speedStr}</span>` +
        `<span class="hist-att-conf">${badge(a.confidenceTier)}</span>` +
        errHtml + metricsHtml;
      body.appendChild(row);
    });

    hdr.addEventListener("click", e => {
      if (e.target.classList.contains("hist-del-btn")) return;
      card.classList.toggle("open");
    });

    card.append(hdr, body);
    histList.appendChild(card);
  });

  // Free user teaser — show after the last visible session
  if (hiddenCount > 0) {
    const teaser = document.createElement("div");
    teaser.className = "hist-pro-teaser";
    teaser.innerHTML =
      `<span class="hist-pro-lock">🔒</span>` +
      `<span class="hist-pro-msg">${hiddenCount} older session${hiddenCount !== 1 ? "s" : ""} hidden</span>` +
      `<button class="hist-pro-unlock" data-feature="history">Unlock Pro for full history</button>`;
    histList.appendChild(teaser);
  }
}

// ─── Break Setup ──────────────────────────────────────────────────────────────

const DEFAULT_BREAK_SETUP = {
  tableMode:      "standard",  // "standard" | "custom"
  tableSize:      "9ft",       // "7ft" | "8ft" | "9ft"
  customLengthIn: 100,
  customWidthIn:  50,
  rackConfig:     "8ball",     // "8ball" | "9ball" | "10ball" | "custom"
  breakPosition:  "center",    // "center" | "slight-left" | "left" | "slight-right" | "right"
};

let setupState = { ...DEFAULT_BREAK_SETUP };

// Table playing-surface dimensions in inches [length, width]
const TABLE_DIMS_IN = { "7ft": [77, 38.5], "8ft": [88, 44], "9ft": [100, 50] };

// X-coords of the 5 position markers in the vertical SVG (viewBox 240×296, head string at y=86)
const SVG_POS_X = { "left": 38, "slight-left": 76, "center": 120, "slight-right": 164, "right": 202 };

const RACK_LABELS = { "8ball": "8-ball", "9ball": "9-ball", "9ball-9spot": "9 on spot", "10ball": "10-ball", "custom": "Other" };
const POS_LABELS  = { "center": "Center", "slight-left": "Sl. Left", "left": "Left", "slight-right": "Sl. Right", "right": "Right" };

function updateSetupSummary() {
  const sizeLabel = setupState.tableMode === "custom"
    ? `${setupState.customLengthIn}"×${setupState.customWidthIn}"`
    : setupState.tableSize.replace("ft", " ft");
  const rackLabel = RACK_LABELS[setupState.rackConfig] || setupState.rackConfig;
  const posLabel  = POS_LABELS[setupState.breakPosition] || setupState.breakPosition;
  const el = document.getElementById("setupSummary");
  if (el) el.textContent = `${sizeLabel} · ${rackLabel} · ${posLabel}`;
}

function applySetupToUI() {
  // Table size buttons
  document.querySelectorAll("#setupTableSize .setup-btn").forEach(btn => {
    const isCustom = setupState.tableMode === "custom";
    btn.classList.toggle("active",
      isCustom ? btn.dataset.val === "custom" : btn.dataset.val === setupState.tableSize
    );
  });
  // Custom dims panel
  const customWrap = document.getElementById("setupCustomWrap");
  if (customWrap) customWrap.hidden = setupState.tableMode !== "custom";

  // Rack buttons
  document.querySelectorAll("#setupRackConfig .setup-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.val === setupState.rackConfig);
  });

  // Break position text buttons
  document.querySelectorAll("#setupPosRow .pos-btn").forEach(btn => {
    btn.classList.toggle("pos-btn-active", btn.dataset.pos === setupState.breakPosition);
  });

  // SVG position markers and path (vertical table: positions differ by cx, not cy)
  const px = SVG_POS_X[setupState.breakPosition] ?? 120;
  document.querySelectorAll(".svgPos").forEach(circle => {
    const p = circle.dataset.pos;
    const active = p === setupState.breakPosition;
    if (active) {
      circle.setAttribute("fill", "var(--accent)");
      circle.setAttribute("stroke", "none");
      circle.setAttribute("r", "11");
      circle.setAttribute("opacity", "0.85");
    } else {
      circle.setAttribute("fill", "rgba(255,255,255,.06)");
      circle.setAttribute("stroke", "rgba(255,255,255,.3)");
      circle.setAttribute("stroke-width", "1.5");
      circle.setAttribute("r", "10");
      circle.setAttribute("opacity", "1");
    }
  });
  const pathEl  = document.getElementById("svgBallPath");
  if (pathEl) { pathEl.setAttribute("x1", String(px)); pathEl.setAttribute("x2", "120"); }
  // Arrow stays fixed pointing up at foot spot (cy=86, rack end at top)

  updateSetupSummary();
}

let saveSetupTimer = null;
async function saveSetupToProfile() {
  if (!activeProfile) return;
  clearTimeout(saveSetupTimer);
  saveSetupTimer = setTimeout(async () => {
    try {
      const resp = await fetch(`/api/profiles/${activeProfile.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ breakSetup: setupState }),
      });
      if (resp.ok) {
        const updated = await resp.json();
        const idx = profiles.findIndex(p => p.id === activeProfile.id);
        if (idx >= 0) profiles[idx] = updated;
        activeProfile = updated;
      }
    } catch { /* non-fatal */ }
  }, 600);
}

function loadSetupFromProfile() {
  if (activeProfile?.breakSetup) {
    setupState = { ...DEFAULT_BREAK_SETUP, ...activeProfile.breakSetup };
  } else {
    setupState = { ...DEFAULT_BREAK_SETUP };
  }
  applySetupToUI();
  syncWheelPickerValues();
}

// ─── Wheel Picker ─────────────────────────────────────────────────────────────

function initWheelPicker(trackId, { min, max, step, initValue, onChange }) {
  const track = document.getElementById(trackId);
  if (!track) return;

  const items = [];
  for (let v = min; v <= max; v += step) items.push(v);

  // Ghost spacers so selected item can be centered
  const topGhost = document.createElement("div");
  topGhost.className = "wheel-ghost";
  const botGhost = document.createElement("div");
  botGhost.className = "wheel-ghost";
  track.innerHTML = "";
  track.appendChild(topGhost);

  items.forEach(v => {
    const el = document.createElement("div");
    el.className = "wheel-item";
    el.textContent = String(v);
    el.dataset.val = String(v);
    track.appendChild(el);
  });
  track.appendChild(botGhost);

  // Scroll to initial value immediately (before layout)
  const scrollToIdx = (idx) => {
    const clamped = Math.max(0, Math.min(idx, items.length - 1));
    track.scrollTop = clamped * 44;
    track.querySelectorAll(".wheel-item").forEach((el, i) => {
      el.classList.toggle("selected", i === clamped);
    });
  };

  const initIdx = items.indexOf(initValue);
  scrollToIdx(initIdx >= 0 ? initIdx : 0);

  // Re-scroll after layout paint (needed on some browsers)
  requestAnimationFrame(() => scrollToIdx(initIdx >= 0 ? initIdx : 0));

  // Detect scroll-snap settled value
  let scrollTimer = null;
  track.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const idx = Math.round(track.scrollTop / 44);
      const clamped = Math.max(0, Math.min(idx, items.length - 1));
      track.querySelectorAll(".wheel-item").forEach((el, i) => {
        el.classList.toggle("selected", i === clamped);
      });
      onChange(items[clamped]);
    }, 80);
  }, { passive: true });
}

function syncWheelPickerValues() {
  // Re-scroll wheels to match current setupState (called on profile switch)
  const lenTrack = document.getElementById("wheelLengthTrack");
  const widTrack = document.getElementById("wheelWidthTrack");
  if (lenTrack) {
    const items = [...lenTrack.querySelectorAll(".wheel-item")].map(el => +el.dataset.val);
    const idx = items.indexOf(setupState.customLengthIn);
    if (idx >= 0) lenTrack.scrollTop = idx * 44;
  }
  if (widTrack) {
    const items = [...widTrack.querySelectorAll(".wheel-item")].map(el => +el.dataset.val);
    const idx = items.indexOf(setupState.customWidthIn);
    if (idx >= 0) widTrack.scrollTop = idx * 44;
  }
}

function initBreakSetup() {
  // Wheel pickers
  initWheelPicker("wheelLengthTrack", {
    min: 70, max: 120, step: 1, initValue: setupState.customLengthIn,
    onChange(v) { setupState.customLengthIn = v; updateSetupSummary(); saveSetupToProfile(); },
  });
  initWheelPicker("wheelWidthTrack", {
    min: 35, max: 60, step: 1, initValue: setupState.customWidthIn,
    onChange(v) { setupState.customWidthIn = v; updateSetupSummary(); saveSetupToProfile(); },
  });

  // Table size buttons
  document.querySelectorAll("#setupTableSize .setup-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.val;
      if (val === "custom") {
        setupState.tableMode = "custom";
      } else {
        setupState.tableMode = "standard";
        setupState.tableSize = val;
      }
      // Sync to Settings drawer
      settings.tableSize = val;
      saveSettings(settings);
      const settingsContainer = document.getElementById("tableSizeOpts");
      if (settingsContainer) {
        settingsContainer.querySelectorAll(".opt-btn").forEach(b => {
          b.classList.toggle("active", b.dataset.value === val);
        });
      }
      updateSettingsCustomTableUI();
      applySetupToUI();
      saveSetupToProfile();
    });
  });

  // Rack config buttons — 9-on-spot and 10-ball are Pro only
  document.querySelectorAll("#setupRackConfig .setup-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.val;
      if ((val === "9ball-9spot" || val === "10ball") && !BILLING.isProUser()) {
        openUpgradeModal();
        return;
      }
      setupState.rackConfig = val;
      applySetupToUI();
      saveSetupToProfile();
    });
  });

  // Break position — SVG hit targets
  document.querySelectorAll("#svgPositions [data-pos]").forEach(el => {
    el.addEventListener("click", () => {
      setupState.breakPosition = el.dataset.pos;
      applySetupToUI();
      saveSetupToProfile();
    });
  });

  // Break position — text buttons
  document.querySelectorAll("#setupPosRow .pos-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      setupState.breakPosition = btn.dataset.pos;
      applySetupToUI();
      saveSetupToProfile();
    });
  });

  applySetupToUI();
}

// ─── How It Works Onboarding ──────────────────────────────────────────────────

const HIW_STORAGE_KEY = "bsa_hiw_done";
const HIW_TOTAL_STEPS = 6;

const hiwOverlay     = document.getElementById("hiwOverlay");
const hiwDotEls      = document.querySelectorAll("#hiwDots .hiw-dot");
const hiwNextBtn     = document.getElementById("hiwNext");
const hiwBackBtn     = document.getElementById("hiwBack");
const hiwSkipBtn     = document.getElementById("hiwSkip");
const hiwCloseBtn    = document.getElementById("hiwClose");
const heroHiwBtn     = document.getElementById("heroHiwBtn");
const settingsHiwBtn = document.getElementById("settingsHiwBtn");

let hiwCurrentStep = 0;

function showHiw(startStep = 0) {
  hiwCurrentStep = startStep;
  _updateHiw();
  hiwOverlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeHiw(markDone = true) {
  hiwOverlay.hidden = true;
  document.body.style.overflow = "";
  if (markDone) {
    try { localStorage.setItem(HIW_STORAGE_KEY, "1"); } catch {}
  }
}

function _updateHiw() {
  for (let i = 0; i < HIW_TOTAL_STEPS; i++) {
    const el = document.getElementById("hiwStep" + i);
    if (el) el.hidden = (i !== hiwCurrentStep);
  }
  hiwDotEls.forEach((dot, i) => {
    dot.classList.toggle("active", i === hiwCurrentStep);
    dot.classList.toggle("done",   i < hiwCurrentStep);
  });
  hiwBackBtn.hidden = (hiwCurrentStep === 0);
  const isLast = hiwCurrentStep === HIW_TOTAL_STEPS - 1;
  hiwSkipBtn.hidden = isLast;
  hiwNextBtn.textContent = isLast ? "Got it ✓" : "Next";
}

hiwNextBtn.addEventListener("click", () => {
  if (hiwCurrentStep < HIW_TOTAL_STEPS - 1) {
    hiwCurrentStep++;
    _updateHiw();
  } else {
    closeHiw(true);
  }
});

hiwBackBtn.addEventListener("click", () => {
  if (hiwCurrentStep > 0) { hiwCurrentStep--; _updateHiw(); }
});

hiwSkipBtn.addEventListener("click", () => closeHiw(true));
hiwCloseBtn.addEventListener("click", () => closeHiw(true));

hiwOverlay.addEventListener("click", e => {
  if (e.target === hiwOverlay) closeHiw(true);
});

// Entry points
heroHiwBtn.addEventListener("click", () => showHiw(0));

settingsHiwBtn.addEventListener("click", () => {
  settingsOverlay.hidden = true;
  showHiw(0);
});

function checkFirstVisit() {
  try {
    if (!localStorage.getItem(HIW_STORAGE_KEY)) showHiw(0);
  } catch {}
}

// ─── Trend Charts ─────────────────────────────────────────────────────────────

const trendsSection    = document.getElementById("trendsSection");
const trendsRangeBtns  = document.getElementById("trendsRangeBtns");
const speedModeBtns    = document.getElementById("speedModeBtns");
const consistRollingBtns = document.getElementById("consistRollingBtns");
const speedSummary     = document.getElementById("speedSummary");
const speedEmpty       = document.getElementById("speedEmpty");
const consistEmpty     = document.getElementById("consistEmpty");

let activeTrendRange   = "10";
let activeSpeedMode    = "rankable";
let activeConsistRoll  = "off";
let speedChartInst     = null;
let consistChartInst   = null;

// Chart.js global dark defaults
function applyChartDefaults() {
  if (typeof Chart === "undefined") return;
  Chart.defaults.color      = "#6a7a96";
  Chart.defaults.borderColor = "rgba(255,255,255,0.06)";
  Chart.defaults.font.family = "'Inter', 'SF Pro Text', system-ui, sans-serif";
  Chart.defaults.font.size  = 11;
  Chart.defaults.plugins.tooltip.backgroundColor = "#0f1420";
  Chart.defaults.plugins.tooltip.borderColor = "#1e2840";
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor  = "#e8eef8";
  Chart.defaults.plugins.tooltip.bodyColor   = "#6a7a96";
  Chart.defaults.plugins.tooltip.padding     = 10;
  Chart.defaults.plugins.legend.display      = false;
}

const TIER_POINT_COLOR = {
  high:        "#00d4ff",
  near_high:   "#ff8c20",
  medium:      "#7b9bb5",
  session_avg: "#00d4ff",
};

function tierPointColors(data, field = "confidenceTier") {
  return data.map(d => TIER_POINT_COLOR[d[field]] || "#00d4ff");
}

function makeGradient(ctx, color, alpha1 = 0.18, alpha2 = 0) {
  const grad = ctx.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, color.replace(")", `, ${alpha1})`).replace("rgb", "rgba"));
  grad.addColorStop(1, color.replace(")", `, ${alpha2})`).replace("rgb", "rgba"));
  return grad;
}

// Make a gradient from a hex color
function hexGradient(canvas, hex, a1 = 0.20, a2 = 0) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0,   `rgba(${r},${g},${b},${a1})`);
  grad.addColorStop(1,   `rgba(${r},${g},${b},${a2})`);
  return grad;
}

function fmtChartDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function rollingAvg(vals, window = 3) {
  return vals.map((_, i) => {
    const slice = vals.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

function trendDirection(speeds) {
  if (speeds.length < 4) return "flat";
  const half = Math.floor(speeds.length / 2);
  const first = speeds.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const last  = speeds.slice(-half).reduce((s, v) => s + v, 0) / half;
  const delta = last - first;
  if (delta > 0.8) return "up";
  if (delta < -0.8) return "down";
  return "flat";
}

function renderSpeedSummary(data) {
  if (!data.length) { speedSummary.hidden = true; return; }
  const speeds = data.map(d => d.speed);
  const avg    = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const best   = Math.max(...speeds);
  const dir    = trendDirection(speeds);
  const dirLabels = { up: "↑ Improving", flat: "→ Stable", down: "↓ Mixed" };
  const dirClasses = { up: "up", flat: "flat", down: "down" };
  speedSummary.innerHTML =
    `<div class="trend-chip"><span class="trend-chip-val">${fmtStat(avg)}</span><span class="trend-chip-lbl">Range avg</span></div>` +
    `<div class="trend-chip"><span class="trend-chip-val">${fmtStat(best)}</span><span class="trend-chip-lbl">Range best</span></div>` +
    `<div class="trend-chip"><span class="trend-chip-dir ${dirClasses[dir]}">${dirLabels[dir]}</span><span class="trend-chip-lbl">Trend</span></div>`;
  speedSummary.hidden = false;
}

function buildSpeedChart(data) {
  const canvas = document.getElementById("speedChart");
  if (!canvas) return;

  if (speedChartInst) { speedChartInst.destroy(); speedChartInst = null; }

  if (!data.length) {
    speedEmpty.hidden = false;
    canvas.parentElement.style.display = "none";
    speedSummary.hidden = true;
    return;
  }
  speedEmpty.hidden = true;
  canvas.parentElement.style.display = "";

  renderSpeedSummary(data);

  const labels      = data.map(d => fmtChartDate(d.timestamp));
  const speeds      = data.map(d => d.speed);
  const pointColors = tierPointColors(data);

  speedChartInst = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: speeds,
        borderColor: "#00d4ff",
        backgroundColor: hexGradient(canvas, "#00d4ff", 0.18, 0),
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        pointRadius: data.length > 30 ? 2 : 4,
        pointHoverRadius: 6,
        borderWidth: 2,
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: items => {
              const pt = data[items[0].dataIndex];
              return fmtChartDate(pt.timestamp);
            },
            label: items => {
              const pt = data[items[0].dataIndex];
              const spd = convertSpeed(pt.speed).toFixed(1) + " " + settings.units;
              const tier = confLabel(pt.confidenceTier);
              return `${spd}  ·  ${tier}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 6,
            maxRotation: 0,
            color: "#6a7a96",
            font: { size: 10 },
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          ticks: {
            color: "#6a7a96",
            font: { size: 10 },
            callback: v => convertSpeed(v).toFixed(0),
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

function buildConsistChart(rawData, rolling) {
  const canvas = document.getElementById("consistChart");
  if (!canvas) return;

  if (consistChartInst) { consistChartInst.destroy(); consistChartInst = null; }

  if (!rawData.length) {
    consistEmpty.hidden = false;
    canvas.parentElement.style.display = "none";
    return;
  }
  consistEmpty.hidden = true;
  canvas.parentElement.style.display = "";

  const labels = rawData.map(d => fmtChartDate(d.timestamp));
  let   values = rawData.map(d => d.consistency);
  if (rolling === "on") values = rollingAvg(values, 3);

  const color = "#6bcb77";
  consistChartInst = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: color,
        backgroundColor: hexGradient(canvas, color, 0.15, 0),
        pointBackgroundColor: color,
        pointBorderColor: color,
        pointRadius: rawData.length > 30 ? 2 : 4,
        pointHoverRadius: 6,
        borderWidth: 2,
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: items => {
              const pt = rawData[items[0].dataIndex];
              return fmtChartDate(pt.timestamp);
            },
            label: items => {
              const v = values[items[0].dataIndex];
              const pt = rawData[items[0].dataIndex];
              const unit = settings.units;
              return `σ ${convertSpeed(v).toFixed(2)} ${unit}  ·  ${pt.attemptCount} attempts`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 6, maxRotation: 0, color: "#6a7a96", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          reverse: false,
          ticks: {
            color: "#6a7a96",
            font: { size: 10 },
            callback: v => convertSpeed(v).toFixed(1),
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

async function loadTrends() {
  if (!activeProfile) {
    trendsSection.hidden = true;
    return;
  }
  if (typeof Chart === "undefined") return;
  applyChartDefaults();
  trendsSection.hidden = false;

  try {
    const [speedData, consistData] = await Promise.all([
      apiGet(`/profiles/${activeProfile.id}/trends/speed?range=${activeTrendRange}&mode=${activeSpeedMode}`),
      apiGet(`/profiles/${activeProfile.id}/trends/consistency?range=${activeTrendRange}`),
    ]);
    buildSpeedChart(speedData);
    buildConsistChart(consistData, activeConsistRoll);
  } catch (err) {
    console.warn("loadTrends error", err);
  }
}

// ── Trend control wiring ───────────────────────────────────────────────────────
function setActiveBtn(group, attr, value) {
  group.querySelectorAll(".tr-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset[attr] === value);
  });
}

trendsRangeBtns.addEventListener("click", e => {
  const btn = e.target.closest(".tr-btn");
  if (!btn) return;
  activeTrendRange = btn.dataset.range;
  setActiveBtn(trendsRangeBtns, "range", activeTrendRange);
  loadTrends();
});

speedModeBtns.addEventListener("click", e => {
  const btn = e.target.closest(".tr-btn");
  if (!btn) return;
  activeSpeedMode = btn.dataset.mode;
  setActiveBtn(speedModeBtns, "mode", activeSpeedMode);
  loadTrends();
});

consistRollingBtns.addEventListener("click", e => {
  const btn = e.target.closest(".tr-btn");
  if (!btn) return;
  activeConsistRoll = btn.dataset.rolling;
  setActiveBtn(consistRollingBtns, "rolling", activeConsistRoll);
  loadTrends();
});

// ─── Challenge Mode ──────────────────────────────────────────────────────────

// State — always stored in mph internally; converted for display
const challengeState = {
  type:              null,   // "power" | "consistency"
  active:            false,
  targetSpeedMph:    0,
  toleranceMph:      0,
  requiredSuccesses: 3,
  totalAttempts:     10,
  successCount:      0,
  attemptCount:      0,
  result:            null,   // null | "complete" | "done"
};

// DOM refs
const chalSetupEl       = document.getElementById("challengeSetup");
const chalProgressEl    = document.getElementById("challengeProgress");
const chalCompleteEl    = document.getElementById("challengeComplete");
const chalTargetPow     = document.getElementById("chalTargetSpeedPow");
const chalReqSuccesses  = document.getElementById("chalRequiredSuccesses");
const chalTargetCon     = document.getElementById("chalTargetSpeedCon");
const chalToleranceEl   = document.getElementById("chalTolerance");
const chalTotalAtt      = document.getElementById("chalTotalAttempts");
const chalStartBtn      = document.getElementById("challengeStartBtn");
const chalCancelBtn     = document.getElementById("challengeCancelBtn");
const chalNewBtn        = document.getElementById("challengeNewBtn");
const chalProgressType  = document.getElementById("chalProgressType");
const chalProgressTgt   = document.getElementById("chalProgressTarget");
const chalProgressBar   = document.getElementById("chalProgressBar");
const chalProgressStat  = document.getElementById("chalProgressStat");
const chalProgressSub   = document.getElementById("chalProgressSub");
const chalCompleteIcon  = document.getElementById("chalCompleteIcon");
const chalCompleteTit   = document.getElementById("chalCompleteTitle");
const chalCompleteSumm  = document.getElementById("chalCompleteSummary");
const chalStripEl       = document.getElementById("challengeStrip");
const chalStripBadge    = document.getElementById("chalStripBadge");
const chalStripProgress = document.getElementById("chalStripProgress");
const chalStripView     = document.getElementById("chalStripView");
const chalStripCancel   = document.getElementById("chalStripCancel");

// Tolerance stepper
const chalTolDecBtn  = document.getElementById("chalTolDec");
const chalTolIncBtn  = document.getElementById("chalTolInc");
const chalTolDisplay = document.getElementById("chalToleranceDisplay");
const chalTotalAttDisplay = document.getElementById("chalTotalAttemptsDisplay");

(function initChallengeControls() {
  // Stepper: ± 0.5 increments, clamped 0.5–10
  function setTolerance(v) {
    v = Math.round(v * 10) / 10;
    v = Math.max(0.5, Math.min(10, v));
    if (chalToleranceEl) chalToleranceEl.value = String(v);
    if (chalTolDisplay)  chalTolDisplay.textContent = v % 1 === 0 ? v.toFixed(1) : String(v);
  }
  chalTolDecBtn?.addEventListener("click", () => {
    setTolerance(parseFloat(chalToleranceEl?.value || "0.5") - 0.5);
  });
  chalTolIncBtn?.addEventListener("click", () => {
    setTolerance(parseFloat(chalToleranceEl?.value || "0.5") + 0.5);
  });
  // Slider: live display
  const slider = document.getElementById("chalTotalAttempts");
  slider?.addEventListener("input", () => {
    if (chalTotalAttDisplay) chalTotalAttDisplay.textContent = slider.value;
  });
})();

// Active challenge type selection
let activeChalType = "power";

document.querySelectorAll(".challenge-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    activeChalType = tab.dataset.ctype;
    document.querySelectorAll(".challenge-tab").forEach(t => t.classList.toggle("active", t === tab));
    const powerFields  = document.getElementById("challengePowerFields");
    const consistFields = document.getElementById("challengeConsistFields");
    if (powerFields)  powerFields.hidden  = activeChalType !== "power";
    if (consistFields) consistFields.hidden = activeChalType !== "consistency";
    chalUpdateUnitLabels();
  });
});

function chalUpdateUnitLabels() {
  const u = settings.units || "mph";
  document.querySelectorAll(".challenge-unit").forEach(el => { el.textContent = u; });
  document.querySelectorAll(".challenge-unit-tol").forEach(el => { el.textContent = `±${u}`; });
}

// Convert user-entered value (in current units) to mph for storage
function chalToMph(v) {
  const u = settings.units || "mph";
  if (u === "kph") return v / MPH_TO_KPH;
  if (u === "fps") return v / MPH_TO_FPS;
  if (u === "mps") return (v / MPH_TO_KPH) / 1000 * 3600;
  return v;
}

// ── Show a view inside the challenge card ─────────────────────────────────────
function chalShowView(view) {
  if (chalSetupEl)    chalSetupEl.hidden    = view !== "setup";
  if (chalProgressEl) chalProgressEl.hidden = view !== "progress";
  if (chalCompleteEl) chalCompleteEl.hidden = view !== "complete";
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startChallenge() {
  if (activeChalType === "power") {
    const tgt = parseFloat(chalTargetPow?.value);
    const req = parseInt(chalReqSuccesses?.value, 10);
    if (!tgt || tgt <= 0 || !req || req < 1) { showToast("Enter valid values."); return; }
    Object.assign(challengeState, {
      type: "power", active: true, result: null,
      targetSpeedMph: chalToMph(tgt),
      requiredSuccesses: req,
      successCount: 0, attemptCount: 0,
    });
  } else {
    const tgt  = parseFloat(chalTargetCon?.value);
    const tol  = parseFloat(chalToleranceEl?.value);
    const tot  = parseInt(chalTotalAtt?.value, 10);
    if (!tgt || tgt <= 0 || isNaN(tol) || tol < 0 || !tot || tot < 1) { showToast("Enter valid values."); return; }
    Object.assign(challengeState, {
      type: "consistency", active: true, result: null,
      targetSpeedMph: chalToMph(tgt),
      toleranceMph:   chalToMph(tol),
      totalAttempts:  tot,
      successCount: 0, attemptCount: 0,
    });
  }
  chalShowView("progress");
  chalUpdateProgressUI();
  chalUpdateStrip();
  showToast("Challenge started! Go break.");
}

// ── Cancel / reset ────────────────────────────────────────────────────────────
function cancelChallenge() {
  Object.assign(challengeState, { active: false, type: null, result: null, successCount: 0, attemptCount: 0 });
  chalShowView("setup");
  chalUpdateStrip();
}

// ── Called after every saved break ───────────────────────────────────────────
function onBreakSaved(speedMph) {
  if (!challengeState.active || speedMph == null) return;

  challengeState.attemptCount++;

  if (challengeState.type === "power") {
    if (speedMph >= challengeState.targetSpeedMph) challengeState.successCount++;
    if (challengeState.successCount >= challengeState.requiredSuccesses) {
      challengeState.active = false;
      challengeState.result = "complete";
      chalShowComplete();
    } else {
      chalUpdateProgressUI();
      chalUpdateStrip();
    }
  } else {
    if (Math.abs(speedMph - challengeState.targetSpeedMph) <= challengeState.toleranceMph) {
      challengeState.successCount++;
    }
    if (challengeState.attemptCount >= challengeState.totalAttempts) {
      challengeState.active = false;
      challengeState.result = "done";
      chalShowComplete();
    } else {
      chalUpdateProgressUI();
      chalUpdateStrip();
    }
  }
}

// ── Update the progress card UI ───────────────────────────────────────────────
function chalUpdateProgressUI() {
  const { type, targetSpeedMph, toleranceMph, requiredSuccesses, totalAttempts, successCount, attemptCount } = challengeState;
  const tgt = fmtStat(targetSpeedMph);

  if (type === "power") {
    if (chalProgressType) chalProgressType.textContent = "⚡ Power Challenge";
    if (chalProgressTgt)  chalProgressTgt.textContent  = `Target: ≥ ${tgt}`;
    if (chalProgressStat) chalProgressStat.textContent = `${successCount} / ${requiredSuccesses} successful breaks`;
    if (chalProgressSub)  chalProgressSub.textContent  = attemptCount > 0 ? `${attemptCount} attempt${attemptCount !== 1 ? "s" : ""} so far` : "";
    const pct = requiredSuccesses > 0 ? Math.min((successCount / requiredSuccesses) * 100, 100) : 0;
    if (chalProgressBar) chalProgressBar.style.width = `${pct}%`;
  } else {
    const tol = fmtStat(toleranceMph);
    const remaining = totalAttempts - attemptCount;
    if (chalProgressType) chalProgressType.textContent = "◎ Consistency Challenge";
    if (chalProgressTgt)  chalProgressTgt.textContent  = `Target: ${tgt} ±${fmtStat(toleranceMph).replace(/\s*\w+$/, "")} ${settings.units || "mph"}`;
    if (chalProgressStat) chalProgressStat.textContent = `${successCount} of ${attemptCount} in range`;
    if (chalProgressSub)  chalProgressSub.textContent  = remaining > 0 ? `${remaining} attempt${remaining !== 1 ? "s" : ""} remaining` : "";
    const pct = totalAttempts > 0 ? Math.min((attemptCount / totalAttempts) * 100, 100) : 0;
    if (chalProgressBar) chalProgressBar.style.width = `${pct}%`;
  }
}

// ── Show completion state ─────────────────────────────────────────────────────
function chalShowComplete() {
  const { type, targetSpeedMph, toleranceMph, requiredSuccesses, totalAttempts, successCount, attemptCount } = challengeState;
  const tgt = fmtStat(targetSpeedMph);

  if (type === "power") {
    if (chalCompleteIcon) chalCompleteIcon.textContent = "🏆";
    if (chalCompleteTit)  chalCompleteTit.textContent  = "Challenge Complete!";
    if (chalCompleteSumm) chalCompleteSumm.textContent = `Hit ${successCount} breaks ≥ ${tgt} in ${attemptCount} attempt${attemptCount !== 1 ? "s" : ""}.`;
    showToast("Challenge complete! 🏆");
  } else {
    const allIn   = successCount === totalAttempts;
    const mostIn  = successCount >= Math.ceil(totalAttempts * 0.7);
    const icon    = allIn ? "🏆" : mostIn ? "✓" : "✗";
    const title   = allIn ? "Perfect Consistency!" : mostIn ? "Good Consistency" : "Challenge Done";
    const tolDisp = fmtStat(toleranceMph);
    if (chalCompleteIcon) chalCompleteIcon.textContent = icon;
    if (chalCompleteTit)  chalCompleteTit.textContent  = title;
    if (chalCompleteSumm) chalCompleteSumm.textContent = `${successCount} of ${totalAttempts} breaks were within ${tgt} ±${tolDisp}.`;
    showToast(`${successCount}/${totalAttempts} in range.`);
  }

  chalShowView("complete");
  chalUpdateStrip();
}

// ── Update the hero-screen strip ──────────────────────────────────────────────
function chalUpdateStrip() {
  if (!chalStripEl) return;

  // Hide strip if nothing is active and no completed result to show
  if (!challengeState.active && challengeState.result == null) {
    chalStripEl.hidden = true;
    return;
  }

  chalStripEl.hidden = false;
  const { type, targetSpeedMph, toleranceMph, requiredSuccesses, totalAttempts, successCount, attemptCount, result } = challengeState;
  const tgt = fmtStat(targetSpeedMph);

  if (type === "power") {
    if (chalStripBadge)    chalStripBadge.textContent    = "⚡";
    if (chalStripProgress) chalStripProgress.textContent = result
      ? `Done! ${successCount}/${requiredSuccesses} breaks ≥ ${tgt}`
      : `${successCount} / ${requiredSuccesses} breaks ≥ ${tgt}`;
  } else {
    const remaining = totalAttempts - attemptCount;
    if (chalStripBadge)    chalStripBadge.textContent    = "◎";
    if (chalStripProgress) chalStripProgress.textContent = result
      ? `Done! ${successCount}/${totalAttempts} in range`
      : `${successCount}/${attemptCount} in range · ${remaining} left`;
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────
chalStartBtn?.addEventListener("click",  startChallenge);
chalCancelBtn?.addEventListener("click", cancelChallenge);
chalStripCancel?.addEventListener("click", cancelChallenge);

chalNewBtn?.addEventListener("click", () => {
  challengeState.result = null;
  chalShowView("setup");
  chalUpdateStrip();
});

chalStripView?.addEventListener("click", () => {
  // Navigate to Stats tab where the challenge card lives
  const statsBtn = document.getElementById("bnavStats");
  statsBtn?.click();
});

// Init: update labels once settings are loaded (called again after settings change)
setTimeout(chalUpdateUnitLabels, 100);

// ─── Dashboard Tab Strip & Compare View ──────────────────────────────────────

let dashActiveTabId  = null;     // "compare" | profileId
let cmpSelectedIds   = new Set();
let cmpBaselineId    = null;
let cmpSortBy        = "avgSpeed";
let cmpStatsCache    = {};       // profileId → stats

const dashTabStrip       = document.getElementById("dashTabStrip");
const compareViewEl      = document.getElementById("compareView");
const personalViewEl     = document.getElementById("personalView");
const cmpPillsRow        = document.getElementById("cmpPillsRow");
const cmpBaselineSelect  = document.getElementById("cmpBaselineSelect");
const cmpSortSelect      = document.getElementById("cmpSortSelect");
const cmpCardsEl         = document.getElementById("cmpCards");
const cmpEmptyEl         = document.getElementById("cmpEmpty");
const cmpWinZoneEl       = document.getElementById("cmpWinZone");
const cmpWinAvgEl        = document.getElementById("cmpWinAvg");
const cmpWinConsistEl    = document.getElementById("cmpWinConsist");

// ── Build the tab strip from current profiles ────────────────────────────────
function buildDashTabs() {
  if (!dashTabStrip) return;
  dashTabStrip.innerHTML = "";

  // Compare tab
  const cmpTab = document.createElement("button");
  cmpTab.className = "dash-tab dash-tab--compare" + (dashActiveTabId === "compare" ? " active" : "");
  cmpTab.dataset.tabid = "compare";
  cmpTab.textContent = "⊞ Compare";
  cmpTab.addEventListener("click", () => switchDashTab("compare"));
  dashTabStrip.appendChild(cmpTab);

  // One tab per profile
  profiles.forEach(p => {
    const tab = document.createElement("button");
    tab.className = "dash-tab" + (dashActiveTabId === p.id ? " active" : "");
    tab.dataset.tabid = p.id;

    const dot = document.createElement("span");
    dot.className = "dash-tab-dot";
    dot.style.background = p.colorAccent || "#aaa";
    tab.appendChild(dot);
    tab.appendChild(document.createTextNode(p.displayName));

    tab.addEventListener("click", () => {
      if (activeProfile?.id !== p.id) setActiveProfile(p);
      switchDashTab(p.id);
    });
    dashTabStrip.appendChild(tab);
  });

  // If no active tab is set yet, default to first profile or compare
  if (!dashActiveTabId) {
    dashActiveTabId = profiles.length > 0 ? profiles[0].id : "compare";
  }
  // Highlight correct tab
  dashTabStrip.querySelectorAll(".dash-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tabid === dashActiveTabId);
  });
}

// ── Switch between compare and personal views ────────────────────────────────
function switchDashTab(tabId) {
  dashActiveTabId = tabId;
  dashTabStrip?.querySelectorAll(".dash-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tabid === tabId);
  });
  const isCompare = tabId === "compare";
  if (compareViewEl) compareViewEl.hidden = !isCompare;
  if (personalViewEl) personalViewEl.hidden = isCompare;
  if (isCompare) {
    loadCompareView();
  } else {
    loadDashboard();
  }
}

// ── Fetch & render Compare view ───────────────────────────────────────────────
async function loadCompareView() {
  if (profiles.length === 0) {
    if (cmpCardsEl) cmpCardsEl.innerHTML = "";
    if (cmpEmptyEl) cmpEmptyEl.hidden = false;
    renderCmpWinners({});
    return;
  }

  // Fetch missing stats
  const missing = profiles.filter(p => !cmpStatsCache[p.id]);
  if (missing.length > 0) {
    const results = await Promise.allSettled(
      missing.map(p => apiGet("/profiles/" + p.id + "/stats"))
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") cmpStatsCache[missing[i].id] = r.value;
    });
  }

  // Ensure all profiles are selected by default (first visit)
  if (cmpSelectedIds.size === 0) profiles.forEach(p => cmpSelectedIds.add(p.id));

  // Ensure baseline is valid
  const selArr = profiles.filter(p => cmpSelectedIds.has(p.id));
  if (!cmpBaselineId || !cmpSelectedIds.has(cmpBaselineId)) {
    cmpBaselineId = selArr[0]?.id || null;
  }

  renderCmpControls();
  renderCmpCards();
}

// ── Render profile toggle pills + baseline/sort controls ──────────────────────
function renderCmpControls() {
  // Pills
  if (cmpPillsRow) {
    cmpPillsRow.innerHTML = "";
    profiles.forEach(p => {
      const pill = document.createElement("button");
      pill.className = "cmp-pill" + (cmpSelectedIds.has(p.id) ? " selected" : "");
      pill.dataset.pid = p.id;

      const dot = document.createElement("span");
      dot.className = "cmp-pill-dot";
      dot.style.background = p.colorAccent || "#aaa";
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(p.displayName));

      const check = document.createElement("span");
      check.className = "cmp-pill-check";
      check.textContent = cmpSelectedIds.has(p.id) ? "✓" : "";
      pill.appendChild(check);

      pill.addEventListener("click", () => {
        if (cmpSelectedIds.has(p.id) && cmpSelectedIds.size > 1) {
          cmpSelectedIds.delete(p.id);
          if (cmpBaselineId === p.id) {
            const remaining = profiles.filter(x => cmpSelectedIds.has(x.id));
            cmpBaselineId = remaining[0]?.id || null;
          }
        } else if (!cmpSelectedIds.has(p.id)) {
          cmpSelectedIds.add(p.id);
        }
        renderCmpControls();
        renderCmpCards();
      });
      cmpPillsRow.appendChild(pill);
    });
  }

  // Baseline select
  const selArr = profiles.filter(p => cmpSelectedIds.has(p.id));
  if (cmpBaselineSelect) {
    cmpBaselineSelect.innerHTML = "";
    selArr.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.displayName;
      if (p.id === cmpBaselineId) opt.selected = true;
      cmpBaselineSelect.appendChild(opt);
    });
  }

  // Sort select — preserve current selection
  if (cmpSortSelect) cmpSortSelect.value = cmpSortBy;
}

// ── Compute helpers ───────────────────────────────────────────────────────────
function computeWinners(selArr, statsMap) {
  if (selArr.length === 0) return { zone: ["—"], avg: ["—"], consist: ["—"] };
  const withData = selArr.filter(p => statsMap[p.id]);

  function winners(arr, fn, higher = true) {
    if (!arr.length) return ["—"];
    const vals = arr.map(p => ({ p, v: fn(statsMap[p.id]) })).filter(x => x.v != null);
    if (!vals.length) return ["—"];
    const best = higher ? Math.max(...vals.map(x => x.v)) : Math.min(...vals.map(x => x.v));
    return vals.filter(x => x.v === best).map(x => x.p.displayName);
  }

  return {
    zone:    winners(withData, s => s.bestHighSpeed),
    avg:     winners(withData, s => s.avgSpeed),
    consist: winners(withData, s => s.consistencyStdDev, false), // lower = better
  };
}

function computeRanks(selArr, statsMap) {
  const ranks = {};
  selArr.forEach(p => ranks[p.id] = {});

  function rank(fn, higher = true) {
    const vals = selArr
      .filter(p => statsMap[p.id] && fn(statsMap[p.id]) != null)
      .map(p => ({ id: p.id, v: fn(statsMap[p.id]) }))
      .sort((a, b) => higher ? b.v - a.v : a.v - b.v);
    vals.forEach((item, i) => { ranks[item.id]._rank_pending = i + 1; });
    return ranks;
  }

  const byZone    = selArr.filter(p => statsMap[p.id] && statsMap[p.id].bestHighSpeed != null).map(p => ({ id: p.id, v: statsMap[p.id].bestHighSpeed })).sort((a, b) => b.v - a.v);
  const byAvg     = selArr.filter(p => statsMap[p.id] && statsMap[p.id].avgSpeed != null).map(p => ({ id: p.id, v: statsMap[p.id].avgSpeed })).sort((a, b) => b.v - a.v);
  const byConsist = selArr.filter(p => statsMap[p.id] && statsMap[p.id].consistencyStdDev != null).map(p => ({ id: p.id, v: statsMap[p.id].consistencyStdDev })).sort((a, b) => a.v - b.v);

  byZone.forEach((x, i)    => ranks[x.id].zone    = i + 1);
  byAvg.forEach((x, i)     => ranks[x.id].avg     = i + 1);
  byConsist.forEach((x, i) => ranks[x.id].consist = i + 1);

  return ranks;
}

function computeBaselineDeltas(selArr, statsMap, baselineId) {
  const bl = statsMap[baselineId];
  const deltas = {};
  selArr.forEach(p => {
    const s = statsMap[p.id];
    if (!s || !bl || p.id === baselineId) { deltas[p.id] = null; return; }
    deltas[p.id] = {
      zone:    bl.bestHighSpeed != null && s.bestHighSpeed != null ? s.bestHighSpeed - bl.bestHighSpeed : null,
      avg:     bl.avgSpeed != null && s.avgSpeed != null ? s.avgSpeed - bl.avgSpeed : null,
      // consistency: positive delta = other is MORE consistent (lower stdDev)
      consist: bl.consistencyStdDev != null && s.consistencyStdDev != null ? bl.consistencyStdDev - s.consistencyStdDev : null,
    };
  });
  return deltas;
}

function computeRelativeBars(selArr, statsMap) {
  const bars = {};
  selArr.forEach(p => bars[p.id] = {});

  function normalize(fn, higher = true) {
    const vals = selArr.filter(p => statsMap[p.id] && fn(statsMap[p.id]) != null).map(p => ({ id: p.id, v: fn(statsMap[p.id]) }));
    if (!vals.length) return;
    const min = Math.min(...vals.map(x => x.v));
    const max = Math.max(...vals.map(x => x.v));
    const span = max - min;
    vals.forEach(({ id, v }) => {
      bars[id][fn.name || "val"] = span > 0 ? (higher ? (v - min) / span : (max - v) / span) * 100 : 50;
    });
  }

  const zoneVals    = selArr.filter(p => statsMap[p.id]?.bestHighSpeed != null).map(p => ({ id: p.id, v: statsMap[p.id].bestHighSpeed }));
  const avgVals     = selArr.filter(p => statsMap[p.id]?.avgSpeed != null).map(p => ({ id: p.id, v: statsMap[p.id].avgSpeed }));
  const consistVals = selArr.filter(p => statsMap[p.id]?.consistencyStdDev != null).map(p => ({ id: p.id, v: statsMap[p.id].consistencyStdDev }));

  function normArr(arr, higher = true) {
    if (!arr.length) return {};
    const min = Math.min(...arr.map(x => x.v));
    const max = Math.max(...arr.map(x => x.v));
    const span = max - min;
    const out = {};
    arr.forEach(({ id, v }) => { out[id] = span > 0 ? (higher ? (v - min) / span : (max - v) / span) * 100 : 50; });
    return out;
  }

  const zoneBars    = normArr(zoneVals, true);
  const avgBars     = normArr(avgVals, true);
  const consistBars = normArr(consistVals, false); // lower stdDev → wider bar

  selArr.forEach(p => {
    bars[p.id] = {
      zone:    zoneBars[p.id] ?? null,
      avg:     avgBars[p.id] ?? null,
      consist: consistBars[p.id] ?? null,
    };
  });
  return bars;
}

// ── Render winner strip ───────────────────────────────────────────────────────
function renderCmpWinners(statsMap) {
  const selArr = profiles.filter(p => cmpSelectedIds.has(p.id));
  const { zone, avg, consist } = computeWinners(selArr, statsMap);
  const fmt = names => {
    const out = names.join(" & ");
    const el = document.createElement("span");
    if (names.length > 1) el.classList.add("cmp-winner-val--tie");
    el.textContent = out;
    return out;
  };
  if (cmpWinZoneEl)    { cmpWinZoneEl.textContent    = zone.join(" & ");    if (zone.length > 1)    cmpWinZoneEl.classList.add("cmp-winner-val--tie");    else cmpWinZoneEl.classList.remove("cmp-winner-val--tie"); }
  if (cmpWinAvgEl)     { cmpWinAvgEl.textContent     = avg.join(" & ");     if (avg.length > 1)     cmpWinAvgEl.classList.add("cmp-winner-val--tie");     else cmpWinAvgEl.classList.remove("cmp-winner-val--tie"); }
  if (cmpWinConsistEl) { cmpWinConsistEl.textContent = consist.join(" & "); if (consist.length > 1) cmpWinConsistEl.classList.add("cmp-winner-val--tie"); else cmpWinConsistEl.classList.remove("cmp-winner-val--tie"); }
}

// ── Render comparison cards ───────────────────────────────────────────────────
function renderCmpCards() {
  if (!cmpCardsEl) return;
  cmpCardsEl.innerHTML = "";

  let selArr = profiles.filter(p => cmpSelectedIds.has(p.id));

  if (selArr.length < 2) {
    if (cmpEmptyEl) cmpEmptyEl.hidden = false;
    renderCmpWinners({});
    return;
  }
  if (cmpEmptyEl) cmpEmptyEl.hidden = true;

  // Sort
  selArr = [...selArr].sort((a, b) => {
    const sa = cmpStatsCache[a.id]; const sb = cmpStatsCache[b.id];
    if (!sa && !sb) return 0; if (!sa) return 1; if (!sb) return -1;
    if (cmpSortBy === "avgSpeed")    return (sb.avgSpeed || 0) - (sa.avgSpeed || 0);
    if (cmpSortBy === "bestHigh")    return (sb.bestHighSpeed || 0) - (sa.bestHighSpeed || 0);
    if (cmpSortBy === "consistency") return (sa.consistencyStdDev || 999) - (sb.consistencyStdDev || 999);
    if (cmpSortBy === "sessions")    return (sb.totalSessions || 0) - (sa.totalSessions || 0);
    return 0;
  });

  renderCmpWinners(cmpStatsCache);
  const ranks  = computeRanks(selArr, cmpStatsCache);
  const deltas = computeBaselineDeltas(selArr, cmpStatsCache, cmpBaselineId);
  const bars   = computeRelativeBars(selArr, cmpStatsCache);

  selArr.forEach(p => {
    const s       = cmpStatsCache[p.id];
    const isBase  = p.id === cmpBaselineId;
    const d       = deltas[p.id];
    const b       = bars[p.id] || {};
    const r       = ranks[p.id] || {};

    const card = document.createElement("div");
    card.className = "cmp-card" + (isBase ? " cmp-card--baseline" : "");

    // Header
    const hdr = document.createElement("div");
    hdr.className = "cmp-card-header";

    const nameRow = document.createElement("div");
    nameRow.className = "cmp-card-name-row";
    const dot = document.createElement("span");
    dot.className = "cmp-card-dot";
    dot.style.background = p.colorAccent || "#aaa";
    const nameEl = document.createElement("span");
    nameEl.className = "cmp-card-name";
    nameEl.textContent = p.displayName;
    nameRow.appendChild(dot);
    nameRow.appendChild(nameEl);
    if (isBase) {
      const badge = document.createElement("span");
      badge.className = "cmp-baseline-badge";
      badge.textContent = "BASELINE";
      nameRow.appendChild(badge);
    }
    hdr.appendChild(nameRow);

    const dateEl = document.createElement("div");
    dateEl.className = "cmp-card-date";
    dateEl.textContent = s ? `${s.totalSessions || 0} session${s.totalSessions !== 1 ? "s" : ""}` : "No data";
    hdr.appendChild(dateEl);
    card.appendChild(hdr);

    // Rank badges
    const rankRow = document.createElement("div");
    rankRow.className = "cmp-ranks";
    const rankDefs = [
      { lbl: "Zone",    key: "zone" },
      { lbl: "Avg Spd", key: "avg" },
      { lbl: "Consist", key: "consist" },
    ];
    rankDefs.forEach(({ lbl, key }) => {
      const rk = r[key];
      if (rk == null) return;
      const badge = document.createElement("span");
      badge.className = `cmp-rank-badge${rk === 1 ? " cmp-rank-badge--1" : rk === 2 ? " cmp-rank-badge--2" : ""}`;
      badge.textContent = `${lbl} #${rk}`;
      rankRow.appendChild(badge);
    });
    card.appendChild(rankRow);

    // Metrics
    const metrics = document.createElement("div");
    metrics.className = "cmp-metrics";

    function metricRow(lbl, valMph, deltaVal, barPct, higherBetter = true) {
      const row = document.createElement("div");
      row.className = "cmp-metric";
      const top = document.createElement("div");
      top.className = "cmp-metric-row";

      const lblEl = document.createElement("span");
      lblEl.className = "cmp-metric-lbl";
      lblEl.textContent = lbl;
      top.appendChild(lblEl);

      const valWrap = document.createElement("div");
      valWrap.className = "cmp-metric-val-wrap";

      const valEl = document.createElement("span");
      valEl.className = "cmp-metric-val";
      valEl.textContent = valMph != null ? fmtStat(valMph) : "—";
      valWrap.appendChild(valEl);

      if (!isBase && deltaVal != null) {
        const deltaEl = document.createElement("span");
        const isBetter = higherBetter ? deltaVal > 0 : deltaVal < 0;
        const isNeutral = Math.abs(deltaVal) < 0.05;
        deltaEl.className = "cmp-delta" + (isNeutral ? " cmp-delta--zero" : isBetter ? " cmp-delta--pos" : " cmp-delta--neg");
        const displayDelta = convertSpeed(Math.abs(deltaVal)).toFixed(1);
        deltaEl.textContent = isNeutral ? "=" : (deltaVal > 0 ? "+" : "−") + displayDelta + " " + settings.units;
        valWrap.appendChild(deltaEl);
      }

      top.appendChild(valWrap);
      row.appendChild(top);

      if (barPct != null) {
        const barWrap = document.createElement("div");
        barWrap.className = "cmp-bar-wrap";
        const bar = document.createElement("div");
        bar.className = "cmp-bar";
        bar.style.width = Math.max(2, barPct) + "%";
        barWrap.appendChild(bar);
        row.appendChild(barWrap);
      }

      return row;
    }

    if (!s || s.totalAttempts === 0) {
      const noData = document.createElement("div");
      noData.className = "cmp-metric cmp-metric--no-data";
      noData.innerHTML = '<span class="cmp-metric-val">No data yet</span>';
      metrics.appendChild(noData);
    } else {
      metrics.appendChild(metricRow("Best Zone",   s.bestHighSpeed,     d?.zone,    b.zone,    true));
      metrics.appendChild(metricRow("Avg Speed",   s.avgSpeed,          d?.avg,     b.avg,     true));
      // Consistency delta: positive = other is more consistent
      const cdelta = d?.consist;
      metrics.appendChild(metricRow("Consistency", s.consistencyStdDev != null ? s.consistencyStdDev : null, cdelta, b.consist, false));
    }
    card.appendChild(metrics);
    cmpCardsEl.appendChild(card);
  });
}

// ── Wire compare controls ─────────────────────────────────────────────────────
cmpBaselineSelect?.addEventListener("change", () => {
  cmpBaselineId = cmpBaselineSelect.value;
  renderCmpCards();
});
cmpSortSelect?.addEventListener("change", () => {
  cmpSortBy = cmpSortSelect.value;
  renderCmpCards();
});

// ── Invalidate cache on new session saved ─────────────────────────────────────
function invalidateCmpCache(profileId) {
  if (profileId) delete cmpStatsCache[profileId];
  else cmpStatsCache = {};
}

// ─── Pro Feature Gating ──────────────────────────────────────────────────────

const FREE_HISTORY_LIMIT = 10; // sessions shown to free users

// Feature label map for modal context
const PRO_FEATURE_LABELS = {
  coaching:    "Coaching Insights — benchmark, training zone, and per-break feedback.",
  consistency: "Consistency Chart — track your shot-to-shot variance over time.",
  challenge:   "Challenge Mode — set a target speed and hit it consistently.",
  export:      "Export & Sharing — download your session data or share your best breaks.",
  history:     "Unlimited History — access every session you have ever recorded.",
};

function _resetRestoreForm() {
  proModalRestoreForm.hidden = true;
  proModalRestore.hidden = false;
  proModalRestoreEmail.value = "";
  proModalRestoreSubmit.disabled = false;
  proModalRestoreSubmit.textContent = "Check Purchase";
}

function openProModal(feature) {
  const label = PRO_FEATURE_LABELS[feature] || "";
  proModalFeatureLbl.textContent = label;
  proModalCtaText.textContent = "Unlock Pro";
  proModalSpinner.hidden = true;
  proModalCta.disabled = false;
  _resetRestoreForm();
  proModalOverlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeProModal() {
  proModalOverlay.hidden = true;
  document.body.style.overflow = "";
  _resetRestoreForm();
}

async function handleProUpgrade() {
  proModalCtaText.textContent = "Redirecting to payment…";
  proModalSpinner.hidden = false;
  proModalCta.disabled = true;
  try {
    // initiateCheckout() redirects to Stripe Checkout — never returns normally.
    // On payment success, Stripe sends the user back to /?pro=success&session_id=xxx
    // which is handled by handleStripeReturn() on next page load.
    await BILLING.initiateCheckout();
  } catch (err) {
    proModalCtaText.textContent = "Unlock Pro";
    proModalSpinner.hidden = true;
    proModalCta.disabled = false;
    showToast("Could not start checkout — please try again.");
  }
}

function handleProRestore() {
  // First check localStorage (same device / browser)
  if (BILLING.isProUser()) {
    closeProModal();
    applyProGating();
    showToast("Pro is already active on this device!");
    return;
  }
  // Show email lookup form for new device / cleared storage
  proModalRestore.hidden = true;
  proModalRestoreForm.hidden = false;
  setTimeout(() => proModalRestoreEmail.focus(), 50);
}

async function handleRestoreEmailSubmit() {
  const email = proModalRestoreEmail.value.trim();
  if (!email || !email.includes("@")) {
    showToast("Please enter a valid email address.");
    return;
  }
  proModalRestoreSubmit.disabled = true;
  proModalRestoreSubmit.textContent = "Checking…";
  try {
    const result = await BILLING.restoreByEmail(email);
    if (result.verified) {
      closeProModal();
      applyProGating();
      showToast("Purchase restored — Pro is active!");
    } else {
      showToast("No paid purchase found for that email.");
      proModalRestoreSubmit.disabled = false;
      proModalRestoreSubmit.textContent = "Check Purchase";
    }
  } catch {
    showToast("Could not check purchase — please try again.");
    proModalRestoreSubmit.disabled = false;
    proModalRestoreSubmit.textContent = "Check Purchase";
  }
}

proModalRestoreSubmit.addEventListener("click", handleRestoreEmailSubmit);
proModalRestoreCancel.addEventListener("click", _resetRestoreForm);
proModalRestoreEmail.addEventListener("keydown", e => {
  if (e.key === "Enter") handleRestoreEmailSubmit();
});

function applyProGating() {
  const isPro = BILLING.isProUser();

  // Settings row
  if (isPro) {
    settingsProLbl.textContent  = "Pro — Active";
    settingsProIcon.textContent = "★";
    settingsProIcon.style.color = "#ffd93d";
    settingsProBtn.textContent  = "Manage Subscription";
    settingsProBtn.classList.add("settings-pro-btn--active");
  } else {
    settingsProLbl.textContent  = "Free Plan";
    settingsProIcon.textContent = "◎";
    settingsProIcon.style.color = "";
    settingsProBtn.textContent  = "Upgrade to Pro";
    settingsProBtn.classList.remove("settings-pro-btn--active");
  }

  // Coaching section: show real section for Pro, preview card for free (only when visible)
  const coachShouldShow = !coachingSection.hidden || !proCoachPreview.hidden;
  if (coachShouldShow) {
    coachingSection.hidden = isPro ? false : true;
    proCoachPreview.hidden = isPro ? true  : false;
  }

  // Consistency chart: show real chart for Pro, preview card for free (only when trends visible)
  if (!trendsSection.hidden) {
    consistChartCard.hidden  = isPro ? false : true;
    proConsistPreview.hidden = isPro ? true  : false;
  }

  // Pro extras section — toggle locked vs active cards based on Pro status
  const challengeLocked  = document.getElementById("challengeLockedCard");
  const challengeActive  = document.getElementById("challengeActiveCard");
  const exportLocked     = document.getElementById("exportLockedCard");
  const exportActive     = document.getElementById("exportActiveCard");
  if (challengeLocked)  challengeLocked.hidden  = isPro;
  if (challengeActive)  challengeActive.hidden  = !isPro;
  if (exportLocked)     exportLocked.hidden     = isPro;
  if (exportActive)     exportActive.hidden     = !isPro;
  proExtrasSection.hidden = activeProfile == null;
}

function updateProGatingForDashboard(hasData) {
  const isPro = BILLING.isProUser();
  // Coaching preview shows when there is data and user is free
  proCoachPreview.hidden = !(hasData && !isPro);
  // Consistency and extras show when trendsSection is visible
  if (hasData) {
    consistChartCard.hidden  = !isPro;
    proConsistPreview.hidden =  isPro;
    proExtrasSection.hidden  = false;
  } else {
    proConsistPreview.hidden = true;
    consistChartCard.hidden  = false;
    proExtrasSection.hidden  = true;
  }
}

// ─── CSV Export ────────────────────────────────────────────────────────────
function exportSessionsCsv() {
  if (!historyData || historyData.length === 0) {
    showToast("No sessions to export yet.");
    return;
  }
  const unitLabel = settings.units || "mph";
  const rows = [
    ["Date", `Best Speed (${unitLabel})`, "Confidence", "Rack", "Attempts", "Source"],
  ];
  historyData.forEach(sess => {
    const spd = sess.bestSpeed != null ? String(Math.round(convertSpeed(sess.bestSpeed) * 10) / 10) : "";
    rows.push([
      fmtDate(sess.createdAt),
      spd,
      sess.bestConf || "",
      RACK_LABELS[sess.rackConfig] || sess.rackConfig || "",
      String(sess.attemptCount || ""),
      sess.sourceType || "",
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `break-sessions-${activeProfile?.displayName?.replace(/\s+/g,"-") || "player"}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("CSV downloaded!");
}

document.getElementById("exportCsvBtn")?.addEventListener("click", exportSessionsCsv);

// ─── Pro Modal Event Handlers ──────────────────────────────────────────────

proModalClose.addEventListener("click", closeProModal);
proModalOverlay.addEventListener("click", e => {
  if (e.target === proModalOverlay) closeProModal();
});
proModalCta.addEventListener("click", handleProUpgrade);
proModalRestore.addEventListener("click", handleProRestore);

// Delegate all Pro unlock button clicks to open modal with correct feature context
document.addEventListener("click", e => {
  const btn = e.target.closest(".pro-unlock-btn, .hist-pro-unlock");
  if (!btn) return;
  openProModal(btn.dataset.feature || "");
});

// Settings Pro button
settingsProBtn.addEventListener("click", () => {
  if (BILLING.isProUser()) {
    // TODO: open Stripe Customer Portal when available
    showToast("Manage your subscription at promethean-games.com/account");
  } else {
    openProModal("all");
  }
});

// ─── Stripe Return Handler ─────────────────────────────────────────────────────
// Runs on page load to handle Stripe's success/cancel redirect.
async function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const proParam    = params.get("pro");
  const sessionId   = params.get("session_id");

  if (!proParam) return;

  // Clean the URL so the params don't persist on refresh
  const cleanUrl = window.location.pathname;
  history.replaceState(null, "", cleanUrl);

  if (proParam === "cancel") {
    showToast("Payment cancelled — no charge made.");
    return;
  }

  if (proParam === "success" && sessionId) {
    showToast("Verifying your payment…");
    try {
      const result = await BILLING.verifySession(sessionId);
      if (result.verified) {
        applyProGating();
        showToast("Pro unlocked — thank you!");
        // Reload dashboard data if user is on Stats screen
        if (!screenDashboard.hidden) {
          loadHistory().then(() => loadStats().then(() => loadTrends()));
        }
      } else {
        showToast("Payment could not be verified — please contact support.");
      }
    } catch {
      showToast("Verification error — please try again or contact support.");
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
initSettings();
initBreakSetup();
applyAdsState();
applyProGating();
loadProfiles().then(() => {
  loadSetupFromProfile();
  showScreen(screenHero);
  checkFirstVisit();
  handleStripeReturn();
});
