/**
 * Text layout for the two surfaces.
 *
 * Pure string construction, no JSX, so the column arithmetic can be asserted
 * directly. The sidebar is 37 usable columns wide and the host truncates rather
 * than wrapping, so a line that overflows is silently cut — which is the kind of
 * defect that otherwise only shows up in a real terminal, and only once the
 * numbers happen to be long.
 *
 * The panel carries the rate and nothing else. Token totals, time-to-first-token
 * and the model all used to live here, and the sidebar already shows tokens and a
 * context breakdown next to it; repeating them made the panel a second, weaker
 * copy of what the neighbouring widgets already say. What the panel adds is the
 * one thing nothing else has: the rate per agent.
 *
 * A rate is only ever the live one. There used to be a fallback to a frozen turn
 * average for the moment output stopped, so an idle panel did not read `0.0` for
 * a turn that had produced hundreds of tokens. With subagents in the family that
 * average had no single honest denominator, so it is gone; an idle surface says
 * so instead of showing a number that is no longer measured.
 */

import { formatRate } from "./rate.ts"
import type { Aggregate } from "./meter.ts"

/**
 * Usable width of the session sidebar.
 *
 * SESSION_SIDEBAR_WIDTH is 42; the sidebar box takes two columns of padding a
 * side, and the content box reserves one more on the right for the scrollbar. A
 * visible scrollbar steals a row during layout, so the narrower figure is what a
 * line has to survive.
 */
export const SIDEBAR_WIDTH = 42 - 2 - 2 - 1

/** Shown in place of a rate when nothing is being produced. */
export const IDLE = "-"

/** Truncates from the front, keeping the tail. */
export function clip(value: string, width: number): string {
  const chars = [...value]
  if (chars.length <= width) return value
  if (width <= 1) return "…"
  return `…${chars.slice(-(width - 1)).join("")}`
}

/** Two columns, `left` at the margin and `right` flush to the other. */
function spread(left: string, right: string): string {
  return left + " ".repeat(Math.max(1, SIDEBAR_WIDTH - left.length - right.length)) + right
}

/** A rate, or the idle marker when nothing is being produced. */
export function rateText(rate: number): string {
  return rate > 0 ? `${formatRate(rate)} t/s` : IDLE
}

export type MemberView = {
  isRoot: boolean
  label: string
  rate: number
  flowing: boolean
}

/** One family member, split into the two columns the row renders. */
export type MemberLine = {
  /** Marker plus agent name, already clipped to the space that is left. */
  label: string
  /** The rate, or the idle marker. Never clipped: this is the measurement. */
  value: string
}

/**
 * Splits a member row into its two columns.
 *
 * Returned as a pair rather than one joined string because the row renders them
 * as separate elements: the label shrinks, the value does not. Deciding that
 * split here keeps the column arithmetic in one tested place instead of inside
 * markup, where it can only be checked by looking at a terminal.
 */
export function memberLine(member: MemberView): MemberLine {
  const value = rateText(member.rate)
  // The name gives way, not the number: the rate is the measurement, and a name
  // is identifiable by its end.
  const label = clip(`${member.isRoot ? ">" : " "} ${member.label}`, SIDEBAR_WIDTH - value.length - 1)
  return { label, value }
}

/** The rate shown beside the panel's title. */
export function headerValue(aggregate: Aggregate): string {
  return rateText(aggregate.rate)
}

/** The panel's first line, as one string. */
export function headerLine(aggregate: Aggregate): string {
  return spread("Throughput", headerValue(aggregate))
}

/** One line per family member, in the order the host listed them. */
export function memberLines(aggregate: Aggregate): string[] {
  return aggregate.members.map((member) => {
    const { label, value } = memberLine(member)
    return spread(label, value)
  })
}

/** Every panel line, for the preview and the width assertions. */
export function panelLines(aggregate: Aggregate): string[] {
  return [headerLine(aggregate), ...memberLines(aggregate)]
}

export type FooterOptions = {
  expanded: boolean
}

/**
 * The footer meter.
 *
 * The lightning bolt marks a number that is being measured right now. Once
 * output stops the window empties within a second and this becomes the idle
 * marker, which is also why there is no "avg" suffix to carry: there is no
 * average left to label.
 */
export function footerLine(aggregate: Aggregate, options: FooterOptions): string {
  const body = aggregate.flowing ? `⚡ ${rateText(aggregate.rate)}` : rateText(aggregate.rate)
  return options.expanded ? `▸ ${body}` : body
}
