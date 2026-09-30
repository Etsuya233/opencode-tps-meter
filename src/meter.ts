/**
 * Event routing and session-family aggregation.
 *
 * Framework-free, like `rate.ts`: this module turns the host's session events
 * into readings and folds a session together with its subagents. It is unit
 * tested with `node --test` alone; `src/tui.tsx` only supplies the events and
 * renders what comes back.
 *
 * Event vocabulary
 * ----------------
 * OpenCode V2 replaced V1's `message.*` family with granular session events:
 *
 *   text or reasoning stream  ->  session.text.delta / session.reasoning.delta
 *   step boundary             ->  session.step.started / session.step.ended
 *
 * Two properties of the V2 vocabulary do the heavy lifting here. Text and
 * reasoning deltas are assistant output by construction, so there is no need to
 * filter by message role the way V1 had to. And every event carries a
 * server-stamped `created`, so a rate can be measured on the host's clock
 * instead of the TUI's, where a batched flush would give every event in a batch
 * the same timestamp.
 *
 * Nothing else is subscribed to. Tool spans and turn boundaries used to be here
 * so a turn average could subtract the time spent waiting on a tool and freeze
 * itself at a boundary. There is no average to freeze any more, a rolling window
 * needs no boundary, and every event the plugin does not read is one it cannot
 * get wrong. The provider's authoritative token count still arrives on
 * `session.step.ended`, and is read there for calibration.
 *
 * The aggregate
 * -------------
 * A subagent is a child session: the tool creates it with the caller as
 * `parentID`, and the TUI indexes the tree into `data.session.family(root)`.
 * Throughput for the whole tree is therefore a sum over readings the plugin
 * already keeps, all taken at one instant.
 *
 * What makes the sum correct is that one window is shared. Every member's count
 * inside the last `windowMs` is added up, and the total is divided by the widest
 * span any member saw. A member blocked in a tool call has an empty window, so
 * it contributes nothing at all — not a rate, and not a stale one held over from
 * before it blocked.
 */

import {
  createCalibration,
  createSessionRate,
  DEFAULT_MODEL_KEY,
  perSecond,
  type Calibration,
  type Reading,
  type SessionRate,
  type WindowOptions,
} from "./rate.ts"

/** The subset of a streamed-content event this plugin reads. */
type StreamEvent = {
  type: string
  created?: number
  data: { sessionID: string; delta: string }
}

/** The subset of a step-started event this plugin reads. */
type StepStartedEvent = {
  type: string
  created?: number
  data: { sessionID: string; model?: { providerID?: unknown; id?: unknown; variant?: unknown } }
}

/**
 * The subset of a step-ended event this plugin reads.
 *
 * The provider's usage is nested under `tokens`, and those two numbers are typed
 * `unknown` on purpose: this is the boundary where the wire format meets our
 * arithmetic, and it is the one place a stray string or null could enter. They
 * are read through `positive()` rather than trusted.
 */
type StepEndedEvent = {
  type: string
  created?: number
  data: { sessionID: string; finish?: string; tokens?: { output?: unknown; reasoning?: unknown } }
}

export type MeterOptions = WindowOptions & {
  /** Display throttle, in milliseconds. */
  updateIntervalMs?: number
  /** Age at which a session that went quiet is dropped. */
  staleAfterMs?: number
  /**
   * Local clock, injectable so a decay can be exercised without waiting for it.
   *
   * A rate that has to fall to zero over a wall-clock second cannot otherwise be
   * tested at all, and the alternative — reading at the last event's timestamp —
   * is exactly the bug this guards against, since it pins the rate forever.
   */
  now?: () => number
}

/** One member of the session family. */
export type Member = {
  sessionID: string
  /** The agent that produced the current step, when known. */
  label: string
  /** True for the session the user is looking at. */
  isRoot: boolean
  /** This member's share of the family rate, over the shared window. */
  rate: number
  /** True while this member is producing tokens. */
  flowing: boolean
}

/** Everything the two surfaces render, for one session and its subagents. */
export type Aggregate = {
  /** Session the reading is anchored to; the root of the family. */
  sessionID: string
  /** Combined rate of every member, over one shared window. */
  rate: number
  /** True while any member has a token inside the window. */
  flowing: boolean
  members: Member[]
}

export interface Meter {
  /** The events this meter consumes, in the order they are subscribed. */
  readonly events: ReadonlyArray<string>
  /**
   * Feeds one event, returning whether it advanced the numbers far enough to be
   * worth repainting.
   *
   * The throttle lives here rather than in the caller because this is the only
   * place that knows which session an event belongs to and when that session was
   * last published. A caller-side throttle would have to guess.
   */
  handle(event: unknown): boolean
  /**
   * The current aggregate for a session, including its subagents.
   *
   * `family` is the session tree the host resolved; the reading is returned
   * whether or not the session itself has produced anything, so a panel can
   * render an idle state instead of nothing.
   */
  aggregate(input: {
    sessionID: string
    family: ReadonlyArray<string>
    isRoot: (id: string) => boolean
    label: (id: string) => string
  }): Aggregate
  /**
   * True while any session the meter has seen still has a token in its window.
   *
   * A rate decays with time rather than with events, so something has to repaint
   * the surface after the last token. This is what a caller polls to know whether
   * that repaint is still needed.
   */
  producing(): boolean
  /** Drops sessions that went quiet, so a long-lived TUI cannot accumulate them. */
  sweep(now: number): void
  dispose(): void
}

const HANDLED = new Set([
  "session.text.delta",
  "session.reasoning.delta",
  "session.step.started",
  "session.step.ended",
])

/**
 * Finish reasons whose numbers do not describe real output, so no calibration
 * sample is taken from them.
 *
 * `length` is deliberately absent: a step cut off at the output limit still
 * streamed real characters and was billed real tokens, so its ratio is as good a
 * sample as any. `"aborted"` is absent because the host's finish enum has no such
 * value — an abort arrives as a different event entirely.
 */
const DISCARDED_FINISH = new Set(["unknown", "error", "content-filter"])

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000
const DEFAULT_UPDATE_INTERVAL_MS = 100

/**
 * Resolves the host clock for an event.
 *
 * The TUI delivers events in batches, so `Date.now()` inside a handler is the
 * flush time and every event in a batch shares it. That flattens the rolling
 * window and flatters the rate. Events carry a server-stamped `created` instead,
 * which is the honest timestamp, and a payload missing one degrades to local
 * time rather than to a wrong-but-plausible number.
 */
function eventTime(event: { created?: unknown }, fallback: number): number {
  const created = event.created
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) return fallback
  // A foreign epoch or a badly skewed clock is worse than no timestamp at all.
  if (Math.abs(created - fallback) > 86_400_000) return fallback
  return created
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

/** The session an event belongs to, if it names one. */
function sessionIDOf(event: unknown): string | undefined {
  const data = asRecord(asRecord(event)?.data)
  const sessionID = data?.sessionID
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined
}

/** A token count from the wire, or 0 for anything that is not a positive number. */
function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function modelKeyOf(model: StepStartedEvent["data"]["model"]): string | undefined {
  if (!model) return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : ""
  const id = typeof model.id === "string" ? model.id : ""
  if (!providerID && !id) return undefined
  const variant = typeof model.variant === "string" && model.variant ? `#${model.variant}` : ""
  return `${providerID}/${id}${variant}`
}

export function createMeter(options?: MeterOptions): Meter {
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const updateIntervalMs = options?.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS
  const now = options?.now ?? Date.now

  const rates = new Map<string, SessionRate>()
  const lastSeen = new Map<string, number>()
  const lastPublish = new Map<string, number>()
  /**
   * Where the host clock stood when each session was last heard from, paired
   * with the local clock at that moment.
   *
   * Token samples carry the server's clock, so a reading has to be taken against
   * that clock: against a remote server the two are arbitrarily offset, and
   * asking a window how it looks "now" on the wrong clock empties it instantly.
   *
   * The local reading is kept so the projected clock can keep *ticking* after the
   * last event. Reading at a frozen host timestamp would pin the rate at whatever
   * it was when output stopped, which is the one thing a live meter must not do.
   */
  const clock = new Map<string, { host: number; local: number }>()
  const calibration: Calibration = createCalibration()

  function noteHostTime(sessionID: string, at: number) {
    const current = clock.get(sessionID)
    if (!current || at > current.host) clock.set(sessionID, { host: at, local: now() })
  }

  /** The host-clock instant a reading of one session should be taken at. */
  function nowFor(sessionID: string): number {
    const at = clock.get(sessionID)
    if (!at) return now()
    // Elapsed local time since the last event, applied to the host's timeline.
    return at.host + (now() - at.local)
  }

  /**
   * The host-clock instant a reading of the whole family is taken at.
   *
   * Every session projects the host clock forward by its own local elapsed time,
   * so the members agree up to measurement jitter. Taking the latest of them
   * keeps a member that heard from the server most recently from having its
   * window evaluated in the past.
   */
  function familyNow(ids: ReadonlyArray<string>): number {
    const local = now()
    let at: number | undefined
    for (const id of ids) {
      const seen = clock.get(id)
      if (!seen) continue
      const projected = seen.host + (local - seen.local)
      if (at === undefined || projected > at) at = projected
    }
    return at ?? local
  }

  function rateFor(sessionID: string): SessionRate {
    let rate = rates.get(sessionID)
    if (!rate) {
      rate = createSessionRate(sessionID, options)
      rates.set(sessionID, rate)
    }
    return rate
  }

  /**
   * Whether this event is far enough past the last publish to warrant a repaint.
   *
   * Throttled on the local clock rather than the host clock: the interval is
   * enforced against wall time, and a host-clock interval silently skips updates
   * whenever the two clocks disagree. Coalescing matters here because a stream
   * arrives in batches and a repaint per event would repaint far more often than
   * the display can show anything new.
   */
  function shouldPublish(sessionID: string): boolean {
    const local = now()
    const last = lastPublish.get(sessionID)
    if (last !== undefined && local - last < updateIntervalMs) return false
    lastPublish.set(sessionID, local)
    return true
  }

  function handleStream(event: StreamEvent): boolean {
    const { sessionID, delta } = event.data
    if (typeof delta !== "string" || delta.length === 0) return false
    const at = eventTime(event, nowFor(sessionID))
    noteHostTime(sessionID, at)
    const rate = rateFor(sessionID)
    rate.absorb(delta, calibration.tokensPerChar(rate.modelKey), at)
    // Only a stream moves a live number, so only a stream is worth a repaint.
    return shouldPublish(sessionID)
  }

  function handleStepStarted(event: StepStartedEvent): void {
    const { sessionID, model } = event.data
    noteHostTime(sessionID, eventTime(event, nowFor(sessionID)))
    rateFor(sessionID).beginStep(modelKeyOf(model) ?? DEFAULT_MODEL_KEY)
  }

  function handleStepEnded(event: StepEndedEvent): void {
    const { sessionID, finish, tokens } = event.data
    const rate = rates.get(sessionID)
    if (!rate) return
    noteHostTime(sessionID, eventTime(event, nowFor(sessionID)))

    // One closed comparison per step: what we counted against what the provider
    // reported. This is what makes the live estimate converge on the truth, and
    // it only changes how the *next* chunk is counted, so it is never worth a
    // repaint on its own.
    const sample = rate.endStep({
      output: positive(tokens?.output),
      reasoning: positive(tokens?.reasoning),
    })
    if (finish !== undefined && DISCARDED_FINISH.has(finish)) return
    calibration.observe(sample.modelKey, sample.chars, sample.tokens)
  }

  function handle(event: unknown): boolean {
    const type = asRecord(event)?.type
    if (typeof type !== "string" || !HANDLED.has(type)) return false
    const sessionID = sessionIDOf(event)
    if (sessionID === undefined) return false
    lastSeen.set(sessionID, now())

    switch (type) {
      case "session.text.delta":
      case "session.reasoning.delta":
        return handleStream(event as StreamEvent)
      case "session.step.started":
        handleStepStarted(event as StepStartedEvent)
        return false
      case "session.step.ended":
        handleStepEnded(event as StepEndedEvent)
        return false
      default:
        // Unreachable: HANDLED gates the switch above. Present so a future event
        // added to HANDLED without a case here is a type error rather than a
        // silently dropped event.
        return false
    }
  }

  return {
    events: [...HANDLED],

    handle,

    aggregate(input) {
      const ids = input.family.length > 0 ? input.family : [input.sessionID]
      const at = familyNow(ids)

      let count = 0
      let spanMs = 0
      let flowing = false
      const readings = new Map<string, Reading>()
      for (const id of ids) {
        const reading = rates.get(id)?.reading(at)
        if (!reading) continue
        readings.set(id, reading)
        count += reading.tokens
        spanMs = Math.max(spanMs, reading.spanMs)
        flowing ||= reading.flowing
      }

      // One window for the family, so the rows add up to the number above them.
      // A member's own span is never used to build a rate here: dividing each by
      // its own span would describe a different window per member.
      const members = ids.map((id) => {
        const reading = readings.get(id)
        return {
          sessionID: id,
          label: input.label(id),
          isRoot: input.isRoot(id),
          rate: perSecond(reading?.tokens ?? 0, spanMs),
          flowing: reading?.flowing ?? false,
        }
      })

      return { sessionID: input.sessionID, rate: perSecond(count, spanMs), flowing, members }
    },

    producing() {
      for (const [sessionID, rate] of rates) {
        if (rate.reading(nowFor(sessionID)).flowing) return true
      }
      return false
    },

    sweep(at) {
      for (const [sessionID, seenAt] of lastSeen) {
        if (at - seenAt <= staleAfterMs) continue
        // A stream that ends normally is already invisible by the time this
        // fires: its window empties on its own within a second. What this
        // catches is a session that went silent without settling — a crash or a
        // dropped connection — which would otherwise keep its window for the
        // life of the process. Dropping a session that is merely blocked in a
        // tool call is harmless: its window holds nothing.
        rates.delete(sessionID)
        lastPublish.delete(sessionID)
        lastSeen.delete(sessionID)
        clock.delete(sessionID)
      }
    },

    dispose() {
      rates.clear()
      lastSeen.clear()
      lastPublish.clear()
      clock.clear()
      calibration.forget()
    },
  }
}
