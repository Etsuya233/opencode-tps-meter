/**
 * Throughput measurement for one session.
 *
 * Everything here is free of Solid, OpenTUI and OpenCode imports so it can be
 * unit tested with `node --test` alone. `src/tui.tsx` only routes host events
 * into these calls and renders what comes back.
 *
 * What has to be measured
 * -----------------------
 * OpenCode publishes no token count while a step streams. `session.usage.updated`
 * is cumulative for the whole session and is only emitted once a step settles,
 * and the AI layer folds provider usage into a single `step-finish` payload
 * rather than emitting it per chunk. So during generation the only signal
 * available is the text itself, and a rate has to be estimated from it.
 *
 * How the estimate stays honest
 * -----------------------------
 * Each step produces one closed comparison: the characters we counted against
 * the provider's authoritative `tokens.output + tokens.reasoning`. That ratio is
 * folded into a per-model factor, so the second turn on a model already reads far
 * closer to the truth than the fixed characters-per-token guess it started from.
 * Nothing here re-tokenizes, and nothing is guessed twice.
 *
 * Counts and spans, never a rate
 * ------------------------------
 * A rate is a count over a span. This module hands back the count and the span
 * separately and never divides one by the other, because a family of sessions
 * has to divide *one combined count* by *one shared span*. Dividing each member
 * by its own span and adding the results describes a different window per member
 * — a number that no longer matches the rows shown beneath it.
 *
 * Why a quiet window reads zero
 * -----------------------------
 * A window is a pure function of the instant it is asked at. Once no token has
 * arrived for a whole window it holds nothing and reads zero, which is what keeps
 * a blocked agent out of a family total instead of letting it hold the rate it
 * had before it blocked.
 */

/** Characters per token assumed before any model has been calibrated. */
export const BASE_CHARS_PER_TOKEN = 4;

/** Token counts a model must report before its sample is trusted. */
const MIN_CALIBRATION_TOKENS = 8;

/** Samples outside this band are noise (a truncated step, a retried request). */
const MIN_CALIBRATION_FACTOR = 0.25;
const MAX_CALIBRATION_FACTOR = 4;

/** Weight of a new calibration sample against the running factor. */
const CALIBRATION_ALPHA = 0.3;

/** Characters per stream before a step may calibrate; keeps a stray word out. */
const MIN_CALIBRATION_CHARS = MIN_CALIBRATION_TOKENS * BASE_CHARS_PER_TOKEN;
const DEFAULT_WINDOW = {
  windowMs: 1000,
  halfLifeMs: 120,
  minDurationMs: 300,
  initialCap: 100,
  capacity: 512
};
function resolveWindow(options) {
  const input = options ?? {};
  const positive = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    windowMs: positive(input.windowMs, DEFAULT_WINDOW.windowMs),
    halfLifeMs: positive(input.halfLifeMs, DEFAULT_WINDOW.halfLifeMs),
    minDurationMs: positive(input.minDurationMs, DEFAULT_WINDOW.minDurationMs),
    initialCap: positive(input.initialCap, DEFAULT_WINDOW.initialCap),
    capacity: Math.max(8, Math.round(positive(input.capacity, DEFAULT_WINDOW.capacity)))
  };
}

/** What a window holds as of one instant. */

/**
 * A rolling token count over a fixed time window.
 *
 * Records are assumed to arrive in non-decreasing time order and are clamped if
 * they do not, because pruning scans from the front: an out-of-order timestamp
 * would leave expired samples stranded behind a live one.
 */

export function createRateWindow(options) {
  const {
    windowMs,
    halfLifeMs,
    minDurationMs,
    initialCap,
    capacity
  } = resolveWindow(options);
  const samples = [];
  let smoothed = 0;
  let smoothedAt;
  let seeded = false;
  function prune(now) {
    const cutoff = now - windowMs;
    let drop = 0;
    while (drop < samples.length && samples[drop].at < cutoff) drop++;
    if (drop > 0) samples.splice(0, drop);
    if (samples.length > capacity) samples.splice(0, samples.length - capacity);
  }
  function smooth(raw, spanMs, at) {
    if (!seeded) {
      // A first sample has no history to smooth against, so cap it at
      // `initialCap` tokens per second over the span it covers. One opening
      // chunk cannot then define the reading on its own.
      smoothed = Math.min(raw, initialCap * spanMs / 1000);
      smoothedAt = at;
      seeded = true;
      return smoothed;
    }
    const previous = smoothedAt ?? at;
    // Weight of the PREVIOUS value, so elapsed time relaxes the smoothing toward
    // the raw count rather than away from it. A window that has gone quiet must
    // converge on zero, and the raw count of an empty window is zero — that is
    // what stops a blocked agent contributing to a family total.
    const carry = Math.exp(-Math.LN2 * Math.max(0, at - previous) / halfLifeMs);
    smoothed = carry * smoothed + (1 - carry) * raw;
    smoothedAt = at;
    return smoothed;
  }
  return {
    record(at, tokens) {
      if (!(tokens > 0) || !Number.isFinite(at)) return;
      const last = samples.length > 0 ? samples[samples.length - 1].at : undefined;
      const when = last !== undefined && at < last ? last : at;
      samples.push({
        at: when,
        tokens
      });
      prune(when);
    },
    read(at) {
      const cutoff = at - windowMs;
      let tokens = 0;
      let oldest;
      for (const sample of samples) {
        if (sample.at < cutoff) continue;
        tokens += sample.tokens;
        if (oldest === undefined || sample.at < oldest) oldest = sample.at;
      }
      if (tokens <= 0 || oldest === undefined) {
        // Nothing is inside the window, so there is no reading left to smooth.
        // Returning zero outright also avoids leaving a denormal tail that would
        // render as "0.0" but never compare equal to 0.
        smoothed = 0;
        smoothedAt = at;
        seeded = false;
        return {
          tokens: 0,
          spanMs: 0,
          flowing: false
        };
      }
      const spanMs = Math.max(minDurationMs, at - oldest);
      return {
        tokens: smooth(tokens, spanMs, at),
        spanMs,
        flowing: true
      };
    },
    reset() {
      samples.length = 0;
      smoothed = 0;
      smoothedAt = undefined;
      seeded = false;
    }
  };
}

/**
 * Per-model correction learned from provider-reported token counts.
 *
 * Stored by model key so the same session switching between a fast and a slow
 * model does not average two different ratios into one useless number. The store
 * outlives any session, which is the point: the second conversation on a model
 * starts from what the first one learned.
 */

export function createCalibration() {
  const learned = new Map();
  return {
    observe(modelKey, chars, actualTokens) {
      if (!modelKey) return;
      if (!(actualTokens > 0) || chars < MIN_CALIBRATION_CHARS) return;
      const sample = actualTokens / (chars / BASE_CHARS_PER_TOKEN);
      if (!Number.isFinite(sample)) return;
      if (sample < MIN_CALIBRATION_FACTOR || sample > MAX_CALIBRATION_FACTOR) return;
      const existing = learned.get(modelKey);
      if (!existing) {
        learned.set(modelKey, {
          factor: sample,
          samples: 1
        });
        return;
      }
      learned.set(modelKey, {
        factor: existing.factor * (1 - CALIBRATION_ALPHA) + sample * CALIBRATION_ALPHA,
        samples: existing.samples + 1
      });
    },
    factor: modelKey => learned.get(modelKey)?.factor ?? 1,
    tokensPerChar: modelKey => (learned.get(modelKey)?.factor ?? 1) / BASE_CHARS_PER_TOKEN,
    samples: modelKey => learned.get(modelKey)?.samples ?? 0,
    forget: () => learned.clear()
  };
}

/**
 * A text stream's token estimate.
 *
 * `floor(chars / charsPerToken)` is exactly additive across chunk boundaries, so
 * a response split into any number of chunks counts the same as one whole string.
 * The fractional part is banked rather than discarded, which is also what lets a
 * calibrated factor change mid-stream without losing the remainder.
 */

export function createStreamCounter() {
  let credit = 0;
  return {
    add(text, tokensPerChar) {
      if (!text) return 0;
      credit += text.length * tokensPerChar;
      const whole = Math.floor(credit);
      if (whole <= 0) return 0;
      credit -= whole;
      return whole;
    }
  };
}

/** What one session is currently doing, as far as throughput is concerned. */

/** A step that has settled, with everything a calibration sample needs. */

export const DEFAULT_MODEL_KEY = "default";
export function createSessionRate(sessionID, options) {
  const window = createRateWindow(options);
  const stream = createStreamCounter();
  let modelKey = DEFAULT_MODEL_KEY;
  let stepChars = 0;
  return {
    sessionID,
    get modelKey() {
      return modelKey;
    },
    beginStep(key) {
      modelKey = key || modelKey || DEFAULT_MODEL_KEY;
      // A step is the unit a calibration sample is taken from, so the character
      // count starts over even when the turn continues.
      stepChars = 0;
    },
    absorb(text, tokensPerChar, at) {
      stepChars += text.length;
      const added = stream.add(text, tokensPerChar);
      if (added > 0) window.record(at, added);
    },
    endStep(input) {
      const sample = {
        sessionID,
        modelKey,
        tokens: (input.output ?? 0) + (input.reasoning ?? 0),
        chars: stepChars
      };
      stepChars = 0;
      return sample;
    },
    reading(at) {
      const live = window.read(at);
      return {
        sessionID,
        tokens: live.tokens,
        spanMs: live.spanMs,
        flowing: live.flowing,
        modelKey
      };
    }
  };
}

/** A token count over a span, in tokens per second. */
export function perSecond(tokens, spanMs) {
  return spanMs > 0 ? tokens / spanMs * 1000 : 0;
}

/** One decimal is the right precision for a rate: 42.1, not 42.13 or 42. */
export function formatRate(value) {
  if (!Number.isFinite(value) || value <= 0) return "0.0";
  return value.toFixed(1);
}
