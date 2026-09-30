/**
 * Renders the panel and footer exactly as `src/tui.tsx` would, as plain text.
 *
 * Layout bugs in a TUI plugin are invisible until a terminal is involved, and
 * getting one going to check a 37-column alignment is a poor trade. This mirrors
 * the markup's structure — the same header, rows and footer lines, in the same
 * order, at the same widths — and reports any line that would not fit the
 * session sidebar.
 *
 *   node scripts/preview.mjs
 *
 * Not published: it is a development aid, and `files` in package.json keeps it
 * out of the tarball.
 */

import { footerLine, panelLines, SIDEBAR_WIDTH } from "../src/lines.ts"

/** One member as the meter would report it. */
function member(label, rate, options = {}) {
  return { sessionID: label, label, rate, flowing: rate > 0, isRoot: false, ...options }
}

/**
 * Scenarios chosen to show the shapes the panel has to survive: one agent, a
 * family mid-flight, a blocked root beside a streaming subagent, an idle family,
 * and the extreme names and rates that decide whether anything overflows.
 */
const scenarios = [
  {
    name: "a single agent, mid-stream",
    aggregate: {
      sessionID: "ses_1",
      rate: 42.13,
      flowing: true,
      members: [member("main", 42.13, { isRoot: true })],
    },
  },
  {
    name: "a subagent working alongside the main agent",
    aggregate: {
      sessionID: "ses_1",
      rate: 42.1,
      flowing: true,
      members: [
        member("main", 38, { isRoot: true }),
        member("explore", 4.1),
      ],
    },
  },
  {
    // The blocked member's window is empty, so it is inside no span this window
    // covers and contributes nothing at all.
    name: "main blocked on a tool, subagent still streaming",
    aggregate: {
      sessionID: "ses_1",
      rate: 4.1,
      flowing: true,
      members: [
        member("main", 0, { isRoot: true }),
        member("explore", 4.1),
      ],
    },
  },
  {
    name: "everything idle",
    aggregate: {
      sessionID: "ses_1",
      rate: 0,
      flowing: false,
      members: [
        member("main", 0, { isRoot: true }),
        member("explore", 0),
        member("build", 0),
      ],
    },
  },
  {
    name: "a very long agent name and a four-figure rate",
    aggregate: {
      sessionID: "ses_1",
      rate: 128.9,
      flowing: true,
      members: [member("a-really-long-agent-name-for-narrow-sidebars", 128.9, { isRoot: true })],
    },
  },
]

let overflowing = 0

for (const scenario of scenarios) {
  // The same functions the plugin renders with, so this cannot drift from it.
  const lines = panelLines(scenario.aggregate)
  const bar = footerLine(scenario.aggregate)

  console.log(`\n\x1b[1m${scenario.name}\x1b[0m`)
  for (const line of lines) {
    // The host truncates rather than wrapping, so an over-long line is silently
    // cut. Flagging it here is the whole point of the script.
    const tooWide = [...line].length > SIDEBAR_WIDTH
    if (tooWide) overflowing++
    const marker = tooWide ? "\x1b[31m!\x1b[0m" : " "
    console.log(`${marker}|${line}${tooWide ? `  (${[...line].length} cols)` : ""}`)
  }
  console.log(`  footer: \x1b[2m${bar}\x1b[0m`)
}

console.log(`\nsidebar budget: ${SIDEBAR_WIDTH} columns`)
if (overflowing > 0) {
  console.log(`\x1b[31m${overflowing} line(s) exceed it and would be truncated\x1b[0m`)
  process.exitCode = 1
} else {
  console.log(`\x1b[32mall lines fit\x1b[0m`)
}
