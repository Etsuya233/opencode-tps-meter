import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { footerLine, headerValue, memberLine, rateText } from "./lines.js";
import { createMeter } from "./meter.js";

/**
 * opencode-tps-meter
 *
 * Shows how fast the model is generating, for a session and every subagent
 * working under it.
 *
 * Two surfaces, because they answer two different questions:
 *
 *   prompt footer   how fast is it going right now, always visible
 *   session sidebar where did that rate come from, on demand
 *
 * The footer carries one number and nothing else. The moment it grows a second
 * figure it stops being glanceable, and the breakdown is what the sidebar is
 * for.
 *
 * How the numbers are produced is `src/meter.ts` and `src/rate.ts`; this file
 * only routes host events into them and renders what comes back.
 */

const ID = "opencode-tps-meter";

/**
 * Display throttle.
 *
 * OpenCode batches streamed deltas on the server, so events arrive in bursts
 * several times a second rather than per token. Publishing faster than they
 * arrive cannot show anything new, and a slot re-render is not free.
 */
const UPDATE_INTERVAL_MS = 100;

/**
 * How often the number is repainted while output drains.
 *
 * A rate decays with time rather than with events, so after the last token
 * something still has to redraw the surface or it keeps showing a number that is
 * no longer true. Only the tail needs this: while a stream is running the deltas
 * themselves drive every repaint.
 */
const DECAY_TICK_MS = 250;

/** How often a session that went quiet is looked for. */
const SWEEP_INTERVAL_MS = 60_000;
const DEFAULTS = {
  sidebar: true,
  sidebarOpen: false,
  fastRate: 45,
  slowRate: 15,
  color: true
};
function readNumber(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function readBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function readConfig(options) {
  const input = options ?? {};
  const fastRate = readNumber(input.fastRate, DEFAULTS.fastRate, 1, 1000);
  return {
    sidebar: readBoolean(input.sidebar, DEFAULTS.sidebar),
    sidebarOpen: readBoolean(input.sidebarOpen, DEFAULTS.sidebarOpen),
    // Slow can never reach fast, or a reading could satisfy both branches and
    // the colour would depend on evaluation order.
    slowRate: Math.min(readNumber(input.slowRate, DEFAULTS.slowRate, 0, fastRate), fastRate),
    fastRate,
    color: readBoolean(input.color, DEFAULTS.color)
  };
}

/**
 * The theme type, imported by name rather than reached through
 * `Plugin.Context["theme"]`.
 *
 * That indirection resolves to `any` when `@opencode/theme` is not installed, and
 * `skipLibCheck` keeps the resulting unresolved import inside `context.d.ts` from
 * ever being reported. Every `theme.text.*` path below would then be unchecked,
 * and a typo would render as `fg=undefined` in a real terminal instead of failing
 * the build. Naming the type here makes a missing dependency a compile error.
 */

/** Rate tier, resolved to a theme token rather than a literal colour. */
function rateColor(theme, config, rate, active) {
  if (!active) return theme.text.muted;
  if (!config.color) return theme.text.base;
  if (rate >= config.fastRate) return theme.text.feedback.success.base;
  if (rate <= config.slowRate) return theme.text.feedback.warning.base;
  return theme.text.base;
}

/**
 * One family member's row: who it is, how fast.
 *
 * The label and the number are two renderables rather than one string, because
 * the label has to be able to give way while the value holds its width.
 * `memberLine` decides that split and the truncation, so the column arithmetic
 * lives in one tested place instead of inside markup.
 */
function MemberRow(props) {
  const theme = () => props.theme();
  const member = () => props.member;
  const line = createMemo(() => memberLine(member()));
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "justifyContent", "space-between");
    _$setProp(_el$, "flexShrink", 0);
    _$setProp(_el$2, "wrapMode", "none");
    _$setProp(_el$2, "truncate", true);
    _$setProp(_el$2, "flexShrink", 1);
    _$insert(_el$2, () => line().label);
    _$setProp(_el$3, "wrapMode", "none");
    _$setProp(_el$3, "flexShrink", 0);
    _$insert(_el$3, () => line().value);
    _$effect(_p$ => {
      var _v$ = member().flowing ? theme().text.base : theme().text.muted,
        _v$2 = rateColor(theme(), props.config, member().rate, member().flowing);
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}

/**
 * The sidebar panel.
 *
 * Hidden unless opened: the footer already answers "how fast", and a sidebar
 * that permanently holds a second copy of the same number crowds out the token
 * meter that lives there. `/tps` or a click on the footer opens it, and
 * `sidebarOpen` can make it start open.
 */
function Panel(props) {
  const context = props.context;
  const theme = () => context.theme;

  // Narrowed to a single memo so `Show`'s callback receives an accessor. A
  // `false` in the union leaves the parameter untyped, and hand-annotating it
  // once let a `keyed` mistake through to runtime, where `keyed` hands the
  // callback a value and every `aggregate()` call became a call on a plain
  // object. One memo, no `keyed`, and the annotation is then simply correct.
  const current = createMemo(() => props.expanded() ? props.aggregate() : undefined);
  return _$createComponent(Show, {
    get when() {
      return current();
    },
    children: aggregate => // No gap. The sidebar already spaces its own content, and a panel that
    // only has a title and one row per agent does not need a blank line
    // between every pair of them — at two rows that padding was most of
    // what the panel occupied.
    (() => {
      var _el$4 = _$createElement("box"),
        _el$5 = _$createElement("box"),
        _el$6 = _$createElement("text"),
        _el$7 = _$createElement("b"),
        _el$9 = _$createElement("text");
      _$insertNode(_el$4, _el$5);
      _$setProp(_el$4, "flexDirection", "column");
      _$setProp(_el$4, "flexShrink", 0);
      _$insertNode(_el$5, _el$6);
      _$insertNode(_el$5, _el$9);
      _$setProp(_el$5, "flexDirection", "row");
      _$setProp(_el$5, "justifyContent", "space-between");
      _$setProp(_el$5, "flexShrink", 0);
      _$insertNode(_el$6, _el$7);
      _$insertNode(_el$7, _$createTextNode(`Throughput`));
      _$setProp(_el$9, "wrapMode", "none");
      _$insert(_el$9, () => headerValue(aggregate()));
      _$insert(_el$4, _$createComponent(For, {
        get each() {
          return aggregate().members;
        },
        children: member => _$createComponent(MemberRow, {
          theme: theme,
          get config() {
            return props.config;
          },
          member: member
        })
      }), null);
      _$effect(_p$ => {
        var _v$3 = theme().text.base,
          _v$4 = rateColor(theme(), props.config, aggregate().rate, aggregate().flowing);
        _v$3 !== _p$.e && (_p$.e = _$setProp(_el$6, "fg", _v$3, _p$.e));
        _v$4 !== _p$.t && (_p$.t = _$setProp(_el$9, "fg", _v$4, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$4;
    })()
  });
}

/**
 * The footer meter.
 *
 * A click target, so it reports hover the way the host's own footer text does:
 * muted at rest, base under the pointer. Clicking is a convenience rather than
 * the only route, because a terminal that has not enabled mouse reporting will
 * never deliver the event; `/tps` always works.
 *
 * The meter carries no marker for whether the panel is open. The panel is
 * visible on its own when it is, so the footer stays one number.
 */
function Footer(props) {
  const context = props.context;
  const [hovered, setHovered] = createSignal(false);
  // `undefined` rather than the idle marker, so a surface with no session at all
  // unmounts the row instead of leaving a click target with nothing behind it.
  const text = createMemo(() => {
    const aggregate = props.aggregate();
    if (!aggregate) return undefined;
    return footerLine(aggregate);
  });
  return _$createComponent(Show, {
    get when() {
      return text();
    },
    children: value => {
      const active = () => props.aggregate()?.flowing ?? false;
      const rate = () => props.aggregate()?.rate ?? 0;
      return (() => {
        var _el$0 = _$createElement("box"),
          _el$1 = _$createElement("text");
        _$insertNode(_el$0, _el$1);
        _$setProp(_el$0, "flexShrink", 0);
        _$setProp(_el$1, "wrapMode", "none");
        _$setProp(_el$1, "flexShrink", 0);
        _$setProp(_el$1, "onMouseOver", () => setHovered(true));
        _$setProp(_el$1, "onMouseOut", () => setHovered(false));
        _$setProp(_el$1, "onMouseUp", () => props.onToggle());
        _$insert(_el$1, value);
        _$effect(_$p => _$setProp(_el$1, "fg", hovered() ? context.theme.text.base : rateColor(context.theme, props.config, rate(), active()), _$p));
        return _el$0;
      })();
    }
  });
}
export default Plugin.define({
  id: ID,
  setup(context) {
    const config = readConfig(context.options);
    const meter = createMeter({
      windowMs: 1000,
      updateIntervalMs: UPDATE_INTERVAL_MS
    });

    // Bumped whenever a session's numbers may have moved. The reactive surfaces
    // read this rather than the meter directly, so a publish re-renders them
    // without every slot re-deriving the aggregate on its own.
    const [revision, setRevision] = createSignal(0);
    const unsubscribes = meter.events.map(event => context.data.on(event, payload => {
      // The meter decides whether this event is due for a repaint; the plugin
      // only has to notice. It answers by advancing a revision the reactive
      // surfaces read, so a slot re-renders without re-deriving anything itself.
      if (meter.handle(payload)) setRevision(value => value + 1);
    }));

    /**
     * The decay tick.
     *
     * The meter is asked whether anything is still producing, and the answer
     * drives one last repaint when it stops. Without that extra tick a footer
     * would be left showing the rate from the instant output ended, because
     * nothing else tells the surface the window has since drained.
     */
    let wasProducing = false;
    const decay = setInterval(() => {
      const producing = meter.producing();
      if (producing || wasProducing) setRevision(value => value + 1);
      wasProducing = producing;
    }, DECAY_TICK_MS);
    const sweeper = setInterval(() => meter.sweep(Date.now()), SWEEP_INTERVAL_MS);

    /**
     * The reading for the session a surface is rendering.
     *
     * The family comes from the host's own session tree, so a subagent is
     * attributed exactly rather than inferred. `revision` is read for its
     * effect: the aggregate itself is not reactive, and without it a slot would
     * only ever compute once.
     */
    const aggregateFor = sessionID => {
      revision();
      if (!sessionID) return undefined;
      const data = context.data.session;
      // Resolved once and reused for the row order, the root test and the
      // labels: `root` walks parentID through the store, and calling it per row
      // on every publish would re-walk the tree for each member.
      let rootID = sessionID;
      let family = [];
      try {
        rootID = data.root(sessionID);
        family = data.family(rootID) ?? [];
      } catch {
        // A session the store has not resolved yet has no family; the reading
        // then covers the session alone, which is still correct.
        family = [sessionID];
      }
      return meter.aggregate({
        sessionID,
        family: family.length > 0 ? family : [sessionID],
        isRoot: id => id === rootID,
        label: id => {
          if (id === sessionID) return "main";
          return data.get(id)?.agent ?? id.slice(-6);
        }
      });
    };
    const [expanded, setExpanded] = createSignal(config.sidebarOpen);
    const toggle = () => setExpanded(value => !value);

    /**
     * The session the footer is currently rendering.
     *
     * The footer is mounted once per session tab, so this is whichever the user
     * is looking at, and it is what `/tps detail` reports on. It is tracked here
     * rather than read from the router because a command has to describe a
     * specific session even when the sidebar that would show it is not rendered.
     */
    let currentSession;
    const offFooter = context.ui.slot({
      // AFTER, not append. The host's own child inside prompt.footer.status is a
      // box with flexGrow:1, and while a turn is running it renders a second
      // flexGrow:1 box holding the spinner and the interrupt hint. Appending
      // places this INSIDE that boundary, after the greedy child, so it collapses
      // to zero width the moment anything runs. `after` makes it a sibling
      // instead, which the greedy layout cannot squeeze; flexShrink={0} then
      // holds its width.
      //
      // The file slot sits after the status slot, so anchoring here rather than
      // to the status slot is what puts the meter at the far right.
      after: "prompt.footer.file",
      render: input => {
        currentSession = input.sessionID;
        return _$createComponent(Footer, {
          context: context,
          aggregate: () => aggregateFor(input.sessionID ?? ""),
          config: config,
          onToggle: toggle
        });
      }
    });
    const offSidebar = config.sidebar ? context.ui.slot({
      append: "sidebar.content",
      render: input => _$createComponent(Panel, {
        context: context,
        aggregate: () => aggregateFor(input.sessionID),
        expanded: expanded,
        config: config
      })
    }) : undefined;

    // Commands need a reactive owner, and `keymap.layer` creates one per
    // calling component, so it cannot be invoked from bare setup. Mounting a
    // null-rendering component in the app slot is how the host's own plugins
    // register commands; see packages/tui/src/feature-plugins/prompt/btw.tsx.
    const offApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [{
            id: "tps.panel",
            title: "Throughput",
            description: "Show or hide the per-agent throughput breakdown",
            group: "Throughput",
            palette: true,
            slash: {
              name: "tps"
            },
            run: () => {
              toggle();
            }
          }, {
            id: "tps.detail",
            title: "Throughput detail",
            description: "Report this session's throughput as a toast",
            group: "Throughput",
            palette: true,
            run: () => {
              const aggregate = aggregateFor(currentSession ?? "");
              // There is only ever a live rate to report, so asking while
              // nothing runs has no answer beyond saying so. The idle marker
              // would be a toast of dashes otherwise.
              if (!aggregate || !aggregate.flowing) {
                context.ui.toast.show({
                  message: "Nothing is generating right now.",
                  variant: "info"
                });
                return;
              }
              // A toast is the only surface that survives a terminal too
              // narrow for the sidebar, so the command still has an answer
              // there. Rates only, for the same reason the panel is.
              const rows = aggregate.members.map(member => `${member.isRoot ? ">" : " "} ${member.label}  ${rateText(member.rate)}`);
              context.ui.toast.show({
                title: rateText(aggregate.rate),
                message: rows.join("\n"),
                variant: "info",
                duration: 6000
              });
            }
          }]
        }));
        return null;
      }
    });
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      clearInterval(decay);
      clearInterval(sweeper);
      offFooter();
      offSidebar?.();
      offApp();
      meter.dispose();
    };
  }
});
