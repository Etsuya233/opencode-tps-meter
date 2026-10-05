# @etsuya/opencode-tps-meter

Live tokens-per-second for OpenCode V2, counting a session **and every subagent
working under it**.

```
⚡ 42.1 t/s
```

That number sits in the prompt footer and is always visible. `/tps` opens a
per-agent breakdown in the session sidebar:

```
Throughput                  42.1 t/s
> main                       38.0 t/s
  explore                     4.1 t/s
```

One measurement, shared by the whole family: everything produced in the last
second, divided by one window. The rows are each agent's share of that same
window, so they add up to the number above them.

Rates only. The sidebar already shows a token meter and a context breakdown
next to this panel, so repeating token counts, timings and the model name there
made it a weaker second copy of what the neighbouring widgets say. What it adds is
the one thing nothing else has: the rate per agent.

## Install

```sh
npm install @etsuya/opencode-tps-meter
```

Add it to `cli.json` — a terminal-only plugin belongs there, so it stays active
against remote servers:

```json
{
  "plugins": ["@etsuya/opencode-tps-meter"]
}
```

To load a local checkout, point at the directory. It has to be the package
directory, not `dist/tui.mjs`: OpenCode resolves a local TUI entry by appending
`/tui` to the path.

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-tps-meter",
      "options": { "fastRate": 60 }
    }
  ]
}
```

Restart the TUI, or run `opencode service restart` if the meter does not appear.

## Options

```json
{
  "plugins": [
    {
      "package": "@etsuya/opencode-tps-meter",
      "options": {
        "fastRate": 45,
        "slowRate": 15,
        "color": true,
        "sidebar": true,
        "sidebarOpen": false
      }
    }
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `fastRate` | `number` | `45` | At or above this the reading is drawn as fast. |
| `slowRate` | `number` | `15` | At or below this the reading is drawn as slow. |
| `color` | `boolean` | `true` | Draw the rate in colour. Off renders it as plain text. |
| `sidebar` | `boolean` | `true` | Register the sidebar panel. Off leaves only the footer. |
| `sidebarOpen` | `boolean` | `false` | Start with the panel open. Off waits for `/tps` or a click. |

`sidebarOpen` only moves the starting state; the panel still toggles with `/tps`
and with a click on the footer, so the reading can be collapsed again without a
restart. `slowRate` is clamped to `fastRate`, so a misconfiguration cannot make a
reading satisfy both branches. Colours come from the active theme rather than
literals, so the meter follows a light or dark theme.

## Commands

| Command | Effect |
| --- | --- |
| `/tps` | Toggle the sidebar breakdown. Also in the palette as **Throughput**. |
| **Throughput detail** | Report the current rates as a toast, per agent. |

Clicking the footer meter toggles the sidebar too, but it is a convenience
rather than the only route: a terminal that has not enabled mouse reporting will
never deliver the click, while `/tps` always works.

## How the numbers are produced

### There is no token count to read while a reply streams

OpenCode publishes usage only once a step settles. `session.usage.updated` is
cumulative for the whole session and is emitted on step end, not per chunk, and
the AI layer folds provider usage into a single `step-finish` event rather than
emitting it as it arrives.

So during generation the only signal is the text, and the live rate is estimated
from it.

### One window, shared by the family

The rate is everything produced in the last second, divided by that second.

A session and all of its subagents together form one window. Every member's
tokens inside it are added up, and the total is divided by the widest span any
member saw — which is the same as running the window from the family's oldest
live token to now. Each agent's row is its own share of that same window, so the
rows always add up to the total above them.

Dividing each agent by its own span and then adding the results would describe a
different window per agent, and a subagent that had only just started would read
high against a burst of a few milliseconds rather than against the second the
rest of the family is being measured over.

### A blocked agent contributes nothing

A main agent waiting on a shell command has produced nothing. Its window is
empty, so it is inside no span and contributes no rate — not even the rate it
had before it blocked. That is what keeps a family total honest while a subagent
streams: the tokens are counted once, by the agent that produced them.

### The estimate corrects itself

Each step ends with a closed comparison: the characters counted against the
provider's authoritative `tokens.output + tokens.reasoning`, read from
`session.step.ended`. That ratio is folded into a per-model factor, and the next
chunk on that model is scaled by it. Stored per model, and kept for the life of
the TUI, so the second conversation on a model already reads close to the truth
rather than starting from the guess again.

Samples are only trusted above a token floor and within a plausible ratio band —
a truncated or retried step reports a wild number and is discarded. A step whose
finish reason says it produced nothing usable is not used as a sample at all.

The factor only ever changes how the *next* chunk is counted. What is on screen
is always the live estimate, which is the number a live meter is for.

### Time comes from the server's clock

The TUI delivers events in batches, so `Date.now()` inside a handler is the flush
time and every event in a batch shares it — which flattens the rolling window and
flatters the rate. Every event carries a server-stamped `created` instead, and
readings are taken against that, projected forward by local elapsed time so the
clock keeps ticking after the last event. A timestamp more than a day from the
local clock is treated as skewed and ignored, which is what a remote server with
a wrong clock would otherwise poison.

### Idle reads as a dash

Once nothing has arrived for a whole second the window is empty and the rate is
zero. The footer shows `-` rather than a number, because a zero would look like a
measurement when nothing is being measured.

There is no turn average to fall back to. An average over several agents has no
single honest denominator — subagents and their caller run one after the other,
not side by side, so any shared span either double-counts or drops time. The
meter reports what it can measure.

## Limitations

- **Terminal only.** Server plugins have no UI surface at all — no slot, theme
  or renderer — so there is nowhere to draw this. `opencode run` and other
  headless clients see nothing.
- **The sidebar needs width.** The panel is hidden below 120 columns and in
  subagent sessions, which the host decides. The footer is unaffected, and
  **Throughput detail** answers in a toast when the sidebar is not rendered.
- **Discoverability is on the user.** The panel starts hidden unless
  `sidebarOpen` turns it on, and terminals without mouse reporting get no hover
  cue. The slash command is the reliable route.
- **The reading is an estimate, and the panel does not say so.** Live tokens
  cannot be anything else: the provider's count only exists once a step has
  finished. It converges on that count as a model is used, and the number stops
  moving on its own once output stops.
- **A rate is only meaningful while something is running.** `/tps` and
  **Throughput detail** answer for the instant they are asked, so asking once
  everything has settled reports the idle marker.
- **Multiple TUI instances** each keep their own calibration, so two windows on
  the same server will disagree slightly until each has seen a settled step.

## Development

```sh
npm install
npm run typecheck
npm test
```

`src/rate.ts` holds the measurement primitives and `src/meter.ts` the event
routing and family aggregation. Neither imports Solid, OpenTUI or any OpenCode
type, so both are covered by `node --test` alone — including the decay behaviour,
whose clock is injected precisely because a rate cannot be watched fall in a
unit test. `src/tui.tsx` only wires them to the host's events and renders what
comes back.

Event fixtures in `src/meter.test.ts` are written to the shape the host actually
sends, copied from the event manifest rather than from what the plugin expects.
An earlier revision read the provider's token count from a field that does not
exist, and a fixture that agreed with it kept the suite green while the number
was never once used — which is why the shapes are mirrored deliberately here.

## Acknowledgements

Thanks to [ChiR24/opencode-tps-meter](https://github.com/ChiR24/opencode-tps-meter),
which this plugin is based on.

## License

MIT
