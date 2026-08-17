/**
 * dsh-plan-mode-enhanced host half: bridges the permission dropdown's
 * "Plan Mode" preset to the real plan-mode state.
 *
 *   - selecting the plan-mode permission preset enters plan mode via
 *     `ctx.planMode.set(agent, true)` (sandbox/approval come from the
 *     preset's own table entry, configured in the profile's
 *     `cordis.patch.yml` under the `permission` row);
 *   - selecting any other permission preset leaves plan mode;
 *   - leaving plan mode through `/plan off` or the `exit_plan_mode` tool
 *     while the plan-mode preset is still current restores the preset that
 *     was active before the plan-mode switch, so the dropdown state does
 *     not drift from the logged plan state.
 *
 * Pure event bridge: no tools, no settings, no client surface.
 * @module dsh-plan-mode-enhanced
 */

/** The permission-presets table key this plugin bridges to plan mode. */
const PLAN_PRESET = "plan-mode";

/** Cordis plugin identity: `- insert: - id: plan-mode-enhanced name: dsh-plan-mode-enhanced`. */
const name = "plan-mode-enhanced";

/** Services required before the bridge can observe and switch state. */
const inject = ["agents", "planMode", "permissionPresets"];

/**
 * Install the bridge.
 * @param ctx - Cordis plugin context.
 */
function apply(ctx) {
	/** sessionId -> the preset that was effective before plan-mode was picked. */
	const previous = new Map();

	// The plugin context's event bus differs from the bus session append
	// broadcasts on, so listen on ctx.root.
	//
	// Session append publishes listeners synchronously while the append lock is
	// held; calling `planMode.set` / `permissionPresets.set` (both append more
	// session events) from inside that dispatch reenters the append and is
	// rejected ("session append cannot reenter"). Defer every write to the
	// next macrotask, after the publishing append has fully unwound.
	ctx.root.on("session/event", (session, event) => {
		try {
			if (event.type === "permission/preset") {
				if (event.data.preset === PLAN_PRESET) {
					if (!previous.has(session.id)) {
						previous.set(session.id, presetBefore(session, ctx));
					}
					setImmediate(() => {
						const agent = ctx.agents.get(session.id);
						if (agent !== void 0) ctx.planMode.set(agent, true);
					});
				} else {
					previous.delete(session.id);
					setImmediate(() => {
						const agent = ctx.agents.get(session.id);
						if (agent !== void 0) ctx.planMode.set(agent, false);
					});
				}
				return;
			}
			if (event.type === "plan/mode" && event.data.active === false) {
				// Plan mode was left through /plan off or exit_plan_mode while
				// the plan-mode permission preset is still current: restore the
				// preset that was active before the plan-mode switch.
				const agent = ctx.agents.get(session.id);
				if (agent === void 0) return;
				if (ctx.permissionPresets.current(session.events) !== PLAN_PRESET) return;
				const prior = previous.get(session.id);
				previous.delete(session.id);
				if (prior !== void 0 && ctx.permissionPresets.names.includes(prior)) {
					setImmediate(() => ctx.permissionPresets.set(session, prior));
				}
			}
		} catch (error) {
			ctx.logger.warn("plan-mode-enhanced: %o", error);
		}
	}, { global: true });
}

/**
 * The preset effective just before the just-appended `permission/preset`
 * event. The listener runs synchronously after the append, so the new event
 * is the tail of the snapshot; folding the prefix yields the state the user
 * switched away from.
 * @param session - the session that switched.
 * @param ctx - plugin context for the permission-presets fold.
 * @returns the prior preset name.
 */
function presetBefore(session, ctx) {
	const events = session.events;
	const tail = events[events.length - 1];
	if (tail === void 0 || tail.type !== "permission/preset") {
		return ctx.permissionPresets.current(events);
	}
	return ctx.permissionPresets.current(events.slice(0, -1));
}

export { apply, inject, name };
