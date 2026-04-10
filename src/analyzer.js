"use strict";

// ─── Constants (mirrored from breakAnalyzer.js) ───────────────────────────────
const HP_ALPHA              = 0.95;
const WAV_ENVELOPE_WINDOW   = 220;      // samples at 44100 Hz ≈ 5 ms
const MIN_PEAK_GAP_MS       = 50;
const THRESHOLD_MULTIPLIER  = 2.5;
const WAV_SHARPNESS_NEIGHBORS = 660;   // ~15 ms at 44100 Hz

const PAIR_MIN_DELTA_MS     =  50;
const PAIR_MAX_DELTA_MS     = 600;
const PAIR_PREF_MIN_MS      =  80;
const PAIR_PREF_MAX_MS      = 350;
const PAIR_PREF_CENTER_MS   = 180;
const CLUSTER_GAP_MS        =  65;
const CLUSTER_DENSITY_MS    =  60;
const A_ISOLATION_WINDOW_MS = 100;

const HIGH_PAIR_SCORE_MIN      = 0.80;
const HIGH_EVENT_QUALITY_MIN   = 1.20;
const HIGH_TIMING_MIN          = 0.90;
const HIGH_DOMINANCE_MIN       = 0.20;
const HIGH_PAIR_SCORE_OVERRIDE = 0.85;

const NEAR_HIGH_PAIR_SCORE_MIN    = 0.72;
const NEAR_HIGH_EVENT_QUALITY_MIN = 1.10;
const NEAR_HIGH_TIMING_MIN        = 0.90;

const SPEED_MIN_REALISTIC_MPH    = 14;
const SPEED_MAX_REALISTIC_MPH    = 30;
const SPEED_SUPPRESS_BELOW_MPH   = 10;
const OUTLIER_MEDIAN_THRESHOLD_MPH = 5.5;

const CONF_DOWN = {
  high: "medium", near_high: "medium", medium: "low",
  low: "very_low", very_low: "very_low",
};

const TABLE_DISTANCES_FT = { "7ft": 3.2, "8ft": 3.6, "9ft": 4.2 };

// ─── Audio decoding (browser) ─────────────────────────────────────────────────

/**
 * Decode a File/Blob to mono Float32Array using the Web Audio API.
 * The browser handles all formats: webm, ogg, mp4, wav, etc.
 *
 * @param {File} file
 * @returns {Promise<{ mono: Float32Array, sampleRate: number }>}
 */
async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }

  const { sampleRate, numberOfChannels, length } = decoded;
  const mono = new Float32Array(length);

  // Mix down to mono
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channelData = decoded.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += channelData[i];
  }
  for (let i = 0; i < length; i++) mono[i] /= numberOfChannels;

  // Peak-normalize to [-1, 1]
  let peak = 0;
  for (let i = 0; i < length; i++) if (Math.abs(mono[i]) > peak) peak = Math.abs(mono[i]);
  if (peak > 0) for (let i = 0; i < length; i++) mono[i] /= peak;

  return { mono, sampleRate };
}

// ─── DSP pipeline ─────────────────────────────────────────────────────────────

function highPassFilter(signal, alpha) {
  const out = new Float32Array(signal.length);
  out[0] = signal[0];
  for (let i = 1; i < signal.length; i++) {
    out[i] = alpha * (out[i - 1] + signal[i] - signal[i - 1]);
  }
  return out;
}

function amplitudeEnvelope(signal, windowSize) {
  const env  = new Float32Array(signal.length);
  const half = Math.floor(windowSize / 2);
  let sum = 0;
  for (let i = 0; i < windowSize && i < signal.length; i++) sum += Math.abs(signal[i]);
  for (let i = 0; i < signal.length; i++) {
    env[i] = sum / windowSize;
    const rem = i - half, add = i + half + 1;
    if (rem >= 0) sum -= Math.abs(signal[rem]);
    if (add < signal.length) sum += Math.abs(signal[add]);
  }
  return env;
}

function preprocessSignal(mono, sampleRate) {
  const filtered = highPassFilter(mono, HP_ALPHA);
  const window   = Math.max(1, Math.round((WAV_ENVELOPE_WINDOW / 44100) * sampleRate));
  const envelope = amplitudeEnvelope(filtered, window);
  return { filtered, envelope };
}

function detectWavPeaks(envelope, sampleRate) {
  const minGapSamples = Math.round((MIN_PEAK_GAP_MS / 1000) * sampleRate);
  let mean = 0;
  for (let i = 0; i < envelope.length; i++) mean += envelope[i];
  mean /= envelope.length;
  const threshold = mean * THRESHOLD_MULTIPLIER;

  const peaks = [];
  let lastIdx = -minGapSamples;

  for (let i = 1; i < envelope.length - 1; i++) {
    const v = envelope[i];
    if (v < threshold) continue;
    if (v <= envelope[i - 1] || v <= envelope[i + 1]) continue;
    if (i - lastIdx < minGapSamples) {
      if (peaks.length > 0 && v > envelope[peaks[peaks.length - 1]]) {
        peaks[peaks.length - 1] = i; lastIdx = i;
      }
      continue;
    }
    peaks.push(i); lastIdx = i;
  }
  return peaks;
}

function classifySharpness(score) {
  if (score >= 1.5) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

function scoreWavPeak(idx, envelope, _filtered, sampleRate) {
  const timestamp = idx / sampleRate;
  const amplitude = envelope[idx];

  const lookback = Math.min(WAV_SHARPNESS_NEIGHBORS, idx);
  const start = idx - lookback;
  let preSum = 0;
  for (let i = start; i < idx; i++) preSum += envelope[i];
  const preMean = lookback > 0 ? preSum / lookback : 0;
  const sharpnessScore = preMean > 0 ? (amplitude - preMean) / preMean : amplitude;

  return { timestamp, amplitude, sharpnessScore, sharpness: classifySharpness(sharpnessScore) };
}

// ─── Peak clustering ───────────────────────────────────────────────────────────

function sharpnessWeight(label) {
  if (label === "high")   return 1.00;
  if (label === "medium") return 0.55;
  return 0.15;
}

const clamp01 = x => Math.max(0, Math.min(1, x));

function buildCluster(peakArr) {
  const rep       = peakArr.reduce((b, p) => p.amplitude > b.amplitude ? p : b, peakArr[0]);
  const startTime = peakArr[0].timestamp;
  const endTime   = peakArr[peakArr.length - 1].timestamp;
  const span      = (endTime - startTime) * 1000;
  const energy    = peakArr.reduce((s, p) => s + p.amplitude, 0);
  const density   = peakArr.length === 1
    ? 0.5
    : Math.min(1, (peakArr.length - 1) / Math.max(span / CLUSTER_DENSITY_MS, 1));
  return { peaks: peakArr, rep, size: peakArr.length, startTime, endTime, span, energy, density };
}

function clusterPeaks(peaks) {
  const chrono = [...peaks].sort((a, b) => a.timestamp - b.timestamp);
  if (chrono.length === 0) return [];
  const clusters = [];
  let current = [chrono[0]];
  for (let i = 1; i < chrono.length; i++) {
    const gap = (chrono[i].timestamp - chrono[i - 1].timestamp) * 1000;
    if (gap <= CLUSTER_GAP_MS) {
      current.push(chrono[i]);
    } else {
      clusters.push(buildCluster(current));
      current = [chrono[i]];
    }
  }
  clusters.push(buildCluster(current));
  return clusters;
}

// ─── Pair scoring ─────────────────────────────────────────────────────────────

function scoreClusterPair(aPeak, bCluster, deltaMs, aIdx, chrono) {
  const ampFactor    = clamp01(Math.log1p(Math.sqrt(aPeak.amplitude * bCluster.rep.amplitude) * 5) / Math.log1p(5));
  const energyFactor = clamp01(Math.log1p(bCluster.energy * 4) / Math.log1p(4));
  const densityFactor = bCluster.density;
  const sharpFactor   = clamp01((sharpnessWeight(aPeak.sharpness) + sharpnessWeight(bCluster.rep.sharpness)) / 2);

  let timingFactor;
  if (deltaMs >= PAIR_PREF_MIN_MS && deltaMs <= PAIR_PREF_MAX_MS) {
    const center = PAIR_PREF_CENTER_MS;
    const halfSpan = Math.max(PAIR_PREF_MAX_MS - center, center - PAIR_PREF_MIN_MS);
    timingFactor = 1.0 - 0.15 * (Math.abs(deltaMs - center) / halfSpan);
  } else if (deltaMs < PAIR_PREF_MIN_MS) {
    timingFactor = 0.40 * ((deltaMs - PAIR_MIN_DELTA_MS) / (PAIR_PREF_MIN_MS - PAIR_MIN_DELTA_MS));
  } else {
    timingFactor = 0.40 * ((PAIR_MAX_DELTA_MS - deltaMs) / (PAIR_MAX_DELTA_MS - PAIR_PREF_MAX_MS));
  }
  timingFactor = clamp01(timingFactor);

  let strongerPriorCount = 0;
  for (let k = aIdx - 1; k >= 0; k--) {
    const gap = (aPeak.timestamp - chrono[k].timestamp) * 1000;
    if (gap > A_ISOLATION_WINDOW_MS) break;
    if (chrono[k].amplitude >= aPeak.amplitude * 0.70) strongerPriorCount++;
  }
  const aIsoFactor = strongerPriorCount === 0 ? 1.00 : strongerPriorCount === 1 ? 0.65 : 0.35;

  const pairScore = clamp01(
    0.25 * ampFactor + 0.15 * energyFactor + 0.10 * densityFactor +
    0.15 * sharpFactor + 0.25 * timingFactor + 0.10 * aIsoFactor
  );

  return { pairScore, ampFactor, energyFactor, densityFactor, sharpFactor, timingFactor, aIsoFactor };
}

function generateClusterPairs(peaks, options = {}) {
  const minDeltaMs = options.minDeltaMs ?? PAIR_MIN_DELTA_MS;
  const maxDeltaMs = options.maxDeltaMs ?? PAIR_MAX_DELTA_MS;
  const chrono     = [...peaks].sort((a, b) => a.timestamp - b.timestamp);
  const clusters   = clusterPeaks(peaks);
  const pairs      = [];

  for (let i = 0; i < chrono.length; i++) {
    const aPeak       = chrono[i];
    const aClusterIdx = clusters.findIndex(c => c.peaks.includes(aPeak));
    for (let ci = 0; ci < clusters.length; ci++) {
      if (ci === aClusterIdx) continue;
      const bCluster = clusters[ci];
      const deltaMs  = (bCluster.rep.timestamp - aPeak.timestamp) * 1000;
      if (deltaMs < minDeltaMs || deltaMs > maxDeltaMs) continue;
      const scores = scoreClusterPair(aPeak, bCluster, deltaMs, i, chrono);
      pairs.push({ peak1: aPeak, cluster2: bCluster, deltaMs, ...scores });
    }
  }
  pairs.sort((a, b) => b.pairScore - a.pairScore);
  return pairs;
}

// ─── Confidence assignment ─────────────────────────────────────────────────────

function assignConfidence(pairs) {
  if (pairs.length === 0) {
    return { confidence: "low", reason: "no valid pairs found", dominanceRatio: 0, eventQuality: 0 };
  }
  const best     = pairs[0];
  const runnerUp = pairs[1];
  const dominanceRatio = runnerUp ? 1 - runnerUp.pairScore / best.pairScore : 1;
  const eventQuality   = sharpnessWeight(best.peak1.sharpness) + sharpnessWeight(best.cluster2.rep.sharpness);

  const primaryPass = best.pairScore >= HIGH_PAIR_SCORE_MIN &&
                      eventQuality   >= HIGH_EVENT_QUALITY_MIN &&
                      best.timingFactor >= HIGH_TIMING_MIN;
  const dominancePass = dominanceRatio >= HIGH_DOMINANCE_MIN;
  const overridePass  = best.pairScore >= HIGH_PAIR_SCORE_OVERRIDE;

  if (primaryPass && (dominancePass || overridePass)) {
    return { confidence: "high", reason: "dominant pair, strong signal", dominanceRatio, eventQuality };
  }

  const nearHighPass = best.pairScore    >= NEAR_HIGH_PAIR_SCORE_MIN &&
                       eventQuality      >= NEAR_HIGH_EVENT_QUALITY_MIN &&
                       best.timingFactor >= NEAR_HIGH_TIMING_MIN;
  if (nearHighPass) {
    return { confidence: "near_high", reason: "strong signal, approaching HIGH threshold", dominanceRatio, eventQuality };
  }

  if (best.pairScore >= 0.18) {
    return { confidence: "medium", reason: "usable pair", dominanceRatio, eventQuality };
  }
  return { confidence: "low", reason: "weak or ambiguous best pair", dominanceRatio, eventQuality };
}

// ─── Speed estimation ──────────────────────────────────────────────────────────

function calculateBreakSpeed(deltaSeconds, distanceFt) {
  return (distanceFt / deltaSeconds) * (3600 / 5280);
}

function getDirectEstimate(bestPair, distanceFt) {
  return { speedMph: calculateBreakSpeed(bestPair.deltaMs / 1000, distanceFt), mode: "direct", pairsUsed: 1 };
}

function getSmoothedEstimate(pairs, distanceFt) {
  const best  = pairs[0];
  const sameA = pairs
    .filter(p => p.peak1 === best.peak1 && p.deltaMs >= PAIR_PREF_MIN_MS && p.deltaMs <= PAIR_PREF_MAX_MS)
    .slice(0, 3);
  if (sameA.length < 2) return { ...getDirectEstimate(best, distanceFt), mode: "smoothed" };
  const totalWeight   = sameA.reduce((s, p) => s + p.pairScore, 0);
  const weightedSpeed = sameA.reduce((s, p) => s + calculateBreakSpeed(p.deltaMs / 1000, distanceFt) * p.pairScore, 0) / totalWeight;
  return { speedMph: weightedSpeed, mode: "smoothed", pairsUsed: sameA.length };
}

function getFallbackEstimate(pairs, distanceFt) {
  let candidates = pairs.filter(p => p.pairScore >= 0.35).slice(0, 5);
  if (candidates.length === 0) candidates = pairs.slice(0, Math.min(3, pairs.length));
  const totalWeight   = candidates.reduce((s, p) => s + p.pairScore, 0);
  const weightedSpeed = candidates.reduce((s, p) => s + calculateBreakSpeed(p.deltaMs / 1000, distanceFt) * p.pairScore, 0) / totalWeight;
  return { speedMph: weightedSpeed, mode: "fallback", pairsUsed: candidates.length };
}

function applySanityBounds(speedMph, confidence, pairs) {
  if (speedMph == null) return { speedMph: null, confidence, speedFlag: "no_pairs", speedNote: null };
  let finalConf = confidence, speedFlag = null, speedNote = null;
  if (speedMph < SPEED_MIN_REALISTIC_MPH) {
    speedFlag = "below_range";
    speedNote = `below typical range (${SPEED_MIN_REALISTIC_MPH}–${SPEED_MAX_REALISTIC_MPH} mph) — possible mis-detection`;
    finalConf = CONF_DOWN[confidence] || "very_low";
  } else if (speedMph > SPEED_MAX_REALISTIC_MPH) {
    speedFlag = "above_range";
    speedNote = `above typical range (${SPEED_MIN_REALISTIC_MPH}–${SPEED_MAX_REALISTIC_MPH} mph) — possible mis-detection`;
    finalConf = CONF_DOWN[confidence] || "very_low";
  } else if (pairs.length > 0 && pairs[0].deltaMs > PAIR_PREF_MAX_MS * 1.3) {
    speedFlag = "long_delta";
    speedNote = `best pair delta (${pairs[0].deltaMs.toFixed(0)} ms) exceeds preferred window — possible wrong cluster`;
    finalConf = CONF_DOWN[confidence] || "very_low";
  }
  return { speedMph, confidence: finalConf, speedFlag, speedNote };
}

function computeFileSpeed(pairs, confidence, distanceFt) {
  if (pairs.length === 0) return null;
  const best = pairs[0];
  if (confidence === "low" && best.pairScore < 0.30) return null;

  let estimate;
  if (confidence === "high" || confidence === "near_high") estimate = getDirectEstimate(best, distanceFt);
  else if (confidence === "medium")                        estimate = getSmoothedEstimate(pairs, distanceFt);
  else                                                     estimate = getFallbackEstimate(pairs, distanceFt);

  const sanity = applySanityBounds(estimate.speedMph, confidence, pairs);
  if (sanity.confidence === "very_low" && sanity.speedMph != null && sanity.speedMph < SPEED_SUPPRESS_BELOW_MPH) {
    return { ...estimate, ...sanity, speedMph: null };
  }
  return { ...estimate, ...sanity };
}

// ─── Session statistics ────────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function applyOutlierFlags(results) {
  const valid = results.map((r, i) => ({ i, s: r.speedMph }))
    .filter(x => x.s != null && !results[x.i].speedFlag);
  if (valid.length < 3) return;
  const med = median(valid.map(x => x.s));
  for (const { i, s } of valid) {
    if (Math.abs(s - med) > OUTLIER_MEDIAN_THRESHOLD_MPH) {
      const r = results[i];
      r.speedFlag  = "outlier";
      r.speedNote  = `session outlier — ${s.toFixed(1)} mph deviates >${OUTLIER_MEDIAN_THRESHOLD_MPH} mph from session median (${med.toFixed(1)} mph)`;
      r.confidence = CONF_DOWN[r.confidence] || "very_low";
    }
  }
}

function computeSessionStats(results) {
  const valid    = results.filter(r => r.speedMph != null);
  const flagged  = valid.filter(r => r.speedFlag);
  const rankable = valid.filter(r =>
    !r.speedFlag && (r.confidence === "high" || r.confidence === "near_high" || r.confidence === "medium"));
  const highConf    = rankable.filter(r => r.confidence === "high");
  const nearHighConf = rankable.filter(r => r.confidence === "near_high");
  const medConf     = rankable.filter(r => r.confidence === "medium");

  let sessionAvg = null, sessionAvgLabel = null, sessionAvgCount = 0;
  if (highConf.length >= 2) {
    sessionAvg      = highConf.reduce((s, r) => s + r.speedMph, 0) / highConf.length;
    sessionAvgLabel = "Session avg"; sessionAvgCount = highConf.length;
  } else if (rankable.length >= 1) {
    sessionAvg      = rankable.reduce((s, r) => s + r.speedMph, 0) / rankable.length;
    sessionAvgLabel = "Session avg (estimated)"; sessionAvgCount = rankable.length;
  }

  const bestHigh = highConf.reduce((b, r) => r.speedMph > (b?.speedMph ?? -Infinity) ? r : b, null);
  const topCandidates = highConf.length === 0 ? [...nearHighConf, ...medConf] : [];
  const bestMed  = topCandidates.reduce((b, r) => r.speedMph > (b?.speedMph ?? -Infinity) ? r : b, null) || null;

  return {
    sessionAvg, sessionAvgLabel, sessionAvgCount,
    highConfCount: highConf.length, nearHighConfCount: nearHighConf.length,
    medConfCount: medConf.length, validCount: valid.length,
    flaggedCount: flagged.length, rankableCount: rankable.length,
    bestHigh, bestMed,
  };
}

function computeConsistencyIndex(results) {
  const speeds = results.filter(r => r.speedMph != null && !r.speedFlag &&
    (r.confidence === "high" || r.confidence === "near_high" || r.confidence === "medium"))
    .map(r => r.speedMph);
  if (speeds.length < 2) return { stdDev: null, label: null, n: speeds.length };
  const mean   = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const stdDev = Math.sqrt(speeds.reduce((a, s) => a + (s - mean) ** 2, 0) / speeds.length);
  const label  = stdDev < 1.5 ? "Consistent" : stdDev < 3.0 ? "Variable" : "Inconsistent";
  return { stdDev, label, n: speeds.length };
}

function generateInterpretation(stats, ci, results) {
  const h = stats.highConfCount, nh = stats.nearHighConfCount, m = stats.medConfCount;
  const rankSpeeds = results.filter(r => r.speedMph != null && !r.speedFlag &&
    (r.confidence === "high" || r.confidence === "near_high" || r.confidence === "medium"))
    .map(r => r.speedMph);
  const spMin = rankSpeeds.length ? Math.min(...rankSpeeds).toFixed(0) : null;
  const spMax = rankSpeeds.length ? Math.max(...rankSpeeds).toFixed(0) : null;
  const rangeNote = spMin && spMax && spMin !== spMax ? `  Speeds ranged ${spMin}–${spMax} mph.` : "";

  if (h >= 2) return ci.label === "Consistent"
    ? `Multiple strong breaks with consistent output — great session.${rangeNote}`
    : `Multiple strong breaks this session.${rangeNote}  Keep working on consistency.`;
  if (h === 1 && nh >= 2) return `One clearly strong break and several close reads.${rangeNote}  You're close to consistent HIGH output.`;
  if (h === 1) return `One clearly strong break this session.${rangeNote}  Work on repeating that contact quality.`;
  if (nh >= 3) return `Several near-strong reads — not quite HIGH, but signals are clean.${rangeNote}  Focus on cleaner cue contact at impact.`;
  if (nh >= 1) return ci.label === "Consistent"
    ? `Readings are near-strong and consistent.${rangeNote}  A cleaner rack contact should unlock HIGH.`
    : `Near-strong signals present.${rangeNote}  Retest for a cleaner rack response.`;
  if (m >= 2) return `Readings were usable but not strong.${rangeNote}  Retest with more deliberate contact for cleaner signal.`;
  if (m === 1) return `One usable reading this session.${rangeNote}  More breaks needed for a reliable picture.`;
  return "Readings were weak or ambiguous.  Check audio recording quality and retry.";
}

// ─── Distance calculation ──────────────────────────────────────────────────────

const TABLE_DIMS_IN = { "7ft": [77, 38.5], "8ft": [88, 44], "9ft": [100, 50] };

export function computeDistanceFt(tableMode, tableSize, customLengthIn, customWidthIn, breakPosition) {
  let lengthIn, widthIn;
  if (tableMode === "custom" && customLengthIn > 0 && customWidthIn > 0) {
    lengthIn = Math.max(70, Math.min(130, customLengthIn));
    widthIn  = Math.max(35, Math.min(70,  customWidthIn));
  } else {
    [lengthIn, widthIn] = TABLE_DIMS_IN[tableSize] ?? TABLE_DIMS_IN["9ft"];
  }
  const straightIn = lengthIn / 2;
  const fracMap = {
    "center": 0, "slight-left": widthIn / 8, "left": widthIn / 4,
    "slight-right": widthIn / 8, "right": widthIn / 4,
  };
  const offsetIn = fracMap[breakPosition] ?? 0;
  return Math.sqrt(straightIn ** 2 + offsetIn ** 2) / 12;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze one or more audio files in the browser.
 * Returns the same JSON shape as the server-side breakAnalyzer --json mode.
 *
 * @param {File[]}  files
 * @param {number}  distanceFt  cue-ball travel distance in feet
 * @returns {Promise<{ files: object[], session: object }>}
 */
export async function analyzeFiles(files, distanceFt = 4.2) {
  const fileResults  = [];
  const skippedFiles = [];

  for (const file of files) {
    let mono, sampleRate;
    try {
      ({ mono, sampleRate } = await decodeAudioFile(file));
    } catch (err) {
      skippedFiles.push({ filename: file.name, format: file.name.split(".").pop().toUpperCase(), error: err.message });
      continue;
    }

    try {
      const { filtered, envelope } = preprocessSignal(mono, sampleRate);
      const peakIdxs = detectWavPeaks(envelope, sampleRate);
      const scored   = peakIdxs.map(i => scoreWavPeak(i, envelope, filtered, sampleRate));
      const pairs    = generateClusterPairs(scored);
      const { confidence: rawConf, dominanceRatio, eventQuality } = assignConfidence(pairs);
      const speed    = computeFileSpeed(pairs, rawConf, distanceFt);

      fileResults.push({
        filename:       file.name,
        format:         file.name.split(".").pop().toUpperCase(),
        totalDuration:  mono.length / sampleRate,
        confidence:     speed?.confidence ?? rawConf,
        speedMph:       speed?.speedMph   ?? null,
        speedMode:      speed?.mode       ?? null,
        speedFlag:      speed?.speedFlag  ?? null,
        speedNote:      speed?.speedNote  ?? null,
        sessionRank:    null,
        dominanceRatio: dominanceRatio ?? null,
        eventQuality:   eventQuality   ?? null,
        pairScore:      pairs[0]?.pairScore    ?? null,
        timingFactor:   pairs[0]?.timingFactor ?? null,
        error:          null,
      });
    } catch (err) {
      skippedFiles.push({ filename: file.name, format: file.name.split(".").pop().toUpperCase(), error: err.message });
    }
  }

  // Session-level analysis
  applyOutlierFlags(fileResults);
  const sessionStats = computeSessionStats(fileResults);

  if (sessionStats.bestHigh) sessionStats.bestHigh.sessionRank = "best";
  else if (sessionStats.bestMed) sessionStats.bestMed.sessionRank = "top_estimate";

  const ci             = computeConsistencyIndex(fileResults);
  const interpretation = generateInterpretation(sessionStats, ci, fileResults);

  const allFiles = [
    ...fileResults,
    ...skippedFiles.map(r => ({
      filename: r.filename, format: r.format, totalDuration: null,
      confidence: "error", speedMph: null, speedMode: null, speedFlag: null,
      speedNote: null, sessionRank: null, dominanceRatio: null, eventQuality: null,
      pairScore: null, timingFactor: null, error: r.error,
    })),
  ];

  return {
    files: allFiles,
    session: {
      highConfCount:     sessionStats.highConfCount,
      nearHighConfCount: sessionStats.nearHighConfCount,
      medConfCount:      sessionStats.medConfCount,
      rankableCount:     sessionStats.rankableCount,
      validCount:        sessionStats.validCount,
      flaggedCount:      sessionStats.flaggedCount,
      sessionAvg:        sessionStats.sessionAvg,
      sessionAvgLabel:   sessionStats.sessionAvgLabel,
      sessionAvgCount:   sessionStats.sessionAvgCount,
      bestBreak: sessionStats.bestHigh
        ? { filename: sessionStats.bestHigh.filename, speedMph: sessionStats.bestHigh.speedMph, confidence: sessionStats.bestHigh.confidence }
        : null,
      topEstimate: sessionStats.bestMed
        ? { filename: sessionStats.bestMed.filename, speedMph: sessionStats.bestMed.speedMph, confidence: sessionStats.bestMed.confidence }
        : null,
      consistency: { label: ci.label, stdDev: ci.stdDev, n: ci.n },
      interpretation,
    },
  };
}
