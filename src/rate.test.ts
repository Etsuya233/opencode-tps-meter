/**
 * Tests for the throughput math.
 *
 * Every timestamp here is an explicit number, never a clock read, so a rate is
 * an exact expected value rather than a range. That matters: the whole point of
 * the module is arithmetic on a timeline, and a test that leans on `Date.now()`
 * could only ever assert "roughly right".
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BASE_CHARS_PER_TOKEN,
  createCalibration,
  createRateWindow,
  createSessionRate,
  createStreamCounter,
  formatRate,
  perSecond,
  type WindowOptions,
} from "./rate.ts"

/** The opening cap is a display guard, not arithmetic, so it is lifted here. */
const NO_CAP: WindowOptions = { windowMs: 1000, initialCap: 1_000_000 }

/** Records `count` samples of 10 tokens, `gap` ms apart, from `start`. */
function sample(record: (at: number, tokens: number) => void, start: number, gap: number, count: number) {
  for (let index = 0; index < count; index++) record(start + index * gap, 10)
}

test("a window reports a count and the span it covers", () => {
  const window = createRateWindow(NO_CAP)
  // 10 tokens every 100ms. Read one full window after the first sample, the span
  // is exactly 1000ms and the 100 tokens in it are exactly 100/second.
  sample((at, tokens) => window.record(at, tokens), 0, 100, 10)

  const reading = window.read(1000)
  assert.equal(reading.tokens, 100)
  assert.equal(reading.spanMs, 1000)
  assert.equal(perSecond(reading.tokens, reading.spanMs), 100)
})

test("the span runs to now, so a pause lowers the rate", () => {
  const window = createRateWindow(NO_CAP)
  sample((at, tokens) => window.record(at, tokens), 0, 100, 5)

  // 50 tokens over the 400ms they arrived in.
  const live = window.read(400)
  assert.equal(perSecond(live.tokens, live.spanMs), 125)

  // Reading later widens the span over the same samples rather than holding the
  // old one. The span is not smoothed, so it can be asserted exactly.
  assert.equal(window.read(700).spanMs, 700)
  assert.equal(window.read(1400).spanMs, 1000)

  // And the count has relaxed onto the single sample still inside the window, so
  // the reading has fallen from 125 to about 10 rather than holding its old value.
  const late = window.read(1400)
  assert.ok(perSecond(late.tokens, late.spanMs) < 11, `expected the burst to have aged out, got ${late.tokens}`)
})

test("the first token cannot report a rate in the thousands", () => {
  const window = createRateWindow({ windowMs: 1000, minDurationMs: 300 })
  window.record(1000, 5000)

  // 5000 tokens over the 300ms floor is capped at `initialCap` per second,
  // rather than letting one opening chunk define the reading.
  const reading = window.read(1000)
  assert.equal(perSecond(reading.tokens, reading.spanMs), 100)
})

test("a small opening chunk is not distorted by the cap", () => {
  const window = createRateWindow({ windowMs: 1000, minDurationMs: 300 })
  window.record(1000, 5)

  // 5 tokens over the 300ms floor, not over the 0ms that actually elapsed.
  const reading = window.read(1000)
  assert.equal(reading.tokens, 5)
  assert.equal(perSecond(reading.tokens, reading.spanMs), (5 / 300) * 1000)
})

test("reading one instant twice does not advance the smoothing twice", () => {
  const window = createRateWindow(NO_CAP)
  window.record(0, 10)

  assert.deepEqual(window.read(0), window.read(0))
})

test("a window that goes quiet empties out instead of holding its last value", () => {
  const window = createRateWindow(NO_CAP)
  sample((at, tokens) => window.record(at, tokens), 0, 100, 10)
  const live = window.read(900)
  assert.ok(live.tokens > 50, `expected a live count, got ${live.tokens}`)

  // A blocked agent must read nothing: a family total that kept this count would
  // go on counting tokens nobody produced.
  const afterToolCall = window.read(900 + 60_000)
  assert.equal(afterToolCall.tokens, 0)
  assert.equal(afterToolCall.spanMs, 0)
  assert.equal(afterToolCall.flowing, false)
})

test("flowing reports whether a token arrived inside the window", () => {
  const window = createRateWindow(NO_CAP)
  window.record(1000, 5)

  assert.equal(window.read(1500).flowing, true)
  assert.equal(window.read(3000).flowing, false)
})

test("an out-of-order timestamp is clamped rather than corrupting the window", () => {
  const window = createRateWindow(NO_CAP)
  window.record(2000, 10)
  window.record(1000, 10)

  // Pruning scans from the front, so a backwards timestamp would otherwise
  // strand an expired sample behind a live one. Both counts are kept, and the
  // clamped one lands on the same instant.
  const reading = window.read(2000)
  assert.equal(reading.tokens, 20)
  // 20 tokens at a single instant, so the span falls to its floor rather than
  // dividing by zero.
  assert.equal(reading.spanMs, 300)
})

test("non-positive token counts are ignored", () => {
  const window = createRateWindow(NO_CAP)
  window.record(1000, 0)
  window.record(1000, -5)

  assert.equal(window.read(1000).tokens, 0)
})

test("a stream counts the same however it is chunked", () => {
  const perChar = 1 / BASE_CHARS_PER_TOKEN
  const whole = createStreamCounter()
  const split = createStreamCounter()

  const counted = whole.add("a".repeat(400), perChar)
  assert.equal(counted, 100)

  // The same 400 characters in arbitrary pieces, several of which would floor
  // to zero on their own if the remainder were discarded each time.
  let splitCounted = 0
  for (const piece of ["a", "a", "aa", "aaaa", "a".repeat(392)]) {
    splitCounted += split.add(piece, perChar)
  }

  assert.equal(splitCounted, counted)
})

test("a token split across chunk boundaries is not lost", () => {
  const counter = createStreamCounter()
  const perChar = 1 / BASE_CHARS_PER_TOKEN

  // Eight single characters, each a quarter of a token. Flooring each one would
  // report nothing at all.
  let added = 0
  for (let index = 0; index < 8; index++) added += counter.add("a", perChar)
  assert.equal(added, 2)
})

test("calibration starts at the base ratio and has no samples", () => {
  const calibration = createCalibration()

  assert.equal(calibration.factor("anthropic/claude"), 1)
  assert.equal(calibration.tokensPerChar("anthropic/claude"), 1 / BASE_CHARS_PER_TOKEN)
  assert.equal(calibration.samples("anthropic/claude"), 0)
})

test("a step teaches its model the ratio the provider reported", () => {
  const calibration = createCalibration()
  // 800 characters counted as 200 tokens, but the provider says 300.
  calibration.observe("anthropic/claude", 800, 300)

  assert.equal(calibration.samples("anthropic/claude"), 1)
  assert.ok(Math.abs(calibration.factor("anthropic/claude") - 1.5) < 1e-9)
  assert.ok(Math.abs(calibration.tokensPerChar("anthropic/claude") - 1.5 / BASE_CHARS_PER_TOKEN) < 1e-9)
})

test("calibration is per model, so a slow model does not drag a fast one down", () => {
  const calibration = createCalibration()
  calibration.observe("fast/model", 800, 200)
  calibration.observe("slow/model", 800, 50)

  assert.equal(calibration.samples("fast/model"), 1)
  assert.equal(calibration.samples("slow/model"), 1)
  assert.ok(calibration.factor("fast/model") > calibration.factor("slow/model"))
})

test("calibration ignores samples too small or too far out of range to trust", () => {
  const calibration = createCalibration()

  // A handful of characters says nothing about a model's ratio.
  calibration.observe("m", 20, 6)
  assert.equal(calibration.samples("m"), 0)

  // A truncated or retried step can report a wild ratio.
  calibration.observe("m", 800, 8000)
  assert.equal(calibration.samples("m"), 0)

  calibration.observe("m", 800, 0)
  assert.equal(calibration.samples("m"), 0)
})

test("successive samples converge on the model rather than jumping to each", () => {
  const calibration = createCalibration()
  for (let index = 0; index < 20; index++) calibration.observe("m", 800, 300)

  assert.equal(calibration.samples("m"), 20)
  // Alpha 0.3 over 20 identical samples leaves the original fully amortised.
  assert.ok(Math.abs(calibration.factor("m") - 1.5) < 1e-6)
})

test("a session with nothing to report reads as empty rather than undefined", () => {
  const reading = createSessionRate("ses_empty", NO_CAP).reading(0)

  assert.equal(reading.tokens, 0)
  assert.equal(reading.spanMs, 0)
  assert.equal(reading.flowing, false)
  assert.equal(reading.modelKey, "default")
})

test("a session accumulates a count and the span it covers", () => {
  const rate = createSessionRate("ses_1", NO_CAP)
  const perChar = 1 / BASE_CHARS_PER_TOKEN

  rate.beginStep("anthropic/claude")
  assert.equal(rate.modelKey, "anthropic/claude")
  // Ten chunks of 40 characters is 100 tokens, over the 900ms they arrived in.
  for (let index = 0; index < 10; index++) rate.absorb("x".repeat(40), perChar, index * 100)

  const reading = rate.reading(900)
  assert.equal(reading.modelKey, "anthropic/claude")
  assert.equal(reading.flowing, true)
  assert.equal(reading.tokens, 100)
  assert.equal(perSecond(reading.tokens, reading.spanMs), (100 / 900) * 1000)
})

test("a partial token is banked rather than recorded early", () => {
  const rate = createSessionRate("ses_1", NO_CAP)

  rate.beginStep("m")
  // Two characters is half a token at the base ratio, so nothing is recorded yet.
  rate.absorb("xx", 1 / BASE_CHARS_PER_TOKEN, 0)
  assert.equal(rate.reading(0).tokens, 0)
  assert.equal(rate.reading(0).flowing, false)

  // The other half completes it.
  rate.absorb("xx", 1 / BASE_CHARS_PER_TOKEN, 100)
  assert.equal(rate.reading(100).tokens, 1)
})

test("a model keeps its factor when a turn switches models", () => {
  const rate = createSessionRate("ses_1", NO_CAP)

  rate.beginStep("")
  assert.equal(rate.modelKey, "default", "an absent model does not erase the last one")
  rate.beginStep("anthropic/claude")
  assert.equal(rate.modelKey, "anthropic/claude")
})

test("a settled step reports the provider count beside the characters it took", () => {
  const rate = createSessionRate("ses_1", NO_CAP)
  const perChar = 1 / BASE_CHARS_PER_TOKEN

  rate.beginStep("anthropic/claude")
  rate.absorb("x".repeat(400), perChar, 0)

  const sample = rate.endStep({ output: 137, reasoning: 8 })
  assert.equal(sample.tokens, 145)
  assert.equal(sample.chars, 400)
  assert.equal(sample.modelKey, "anthropic/claude")
})

test("a settled step with no provider count reports zero rather than guessing", () => {
  // The estimate is already in the window. Substituting it here would teach the
  // calibration loop its own guess, which is a fixed point that learns nothing.
  const rate = createSessionRate("ses_1", NO_CAP)

  rate.beginStep("m")
  rate.absorb("x".repeat(400), 1 / BASE_CHARS_PER_TOKEN, 0)

  assert.equal(rate.endStep({}).tokens, 0)
})

test("the character count restarts per step so a calibration sample is one step", () => {
  const rate = createSessionRate("ses_1", NO_CAP)
  const perChar = 1 / BASE_CHARS_PER_TOKEN

  rate.beginStep("m")
  rate.absorb("x".repeat(400), perChar, 0)
  rate.beginStep("m")
  rate.absorb("x".repeat(100), perChar, 100)

  assert.equal(rate.endStep({}).chars, 100)
})

test("the stream credit carries across a step boundary, so no token is lost", () => {
  const rate = createSessionRate("ses_1", NO_CAP)
  const perChar = 1 / BASE_CHARS_PER_TOKEN

  rate.beginStep("m")
  rate.absorb("xx", perChar, 0)
  rate.beginStep("m")
  rate.absorb("xx", perChar, 100)

  // Half a token on either side of the boundary is one token, not two zeros.
  assert.equal(rate.reading(100).tokens, 1)
})

test("rates keep one decimal", () => {
  assert.equal(formatRate(0), "0.0")
  assert.equal(formatRate(42.13), "42.1")
})
