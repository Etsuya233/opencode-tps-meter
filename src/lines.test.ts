/**
 * Tests for the text layout.
 *
 * The sidebar is a fixed 37 columns and the host truncates rather than wraps, so
 * these assert on column counts rather than on exact strings wherever a length
 * could drift.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  clip,
  footerLine,
  headerLine,
  headerValue,
  IDLE,
  memberLine,
  memberLines,
  panelLines,
  rateText,
  SIDEBAR_WIDTH,
} from "./lines.ts"
import type { Aggregate, Member } from "./meter.ts"

function member(overrides: Partial<Member> = {}): Member {
  return { sessionID: "ses_1", label: "main", isRoot: true, rate: 42.1, flowing: true, ...overrides }
}

function aggregate(overrides: Partial<Aggregate> = {}): Aggregate {
  return { sessionID: "ses_1", rate: 42.1, flowing: true, members: [member()], ...overrides }
}

test("the sidebar budget matches the host's own geometry", () => {
  // 42 wide, 2 padding a side, 1 reserved for the scrollbar.
  assert.equal(SIDEBAR_WIDTH, 37)
})

test("clipping keeps the tail, which is what identifies a name", () => {
  assert.equal(clip("short", 10), "short")
  const clipped = clip("a-really-long-agent-name-for-narrow-sidebars", 20)
  assert.equal(clipped.length, 20)
  assert.ok(clipped.startsWith("…"))
  assert.ok(clipped.endsWith("sidebars"))
})

test("a member row carries the rate and nothing else", () => {
  const line = memberLine(member())

  assert.equal(line.label, "> main")
  assert.equal(line.value, "42.1 t/s")
})

test("a subagent row is indented under the root's marker", () => {
  const root = memberLine(member({ rate: 38 }))
  const sub = memberLine(member({ isRoot: false, label: "explore", rate: 4.1 }))

  assert.ok(root.label.startsWith("> "))
  assert.ok(sub.label.startsWith("  "))
})

test("an over-long name is clipped rather than pushing the number off", () => {
  const line = memberLine(member({ label: "a-really-long-agent-name-for-narrow-sidebars", rate: 128.9 }))

  assert.ok(line.label.length + line.value.length + 1 <= SIDEBAR_WIDTH)
  // The measurement survives intact: it is never the thing that gives way.
  assert.equal(line.value, "128.9 t/s")
  assert.ok(line.label.endsWith("sidebars"))
})

test("a member row never exceeds the width, whatever the name and rate", () => {
  const labels = ["a", "build", "review-the-diff-and-check", "x".repeat(80)]
  const rates = [0, 0.05, 4.1, 42.1, 128.9, 1024.7]

  for (const label of labels) {
    for (const rate of rates) {
      const { label: left, value } = memberLine(member({ label, rate }))
      assert.ok(
        left.length + value.length + 1 <= SIDEBAR_WIDTH,
        `${label} / ${rate}: ${left.length} + ${value.length} exceeds the width`,
      )
    }
  }
})

test("every panel line fits the sidebar", () => {
  const cases: Array<[string, Aggregate]> = [
    ["a single agent", aggregate()],
    [
      "two agents",
      aggregate({
        rate: 42.1,
        members: [
          member({ sessionID: "ses_1", label: "main", rate: 38 }),
          member({ sessionID: "ses_2", label: "explore", isRoot: false, rate: 4.1 }),
        ],
      }),
    ],
    [
      "four agents with long names",
      aggregate({
        rate: 128.9,
        members: [
          member({ sessionID: "a", label: "main", rate: 51 }),
          member({ sessionID: "b", label: "review-the-diff-and-check-everything", isRoot: false, rate: 0, flowing: false }),
          member({ sessionID: "c", label: "an-extremely-long-subagent-identifier", isRoot: false, rate: 128.9 }),
          member({ sessionID: "d", label: "build", isRoot: false, rate: 0, flowing: false }),
        ],
      }),
    ],
  ]

  for (const [name, value] of cases) {
    for (const line of panelLines(value)) {
      assert.ok(
        [...line].length <= SIDEBAR_WIDTH,
        `${name}: line is ${[...line].length} columns: ${JSON.stringify(line)}`,
      )
    }
  }
})

test("the panel leads with the family's combined rate", () => {
  const value = aggregate({
    rate: 42.1,
    members: [
      member({ sessionID: "ses_1", label: "main", rate: 38 }),
      member({ sessionID: "ses_2", label: "explore", isRoot: false, rate: 4.1 }),
    ],
  })
  const lines = panelLines(value)

  assert.ok(lines[0]?.startsWith("Throughput"))
  assert.ok(lines[0]?.endsWith("42.1 t/s"))
  // A title, one row per agent, and nothing else.
  assert.equal(lines.length, 3)
  assert.equal(lines[1], memberLines(value)[0])
  assert.ok(lines[1]?.startsWith("> main"))
  assert.ok(lines[2]?.startsWith("  explore"))
})

test("the panel shows no token, time or model lines", () => {
  const lines = panelLines(aggregate())

  // The neighbouring widgets already report these; a second, weaker copy of
  // them in the panel is noise rather than information.
  for (const line of lines) {
    assert.equal(line.includes("tokens"), false)
    assert.equal(line.includes("ttft"), false)
    assert.equal(line.includes("gen "), false)
    assert.equal(line.includes("claude"), false)
  }
})

test("the idle marker stands in for a rate that is not being measured", () => {
  // Zero and a negative are both "nothing is happening", and neither should
  // render as a number that looks like a measurement.
  assert.equal(rateText(0), IDLE)
  assert.equal(rateText(-1), IDLE)
  assert.equal(rateText(42.1), "42.1 t/s")
})

test("an idle family reads as the idle marker everywhere", () => {
  const idle = aggregate({ rate: 0, flowing: false, members: [member({ rate: 0, flowing: false })] })

  assert.equal(headerValue(idle), IDLE)
  assert.ok(headerLine(idle).endsWith(IDLE))
  assert.equal(memberLine(idle.members[0]!).value, IDLE)
  assert.equal(footerLine(idle), IDLE)
})

test("the idle marker is one column, so an idle row keeps its whole name", () => {
  const line = memberLine(member({ rate: 0, flowing: false, label: "review-the-diff-and-check-everything" }))

  assert.equal(line.value, IDLE)
  assert.ok(line.label.endsWith("everything"))
})

test("the footer marks a live rate and drops the mark once output stops", () => {
  assert.equal(footerLine(aggregate()), "⚡ 42.1 t/s")
  assert.equal(footerLine(aggregate({ rate: 0, flowing: false })), IDLE)
})

test("the footer carries no panel marker", () => {
  // The open panel is visible on its own, so the footer does not repeat that
  // state with an arrow beside the number.
  assert.equal(footerLine(aggregate()).includes("▸"), false)
  assert.equal(footerLine(aggregate({ rate: 0, flowing: false })).includes("▸"), false)
})

test("the header is a fixed width whatever the rate", () => {
  for (const rate of [0, 0.1, 42.1, 128.9, 1024.7]) {
    const line = headerLine(aggregate({ rate }))
    assert.ok([...line].length <= SIDEBAR_WIDTH)
  }
})
