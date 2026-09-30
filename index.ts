/**
 * Server entrypoint.
 *
 * The meter is a terminal feature, so this exists only so the package is
 * well-formed if it is ever listed in `opencode.json` rather than `cli.json`.
 *
 * A server plugin has no UI surface at all: its context exposes agent, command,
 * event, integration, mcp, model, permission, provider, reference, session,
 * shell, skill, tool, vcs, websearch and worktree, and no slot, theme or
 * renderer. It could subscribe to the same events and compute the same numbers,
 * but there is nowhere to draw them, so there is nothing for it to do.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-tps-meter.server",
  setup() {},
})
