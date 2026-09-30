/**
 * Tests for event routing and family aggregation.
 *
 * Events are built to the shape the host actually sends, copied from the event
 * manifest in `@opencode/schema` and the client's generated types. That is not
 * pedantry: an earlier revision of this plugin read `output` and `reasoning` at
 * the top level of `session.step.ended`, where they do not exist, and a fixture
 * that agreed with it kept the whole suite green while the provider's token
 * count was never read at all. A fixture that mirrors the wire format is the
 * only thing that catches that class of mistake.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { createMeter, type Aggregate, type Meter, type MeterOptions } from "./meter.ts"

/**
 * Base timestamp for fixtures: the local clock, captured once.
 *
 * The meter rejects a `created` more than a day away from the local clock as
 * skewed, which is right in production — a remote server's clock is exactly what
 * that guards against — but it means fixtures cannot start at zero or at any
 * fixed literal. Offsets below are added to this, so the arithmetic in each test
 * stays readable as "0", "500ms later" and so on.
 */
const EPOCH = Date.now()

/** A meter with the throttle off and the opening cap lifted. */
function meter(options: Partial<MeterOptions> = {}): Meter {
  return createMeter({ windowMs: 1000, updateIntervalMs: 0, initialCap: 1_000_000, ...options })
}

/**
 * A meter whose clock the test moves by hand.
 *
 * A reading projects local elapsed time onto the host timeline, so with a live
 * clock every expected rate would be a millisecond out of reach. Letting the
 * test own the clock keeps those assertions exact instead of approximate.
 */
function clocked(options: Partial<MeterOptions> = {}) {
  let current = Date.now()
  const m = meter({ ...options, now: () => current })
  return { m, advance: (ms: number) => void (current += ms) }
}

/** A step-started event, in the shape the host sends. */
function stepStart(sessionID: string, at: number, model = "anthropic/claude-sonnet-4") {
  const [providerID, id] = model.split("/")
  return {
    type: "session.step.started",
    created: EPOCH + at,
    data: {
      sessionID,
      assistantMessageID: "msg_1",
      agent: "build",
      started: EPOCH + at,
      model: { providerID, id },
    },
  }
}

/**
 * A step-ended event, in the shape the host sends.
 *
 * The provider's usage lives under `data.tokens`, per `TokenUsageInfo` in the
 * client's generated types. Writing it flat would restate the bug this fixture
 * exists to catch.
 */
function stepEnd(
  sessionID: string,
  at: number,
  tokens: { output: number; reasoning?: number } | undefined,
  finish = "stop",
) {
  return {
    type: "session.step.ended",
    created: EPOCH + at,
    data: {
      sessionID,
      assistantMessageID: "msg_1",
      finish,
      cost: 0,
      tokens: {
        input: 10,
        output: tokens?.output ?? 0,
        reasoning: tokens?.reasoning ?? 0,
        cache: { read: 0, write: 0 },
      },
    },
  }
}

/** A streamed-content event, in the shape the host sends. */
function delta(sessionID: string, at: number, chars = 40, type = "session.text.delta") {
  return {
    type,
    created: EPOCH + at,
    data: { sessionID, assistantMessageID: "msg_1", ordinal: 0, delta: "x".repeat(chars) },
  }
}

/** Streams `count` chunks of 40 characters, `gap` ms apart, from `start`. */
function stream(m: Meter, sessionID: string, start: number, gap: number, count: number) {
  for (let index = 0; index < count; index++) m.handle(delta(sessionID, start + index * gap))
}

function feed(events: unknown[]): Meter {
  const m = meter()
  for (const event of events) m.handle(event)
  return m
}

function read(m: Meter, sessionID: string, family: string[] = []): Aggregate {
  return m.aggregate({
    sessionID,
    family,
    isRoot: (id) => id === sessionID,
    label: (id) => (id === sessionID ? "main" : id),
  })
}

test("a stream produces a count divided by the span it covers", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  stream(m, "ses_1", 0, 100, 10)

  const aggregate = read(m, "ses_1")
  assert.equal(aggregate.flowing, true)
  // Read at the last chunk: 100 tokens over the 900ms they arrived in.
  assert.equal(aggregate.rate, (100 / 900) * 1000)
})

test("reasoning deltas are output too, not a separate stream", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  stream(m, "ses_1", 0, 100, 5)
  for (let index = 0; index < 5; index++) {
    m.handle(delta("ses_1", 500 + index * 100, 40, "session.reasoning.delta"))
  }

  // Ten chunks of 40 characters, whichever kind, over the same 900ms.
  assert.equal(read(m, "ses_1").rate, (100 / 900) * 1000)
})

test("the provider's count teaches the model, so the next stream is closer", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  stream(m, "ses_1", 0, 100, 10)
  // 400 characters the base ratio prices at 100 tokens; the provider says 300.
  m.handle(stepEnd("ses_1", 1000, { output: 300 }))

  m.handle(stepStart("ses_1", 2000))
  stream(m, "ses_1", 2000, 100, 10)

  // Read at 2900. The window is the last second, so only the second stream is
  // inside it, and its 400 characters are now worth 300 tokens rather than 100.
  assert.equal(read(m, "ses_1").rate, (300 / 900) * 1000)
})

test("usage at the top level of a step-ended event teaches nothing", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  stream(m, "ses_1", 0, 100, 10)
  // The shape this plugin used to expect. It is not the shape the host sends, so
  // there is nothing to learn from it and the estimate must stay uncalibrated.
  m.handle({
    type: "session.step.ended",
    created: EPOCH + 1000,
    data: { sessionID: "ses_1", finish: "stop", output: 300, reasoning: 0, cost: 0 },
  })

  m.handle(stepStart("ses_1", 2000))
  stream(m, "ses_1", 2000, 100, 10)

  assert.equal(read(m, "ses_1").rate, (100 / 900) * 1000)
})

test("a failed step is not allowed to teach the model anything", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  stream(m, "ses_1", 0, 100, 10)
  m.handle(stepEnd("ses_1", 1000, { output: 300 }, "error"))

  m.handle(stepStart("ses_1", 2000))
  stream(m, "ses_1", 2000, 100, 10)

  assert.equal(read(m, "ses_1").rate, (100 / 900) * 1000)
})

test("a family divides one combined count by one shared span", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_main", 0))
  m.handle(stepStart("ses_sub", 500))
  stream(m, "ses_main", 0, 100, 10)
  stream(m, "ses_sub", 500, 100, 5)

  // Read at 900. The window is the last second, which covers both members, and
  // the span is the family's oldest live token: 900ms, not either member's own.
  const aggregate = read(m, "ses_main", ["ses_main", "ses_sub"])
  assert.equal(aggregate.rate, (150 / 900) * 1000)

  const root = aggregate.members.find((member) => member.isRoot)
  const sub = aggregate.members.find((member) => !member.isRoot)
  assert.equal(root?.rate, (100 / 900) * 1000)
  assert.equal(sub?.rate, (50 / 900) * 1000)
  // The rows add up to the number above them, which is the point of sharing one
  // denominator instead of letting each member divide by its own.
  assert.ok(Math.abs((root?.rate ?? 0) + (sub?.rate ?? 0) - aggregate.rate) < 1e-9)
})

test("a member whose output has left the window contributes nothing", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_main", 0))
  stream(m, "ses_main", 0, 100, 10)
  // The subagent only starts once the main agent has finished.
  m.handle(stepStart("ses_sub", 2000))
  stream(m, "ses_sub", 2000, 100, 5)

  const aggregate = read(m, "ses_main", ["ses_main", "ses_sub"])
  const root = aggregate.members.find((member) => member.isRoot)
  const sub = aggregate.members.find((member) => !member.isRoot)

  // Read at 2400: the main agent's tokens aged out of the window a second ago,
  // so it is not a second source of rate and not a wider second span either.
  assert.equal(root?.rate, 0)
  assert.equal(root?.flowing, false)
  assert.equal(aggregate.rate, (50 / 400) * 1000)
  assert.equal(sub?.rate, aggregate.rate)
})

test("a blocked member holds no rate over from before it blocked", () => {
  const { m, advance } = clocked()
  m.handle(stepStart("ses_main", 0))
  stream(m, "ses_main", 0, 100, 5)

  const live = read(m, "ses_main", ["ses_main"])
  assert.ok(live.rate > 0)

  // Whatever the main agent was waiting on, it produced nothing for a while.
  advance(10_000)
  const blocked = read(m, "ses_main", ["ses_main"])
  assert.equal(blocked.rate, 0)
  assert.equal(blocked.flowing, false)
})

test("a session outside the family cannot inflate it", () => {
  const m = feed([stepStart("ses_other", 0)])
  stream(m, "ses_other", 0, 100, 10)

  assert.equal(read(m, "ses_main", ["ses_main"]).rate, 0)
})

test("an unknown session still produces a renderable aggregate", () => {
  const aggregate = read(meter(), "ses_never_seen", ["ses_never_seen"])

  assert.equal(aggregate.rate, 0)
  assert.equal(aggregate.flowing, false)
  assert.equal(aggregate.members.length, 1)
  assert.equal(aggregate.members[0]?.sessionID, "ses_never_seen")
  assert.equal(aggregate.members[0]?.rate, 0)
  assert.equal(aggregate.members[0]?.flowing, false)
})

test("producing follows the window, so a surface knows when to stop repainting", () => {
  const { m, advance } = clocked()
  m.handle(stepStart("ses_1", 0))
  m.handle(delta("ses_1", 0))
  assert.equal(m.producing(), true)

  advance(5000)
  assert.equal(m.producing(), false)
})

test("a burst within the throttle window is coalesced into one publish", () => {
  const { m, advance } = clocked({ updateIntervalMs: 100 })
  m.handle(stepStart("ses_1", 0))

  const published: boolean[] = []
  for (let index = 0; index < 5; index++) {
    published.push(m.handle(delta("ses_1", index * 10)))
    advance(10)
  }

  assert.equal(published.filter(Boolean).length, 1)
})

test("an event with no session is ignored rather than throwing", () => {
  const m = meter()
  m.handle({ type: "session.text.delta", created: 0, data: { delta: "x" } })
  m.handle({ type: "session.text.delta" })
  m.handle(undefined)
  m.handle("nonsense")
  m.handle({ type: "totally.unknown", created: 0, data: { sessionID: "ses_1" } })

  assert.equal(read(m, "ses_1").rate, 0)
})

test("an event with an implausible timestamp falls back to local time", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  // A foreign epoch would otherwise poison every window in the session.
  m.handle({
    type: "session.text.delta",
    created: 4_000_000_000_000,
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "x".repeat(40) },
  })

  // Falling back to the local clock means the sample is fresh, so it reads live.
  assert.ok(read(m, "ses_1").rate > 0)
})

test("a session that goes quiet without settling is swept", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  stream(m, "ses_1", 0, 100, 10)
  assert.ok(read(m, "ses_1").rate > 0)

  m.sweep(Date.now() + 10 * 60 * 1000)
  assert.equal(read(m, "ses_1").rate, 0)
  assert.equal(m.producing(), false)
})

test("a session that is still active is not swept", () => {
  const { m } = clocked()
  m.handle(stepStart("ses_1", 0))
  stream(m, "ses_1", 0, 100, 10)

  m.sweep(Date.now())
  assert.ok(read(m, "ses_1").rate > 0)
})

test("the meter subscribes only to the events it reads", () => {
  const m = meter()

  assert.deepEqual(m.events.slice().sort(), [
    "session.reasoning.delta",
    "session.step.ended",
    "session.step.started",
    "session.text.delta",
  ])
  // Tool spans and turn boundaries existed to serve a turn average. There is no
  // average, so subscribing to them would only be a way to get them wrong.
  assert.equal(m.events.includes("session.tool.called"), false)
  assert.equal(m.events.includes("session.tool.success"), false)
  assert.equal(m.events.includes("session.execution.started"), false)
  assert.equal(m.events.includes("session.execution.succeeded"), false)
})
