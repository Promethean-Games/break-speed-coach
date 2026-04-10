"use strict";

// ─── Local storage keys ───────────────────────────────────────────────────────
const PROFILES_KEY = "bsc_profiles";
const SESSIONS_KEY = "bsc_sessions";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]"); } catch { return []; }
}
function saveProfiles(list) {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(list)); } catch {}
}

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); } catch { return []; }
}
function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)); } catch {}
}

// ─── Profile CRUD ─────────────────────────────────────────────────────────────

export function getProfiles() {
  return loadProfiles();
}

export function getProfile(id) {
  return loadProfiles().find(p => p.id === id) || null;
}

export function createProfile({ displayName, colorAccent = "#00d4ff", notes = "" }) {
  const list = loadProfiles();
  const profile = { id: uid(), displayName, colorAccent, notes, createdAt: new Date().toISOString() };
  list.push(profile);
  saveProfiles(list);
  return profile;
}

export function updateProfile(id, fields) {
  const list = loadProfiles();
  const idx  = list.findIndex(p => p.id === id);
  if (idx < 0) throw new Error("Profile not found");
  list[idx] = { ...list[idx], ...fields };
  saveProfiles(list);
  return list[idx];
}

export function deleteProfile(id) {
  const profiles = loadProfiles().filter(p => p.id !== id);
  saveProfiles(profiles);
  const sessions = loadSessions().filter(s => s.profileId !== id);
  saveSessions(sessions);
  return { ok: true };
}

// ─── Session save / retrieval ──────────────────────────────────────────────────

/**
 * Save a break session (result from analyzeFiles()) for a profile.
 * Returns { session }.
 */
export function saveSession(profileId, sourceType, analyzeResult, rackConfig) {
  const { files, session } = analyzeResult;
  const list = loadSessions();

  const rankable = files.filter(f =>
    f.speedMph != null && !f.speedFlag &&
    (f.confidence === "high" || f.confidence === "near_high" || f.confidence === "medium")
  );
  const highOnly = rankable.filter(f => f.confidence === "high");

  const bestSpeed = session.bestBreak?.speedMph ?? session.topEstimate?.speedMph ?? null;
  const bestConf  = session.bestBreak?.confidence ?? session.topEstimate?.confidence ?? null;
  const consistStdDev = session.consistency?.stdDev ?? null;

  const attempts = files.map(f => ({
    id:              uid(),
    filename:        f.filename,
    estimatedSpeed:  f.speedMph,
    confidenceTier:  f.confidence,
    pairScore:       f.pairScore,
    eventQuality:    f.eventQuality,
    timingFactor:    f.timingFactor,
    dominanceRatio:  f.dominanceRatio,
    speedMode:       f.speedMode,
    speedFlag:       f.speedFlag,
    isRankable:      rankable.some(r => r.filename === f.filename),
    errorMessage:    f.error || null,
    createdAt:       new Date().toISOString(),
  }));

  const sess = {
    id:               uid(),
    profileId,
    createdAt:        new Date().toISOString(),
    sourceType:       sourceType || "recorded",
    rackConfig:       rackConfig || null,
    attemptCount:     files.length,
    sessionAvg:       session.sessionAvg,
    bestSpeed,
    bestConf,
    consistencySigma: consistStdDev,
    rankableCount:    rankable.length,
    highCount:        highOnly.length,
    attempts,
    // Outcome columns (set later via saveOutcome)
    outcomeTagged:       false,
    scratched:           null,
    objectBallPocketed:  null,
    breakAndRun:         null,
    moneyBallOnBreak:    null,
    gameMode:            null,
    outcomeScore:        null,
  };

  list.unshift(sess);
  saveSessions(list);
  return { session: sess };
}

export function deleteSession(id) {
  const list = loadSessions().filter(s => s.id !== id);
  saveSessions(list);
  return { ok: true };
}

export function clearHistory(profileId) {
  const list = loadSessions().filter(s => s.profileId !== profileId);
  saveSessions(list);
  return { ok: true };
}

// ─── History retrieval (newest-first) ─────────────────────────────────────────

export function getHistory(profileId) {
  return loadSessions()
    .filter(s => s.profileId === profileId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ─── Stats computation ────────────────────────────────────────────────────────

export function getStats(profileId) {
  const sessions = getHistory(profileId);
  if (sessions.length === 0) {
    return {
      totalAttempts: 0, totalSessions: 0, rankableAttempts: 0,
      avgSpeed: null, bestHighSpeed: null, last10Avg: null,
      consistency: null, consistencyStdDev: null,
      highAttempts: 0, highPct: 0, insightText: null,
    };
  }

  const allAttempts = sessions.flatMap(s => s.attempts || []);
  const rankable    = allAttempts.filter(a =>
    a.estimatedSpeed != null && a.isRankable && !a.speedFlag
  );
  const highOnly    = rankable.filter(a => a.confidenceTier === "high");

  let avgSpeed = null;
  if (highOnly.length >= 2) {
    avgSpeed = highOnly.reduce((s, a) => s + a.estimatedSpeed, 0) / highOnly.length;
  } else if (rankable.length >= 1) {
    avgSpeed = rankable.reduce((s, a) => s + a.estimatedSpeed, 0) / rankable.length;
  }

  const bestHighSpeed = highOnly.reduce((best, a) =>
    a.estimatedSpeed > (best ?? -Infinity) ? a.estimatedSpeed : best, null);

  // Last 10 ranked attempts
  const last10  = rankable.slice(0, 10);
  const last10Avg = last10.length
    ? last10.reduce((s, a) => s + a.estimatedSpeed, 0) / last10.length : null;

  // Consistency across all sessions (use bestSpeed per session)
  const sessionSpeeds = sessions
    .map(s => s.bestSpeed)
    .filter(v => v != null);
  let consistency = null, consistencyStdDev = null;
  if (sessionSpeeds.length >= 2) {
    const mean   = sessionSpeeds.reduce((s, v) => s + v, 0) / sessionSpeeds.length;
    const stdDev = Math.sqrt(sessionSpeeds.reduce((s, v) => s + (v - mean) ** 2, 0) / sessionSpeeds.length);
    consistencyStdDev = stdDev;
    consistency = stdDev < 1.5 ? "Consistent" : stdDev < 3.0 ? "Variable" : "Inconsistent";
  }

  const highAttempts = highOnly.length;
  const highPct = allAttempts.length
    ? Math.round((highAttempts / allAttempts.length) * 100) : 0;

  // Insight text
  let insightText = null;
  if (bestHighSpeed && last10Avg) {
    const diff = last10Avg - (avgSpeed || last10Avg);
    if (diff > 1.0)  insightText = `Your last 10 breaks average ${last10Avg.toFixed(1)} mph — trending up.`;
    else if (diff < -1.0) insightText = `Your last 10 breaks show a ${Math.abs(diff).toFixed(1)} mph dip — focus on consistency.`;
  }
  if (!insightText && highAttempts >= 3 && consistency === "Consistent") {
    insightText = "Consistent HIGH readings — your break technique is dialed in.";
  }

  return {
    totalAttempts:   allAttempts.length,
    totalSessions:   sessions.length,
    rankableAttempts: rankable.length,
    avgSpeed, bestHighSpeed, last10Avg,
    consistency, consistencyStdDev,
    highAttempts, highPct, insightText,
  };
}

// ─── Trend data ───────────────────────────────────────────────────────────────

/**
 * range: "10" | "25" | "50" | "all"  (session count)
 * mode:  "rankable" | "high" | "sessionAvg"
 */
export function getTrendSpeed(profileId, range = "10", mode = "rankable") {
  let sessions = getHistory(profileId).reverse(); // oldest first
  if (range !== "all") {
    const n = Number(range);
    if (!isNaN(n)) sessions = sessions.slice(-n);
  }

  return sessions
    .map(s => {
      let speed = null, conf = null;
      if (mode === "high") {
        const highAttempt = (s.attempts || []).find(a => a.confidenceTier === "high" && a.estimatedSpeed != null);
        speed = highAttempt?.estimatedSpeed ?? null;
        conf  = "high";
      } else if (mode === "sessionAvg") {
        speed = s.sessionAvg;
        conf  = s.bestConf;
      } else {
        // rankable: use bestSpeed (highest rankable attempt)
        speed = s.bestSpeed;
        conf  = s.bestConf;
      }
      if (speed == null) return null;
      return { timestamp: s.createdAt, speed, confidenceTier: conf || "medium" };
    })
    .filter(Boolean);
}

export function getTrendConsistency(profileId, range = "10") {
  let sessions = getHistory(profileId).reverse();
  if (range !== "all") {
    const n = Number(range);
    if (!isNaN(n)) sessions = sessions.slice(-n);
  }

  return sessions
    .map(s => {
      if (s.consistencySigma == null || s.attemptCount < 2) return null;
      return {
        timestamp:    s.createdAt,
        consistency:  s.consistencySigma,
        attemptCount: s.attemptCount,
      };
    })
    .filter(Boolean);
}

// ─── Outcome tagging ──────────────────────────────────────────────────────────

const OUTCOME_WEIGHTS = {
  moneyBallOnBreak:   5.0,
  breakAndRun:        4.0,
  objectBallPocketed: 2.0,
  scratched:         -3.0,
};
const CONF_MULTIPLIER = {
  high: 1.00, near_high: 0.85, medium: 0.60, low: 0.30, very_low: 0.15,
};

function computeOutcomeScore(tags, session) {
  let score = 0;
  if (tags.scratched)          score += OUTCOME_WEIGHTS.scratched;
  if (tags.objectBallPocketed) score += OUTCOME_WEIGHTS.objectBallPocketed;
  if (tags.breakAndRun)        score += OUTCOME_WEIGHTS.breakAndRun;
  if (tags.moneyBallOnBreak)   score += OUTCOME_WEIGHTS.moneyBallOnBreak;
  const conf = session.bestConf || "medium";
  return score * (CONF_MULTIPLIER[conf] ?? 0.60);
}

export function saveOutcome(sessionId, tags) {
  const list = loadSessions();
  const idx  = list.findIndex(s => s.id === sessionId);
  if (idx < 0) throw new Error("Session not found");
  const session = list[idx];
  list[idx] = {
    ...session,
    outcomeTagged:      true,
    scratched:          !!tags.scratched,
    objectBallPocketed: !!tags.objectBallPocketed,
    breakAndRun:        !!tags.breakAndRun,
    moneyBallOnBreak:   !!tags.moneyBallOnBreak,
    gameMode:           tags.gameMode || null,
    outcomeScore:       computeOutcomeScore(tags, session),
  };
  saveSessions(list);
  return list[idx];
}

// ─── Outcome coaching ─────────────────────────────────────────────────────────

const SPEED_BUCKET_MPH    = 1.5;
const MIN_BUCKET_COUNT    = 2;
const SCRATCH_RISK_RATE   = 0.35;

export function getOutcomeCoaching(profileId) {
  const sessions = getHistory(profileId);
  const tagged   = sessions.filter(s => s.outcomeTagged && s.bestSpeed != null);
  const total    = sessions.length;

  if (tagged.length === 0) {
    return { taggedCount: 0, totalCount: total, idealZone: null, scratchRisk: null, insights: [] };
  }

  // Group by speed bucket
  const buckets = {};
  for (const s of tagged) {
    const bucket = Math.floor(s.bestSpeed / SPEED_BUCKET_MPH);
    if (!buckets[bucket]) buckets[bucket] = { sessions: [], scores: [], scratches: 0 };
    buckets[bucket].sessions.push(s);
    buckets[bucket].scores.push(s.outcomeScore ?? 0);
    if (s.scratched) buckets[bucket].scratches++;
  }

  // Find bucket with highest avg score and enough data
  let bestBucket = null, bestAvg = -Infinity;
  for (const [key, data] of Object.entries(buckets)) {
    if (data.sessions.length < MIN_BUCKET_COUNT) continue;
    const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
    if (avg > bestAvg) { bestAvg = avg; bestBucket = { key: Number(key), data, avg }; }
  }

  let idealZone = null;
  if (bestBucket) {
    idealZone = {
      lowMph:  bestBucket.key * SPEED_BUCKET_MPH,
      highMph: (bestBucket.key + 1) * SPEED_BUCKET_MPH,
      avgScore: bestBucket.avg,
      count:    bestBucket.data.sessions.length,
    };
  }

  // Scratch risk: check if upper-half speed buckets have higher scratch rate than baseline
  const allScratchRate = tagged.length > 0
    ? tagged.filter(s => s.scratched).length / tagged.length : 0;
  const allSpeeds   = tagged.map(s => s.bestSpeed).sort((a, b) => a - b);
  const medianSpeed = allSpeeds[Math.floor(allSpeeds.length / 2)] ?? null;
  const upperSessions = medianSpeed != null ? tagged.filter(s => s.bestSpeed >= medianSpeed) : [];
  const upperScratch  = upperSessions.length > 0
    ? upperSessions.filter(s => s.scratched).length / upperSessions.length : 0;

  const scratchRisk = (upperScratch > SCRATCH_RISK_RATE && upperScratch > allScratchRate * 1.5 && upperSessions.length >= 2)
    ? { thresholdMph: medianSpeed, upperScratchRate: Math.round(upperScratch * 100) }
    : null;

  // Build insights
  const insights = [];
  if (idealZone) {
    insights.push(`Best outcomes occur between ${idealZone.lowMph.toFixed(1)}–${idealZone.highMph.toFixed(1)} mph.`);
  }
  if (scratchRisk) {
    insights.push(`Scratch risk rises above ${scratchRisk.thresholdMph.toFixed(1)} mph (${scratchRisk.upperScratchRate}% of upper-range breaks scratch).`);
  }
  if (!idealZone && tagged.length < MIN_BUCKET_COUNT * 2) {
    insights.push(`Tag ${Math.max(0, MIN_BUCKET_COUNT * 2 - tagged.length)} more breaks to unlock your ideal speed zone.`);
  }

  return { taggedCount: tagged.length, totalCount: total, idealZone, scratchRisk, insights };
}
