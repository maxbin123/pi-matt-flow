import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFlowExtension } from "@kky42/pi-flow";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const STATE_ENTRY = "matt-flow-state";
const STATUS_KEY = "matt-flow";
const WIDGET_KEY = "matt-flow-tickets";

type Route = "main" | "wayfinder";
type GrillMode = "grill-with-docs" | "grill-me";
type AgentBackend = "pi" | "codex" | "claude";
type Phase =
	| "setup"
	| "grill"
	| "wayfinder-chart"
	| "wayfinder-work"
	| "spec"
	| "tickets"
	| "implement"
	| "review"
	| "paused"
	| "done"
	| "cancelled";

type TicketStatus = "pending" | "active" | "done";

interface Ticket {
	id: string;
	title: string;
	blockedBy: string[];
	status: TicketStatus;
	baseline?: string;
	commit?: string;
}

interface FlowState {
	version: 2;
	flowId: string;
	goal: string;
	repoRoot: string;
	route: Route;
	grillMode: GrillMode;
	implementationBackend: AgentBackend;
	standardsReviewBackend: AgentBackend;
	specReviewBackend: AgentBackend;
	phase: Phase;
	resumePhase?: Exclude<Phase, "paused" | "done" | "cancelled">;
	baseRef: string;
	mapRef?: string;
	specRef?: string;
	tickets: Ticket[];
	activeTicketId?: string;
	startedAt: string;
	updatedAt: string;
}

interface FlowToolDetails {
	state: FlowState;
}

interface ParsedStartArgs {
	route?: Route;
	grillMode?: GrillMode;
	implementationBackend?: AgentBackend;
	reviewMode?: AgentBackend | "cross";
	standardsReviewBackend?: AgentBackend;
	specReviewBackend?: AgentBackend;
	goal: string;
}

function cloneState(state: FlowState): FlowState {
	return JSON.parse(JSON.stringify(state)) as FlowState;
}

function phaseLabel(phase: Phase): string {
	return phase.replaceAll("-", " ");
}

function parseBackend(value: string | undefined): AgentBackend | undefined {
	return value === "pi" || value === "codex" || value === "claude" ? value : undefined;
}

function parseStartArgs(raw: string): ParsedStartArgs {
	const tokens = (raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
		token.replace(/^("|')|("|')$/g, ""),
	);
	const goal: string[] = [];
	let route: Route | undefined;
	let grillMode: GrillMode | undefined;
	let implementationBackend: AgentBackend | undefined;
	let reviewMode: AgentBackend | "cross" | undefined;
	let standardsReviewBackend: AgentBackend | undefined;
	let specReviewBackend: AgentBackend | undefined;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const [flag, inlineValue] = token.split("=", 2);
		switch (flag) {
			case "--wayfinder":
				route = "wayfinder";
				break;
			case "--main":
				route = "main";
				break;
			case "--docs":
				grillMode = "grill-with-docs";
				break;
			case "--grill-me":
				grillMode = "grill-me";
				break;
			case "--implement-with": {
				const value = inlineValue ?? tokens[++index];
				implementationBackend = parseBackend(value);
				if (!implementationBackend) throw new Error(`Invalid --implement-with value: ${value ?? "missing"}`);
				break;
			}
			case "--review-with": {
				const value = inlineValue ?? tokens[++index];
				reviewMode = value === "cross" ? "cross" : parseBackend(value);
				if (!reviewMode) throw new Error(`Invalid --review-with value: ${value ?? "missing"}`);
				break;
			}
			case "--standards-review-with": {
				const value = inlineValue ?? tokens[++index];
				standardsReviewBackend = parseBackend(value);
				if (!standardsReviewBackend) throw new Error(`Invalid --standards-review-with value: ${value ?? "missing"}`);
				break;
			}
			case "--spec-review-with": {
				const value = inlineValue ?? tokens[++index];
				specReviewBackend = parseBackend(value);
				if (!specReviewBackend) throw new Error(`Invalid --spec-review-with value: ${value ?? "missing"}`);
				break;
			}
			default:
				goal.push(token);
		}
	}

	return {
		route,
		grillMode,
		implementationBackend,
		reviewMode,
		standardsReviewBackend,
		specReviewBackend,
		goal: goal.join(" ").trim(),
	};
}

interface BackendInfo {
	label: string;
	command?: string;
	model?: string;
	implementationProfile?: string;
	reviewProfile: string;
}

const BACKENDS: Record<AgentBackend, BackendInfo> = {
	pi: {
		label: "Pi",
		reviewProfile: "matt-pi-reviewer",
	},
	codex: {
		label: "Codex CLI",
		command: "codex",
		implementationProfile: "matt-codex-implementer",
		reviewProfile: "matt-codex-reviewer",
	},
	claude: {
		label: "Claude Code",
		command: "claude",
		model: "sonnet",
		implementationProfile: "matt-claude-implementer",
		reviewProfile: "matt-claude-reviewer",
	},
};

const IMPLEMENTER_ROLE = "You are the implementation specialist in a Matt Flow. Work only on the ticket in the task briefing. Inspect the repository and tracker context, implement test-first at the stated seams, and run the requested checks. Commit and update the tracker only when the coordinator's task explicitly asks you to. Do not delegate. Do not broaden scope. Report changes, tests, commits, and blockers precisely.";
const REVIEWER_ROLE = "Act only as a read-only reviewer. Never edit files, commit, or fix findings. Follow the supplied review-axis brief exactly, cite concrete evidence, and return concise findings to the coordinator.";

function buildProfile(backend: Exclude<AgentBackend, "pi">, role: "implementer" | "reviewer"): [string, string] {
	const info = BACKENDS[backend];
	const name = role === "implementer" ? info.implementationProfile! : info.reviewProfile;
	const description = role === "implementer"
		? `${info.label} implementation specialist for one Matt Flow ticket, including tests and commits.`
		: `Independent read-only ${info.label} reviewer for a Standards or Spec review axis.`;
	const model = info.model ? `\nmodel: ${info.model}` : "";
	return [
		name,
		`---\ndescription: ${description}\nbackend: ${backend}${model}\nthinking: high\n---\n${role === "implementer" ? IMPLEMENTER_ROLE : REVIEWER_ROLE}`,
	];
}

const MATT_PROFILES: Record<string, string> = Object.fromEntries([
	[
		"matt-pi-reviewer",
		`---\ndescription: Independent read-only Pi reviewer for a Standards or Spec review axis.\nbackend: pi\ntools: read, bash, grep, find, ls\nthinking: high\n---\n${REVIEWER_ROLE}`,
	],
	...(["codex", "claude"] as const).flatMap((backend) => [
		buildProfile(backend, "implementer"),
		buildProfile(backend, "reviewer"),
	]),
]);

function installMattProfiles(): string[] {
	const profileDir = join(getAgentDir(), "subagents");
	mkdirSync(profileDir, { recursive: true });
	const installed: string[] = [];
	for (const [name, content] of Object.entries(MATT_PROFILES)) {
		const path = join(profileDir, `${name}.md`);
		if (existsSync(path)) continue;
		writeFileSync(path, `${content.trim()}\n`, "utf8");
		installed.push(name);
	}
	return installed;
}

function requiredSkills(state: Pick<FlowState, "route" | "grillMode">): string[] {
	const skills = [
		"setup-matt-pocock-skills",
		state.grillMode,
		"to-spec",
		"to-tickets",
		"implement",
		"code-review",
	];
	if (state.route === "wayfinder") skills.push("wayfinder", "research");
	return skills;
}

function skillIsAvailable(pi: ExtensionAPI, skill: string): boolean {
	return pi.getCommands().some((command) => command.source === "skill" && command.name === `skill:${skill}`);
}

function ticketById(state: FlowState, id: string | undefined): Ticket | undefined {
	return id ? state.tickets.find((ticket) => ticket.id === id) : undefined;
}

function nextTicket(state: FlowState): Ticket | undefined {
	return state.tickets.find(
		(ticket) =>
			ticket.status === "pending" &&
			ticket.blockedBy.every((blocker) => ticketById(state, blocker)?.status === "done"),
	);
}

function formatState(state: FlowState): string {
	const lines = [
		`Matt flow ${state.flowId}`,
		`Phase: ${phaseLabel(state.phase)}`,
		`Route: ${state.route}`,
		`Goal: ${state.goal}`,
		`Implementation: ${state.implementationBackend}`,
		`Review: Standards=${state.standardsReviewBackend}, Spec=${state.specReviewBackend}`,
	];
	if (state.mapRef) lines.push(`Map: ${state.mapRef}`);
	if (state.specRef) lines.push(`Spec: ${state.specRef}`);
	if (state.tickets.length > 0) {
		const done = state.tickets.filter((ticket) => ticket.status === "done").length;
		lines.push(`Tickets: ${done}/${state.tickets.length}`);
		for (const ticket of state.tickets) {
			const marker = ticket.status === "done" ? "✓" : ticket.status === "active" ? "▶" : "○";
			lines.push(`${marker} ${ticket.id} — ${ticket.title}`);
		}
	}
	return lines.join("\n");
}

function updateUi(state: FlowState | undefined, ctx: ExtensionContext): void {
	if (!state || state.phase === "done" || state.phase === "cancelled") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const done = state.tickets.filter((ticket) => ticket.status === "done").length;
	const progress = state.tickets.length > 0 ? ` ${done}/${state.tickets.length}` : "";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `matt:${state.phase}${progress}`));

	if (state.tickets.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const lines = state.tickets.slice(0, 8).map((ticket) => {
		if (ticket.status === "done") {
			return `${ctx.ui.theme.fg("success", "✓")} ${ctx.ui.theme.fg("muted", ticket.title)}`;
		}
		if (ticket.status === "active") {
			return `${ctx.ui.theme.fg("accent", "▶")} ${ticket.title} ${ctx.ui.theme.fg("dim", `(${ticket.id})`)}`;
		}
		return `${ctx.ui.theme.fg("dim", "○")} ${ticket.title}`;
	});
	if (state.tickets.length > 8) lines.push(ctx.ui.theme.fg("dim", `… ${state.tickets.length - 8} more`));
	ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
}

function reviewRoutingInstructions(state: FlowState): string {
	return `When /code-review delegates its two independent axes, use Agent subagent_type "${BACKENDS[state.standardsReviewBackend].reviewProfile}" for Standards and "${BACKENDS[state.specReviewBackend].reviewProfile}" for Spec. Omit session_key for both so their contexts remain fresh and isolated. Launch both Agent calls in the same assistant response.`;
}

function flowInstructions(state: FlowState): string {
	const ticket = ticketById(state, state.activeTicketId);
	const common = `

This is controlled by the active Matt flow (${state.flowId}). Use the installed skill exactly as written, including its human checkpoints. Do not silently move to another phase. Use the matt_flow tool only after the current phase's completion conditions are genuinely met.`;

	switch (state.phase) {
		case "setup":
			return `/skill:setup-matt-pocock-skills\n\nConfigure this repository for the flow. After the user approves and the setup files have been written, call matt_flow with action "phase_complete".${common}`;
		case "grill":
			return `/skill:${state.grillMode} ${state.goal}\n\nDo not call phase_complete until the user explicitly confirms shared understanding.${common}`;
		case "wayfinder-chart":
			return `/skill:wayfinder ${state.goal}\n\nChart the map only. Follow Wayfinder's stop condition. Once the map and currently specifiable decision tickets are published and research agents have been dispatched where possible, call matt_flow with action "wayfinder_charted" and artifact set to the canonical map URL/id/path.${common}`;
		case "wayfinder-work":
			return `/skill:wayfinder ${state.mapRef ?? ""}\n\nResolve at most one decision ticket in this fresh session. After recording its resolution, closing it, updating the map, and creating/wiring newly visible tickets, call matt_flow with action "wayfinder_ticket_resolved", artifact set to the resolved ticket, and mapComplete=true only when the route to the destination is clear with no unresolved decision work or fog. If no frontier ticket is currently available, call matt_flow with action "pause" and explain why.${common}`;
		case "spec":
			return `/skill:to-spec ${state.mapRef ? `Use the completed Wayfinder map ${state.mapRef} and its linked decisions as the source.` : "Synthesize the shared understanding from this conversation."}\n\nAfter the spec is published to the configured tracker, call matt_flow with action "phase_complete" and artifact set to its canonical URL/id/path.${common}`;
		case "tickets":
			return `/skill:to-tickets ${state.specRef ?? ""}\n\nAfter the user approves the breakdown and every ticket is published, call matt_flow with action "tickets_created". Supply every created ticket in dependency order with its canonical id/path, title, and blockedBy containing exact ids from the same list. Do not include the parent spec as a ticket.${common}`;
		case "implement": {
			if (!ticket) throw new Error("The implementation phase has no active ticket");
			const implementer = BACKENDS[state.implementationBackend].implementationProfile;
			const execution = implementer
				? `Delegate all implementation edits to Agent subagent_type "${implementer}" with session_key "${state.flowId}-${ticket.id}-implementation". Give the first call a self-contained briefing containing the complete ticket, fixed point ${ticket.baseline}, acceptance criteria, agreed seams, TDD requirement, and focused verification commands; explicitly tell it not to commit or update the tracker yet. The coordinator must inspect the resulting diff and run the independent review axes. Then continue the same session_key with all valid findings (or confirmation that none were found), asking it to fix findings, run the full suite, commit, and update/close the tracker ticket. The coordinator verifies the final diff, commit, tracker state, and clean worktree; it must not duplicate the implementation itself.`
				: "Implement directly in this fresh Pi coordinator session.";
			return `/skill:implement ${ticket.id}\n\nImplement only this ticket: ${ticket.title}. Fetch its complete tracker body and comments. ${execution} Its fixed review point is ${ticket.baseline}. Use TDD at the agreed seams, run focused checks regularly, then the full suite. ${reviewRoutingInstructions(state)} Run /code-review against ${ticket.baseline}, fix every valid Standards and Spec finding, and re-check. Commit the finished work, close/update the ticket in the configured tracker so blockers can advance, ensure the worktree is clean, then call matt_flow with action "ticket_implemented", ticketId "${ticket.id}", and commitSha set to HEAD. Do not begin another ticket in this session.${common}`;
		}
		case "review": {
			const implementer = BACKENDS[state.implementationBackend].implementationProfile;
			const fixes = implementer
				? `Delegate integration fixes to Agent subagent_type "${implementer}" with session_key "${state.flowId}-integration-fixes", then verify its diff and commits.`
				: "Apply integration fixes directly in this coordinator session.";
			return `/skill:code-review ${state.baseRef}\n\nThis is the final integration review for the entire flow. Use spec ${state.specRef ?? "(discover from the tickets)"} and tickets ${state.tickets.map((item) => item.id).join(", ")}. ${reviewRoutingInstructions(state)} Review the diff from ${state.baseRef} through HEAD on both axes. ${fixes} Fix every valid finding, run the full verification suite, commit fixes, and repeat the two-axis review until no actionable findings remain. Ensure the worktree is clean, then call matt_flow with action "review_complete" and a concise summary.${common}`;
		}
		default:
			throw new Error(`No kickoff exists for phase ${state.phase}`);
	}
}

function activePhaseInstructions(state: FlowState): string {
	const ticket = ticketById(state, state.activeTicketId);
	return `[MATT FLOW ACTIVE]
Flow id: ${state.flowId}
Current phase: ${state.phase}
Route: ${state.route}
Goal: ${state.goal}
Implementation backend: ${state.implementationBackend}
Review backends: Standards=${state.standardsReviewBackend}, Spec=${state.specReviewBackend}
${state.specRef ? `Spec: ${state.specRef}\n` : ""}${ticket ? `Active ticket: ${ticket.id} — ${ticket.title}\nTicket fixed point: ${ticket.baseline}\n` : ""}
Rules:
- Follow the current Matt skill and all of its user-confirmation gates.
- ${reviewRoutingInstructions(state)}
- When an external implementation Agent is configured, let it make the edits; the coordinator verifies, reviews, and advances the flow.
- Stay in the current phase; never start a later phase or another implementation ticket yourself.
- Report durable tracker identifiers to matt_flow rather than merely mentioning them in prose.
- A ticket is not implemented until review findings are fixed, tests pass, it is committed, its tracker status is updated, and the worktree is clean.
- If blocked, call matt_flow action "pause" with a reason instead of pretending the phase completed.`;
}

export default function mattFlowExtension(pi: ExtensionAPI): void {
	// pi-flow owns the subagent seam: Agent, multi-backend profiles, concurrency,
	// session_key continuation, telemetry, and rendering. Matt Flow intentionally
	// keeps pi-flow's dynamic workflow tool disabled: its own human-gated state
	// machine is the orchestration interface.
	createFlowExtension({ workflow: false })(pi);

	let state: FlowState | undefined;
	const reviewWorktreeFingerprints = new Map<string, { cwd: string; fingerprint: string }>();

	const persist = (ctx?: ExtensionContext) => {
		if (!state) return;
		state.updatedAt = new Date().toISOString();
		pi.appendEntry(STATE_ENTRY, cloneState(state));
		if (ctx) updateUi(state, ctx);
	};

	const restore = (ctx: ExtensionContext) => {
		const entry = ctx.sessionManager
			.getBranch()
			.filter((item) => item.type === "custom" && item.customType === STATE_ENTRY)
			.pop() as { data?: FlowState } | undefined;
		if (entry?.data) {
			const restored = cloneState(entry.data);
			state = {
				...restored,
				version: 2,
				implementationBackend: restored.implementationBackend ?? "pi",
				standardsReviewBackend: restored.standardsReviewBackend ?? "pi",
				specReviewBackend: restored.specReviewBackend ?? "pi",
			};
		} else {
			state = undefined;
		}
		updateUi(state, ctx);
	};

	const queueAdvanceCommand = () => {
		pi.sendUserMessage("/matt-flow-advance", { deliverAs: "followUp" });
	};

	const queueCurrentKickoff = () => {
		if (!state) throw new Error("No active Matt flow");
		pi.sendUserMessage(flowInstructions(state), { deliverAs: "followUp" });
	};

	const assertCleanWorktree = async (ctx: ExtensionContext): Promise<void> => {
		if (!state) throw new Error("No active Matt flow");
		const result = await pi.exec("git", ["-C", state.repoRoot, "status", "--porcelain"], { signal: ctx.signal });
		if (result.code !== 0) throw new Error(result.stderr || "Unable to inspect git worktree");
		if (result.stdout.trim()) {
			throw new Error("The worktree is not clean. Finish, test, and commit the current phase before advancing.\n" + result.stdout);
		}
	};

	const resolveHead = async (): Promise<string> => {
		if (!state) throw new Error("No active Matt flow");
		const result = await pi.exec("git", ["-C", state.repoRoot, "rev-parse", "HEAD"]);
		if (result.code !== 0) throw new Error(result.stderr || "Unable to resolve HEAD");
		return result.stdout.trim();
	};

	const fingerprintWorktree = async (cwd: string): Promise<string> => {
		const [head, diff, untracked] = await Promise.all([
			pi.exec("git", ["-C", cwd, "rev-parse", "HEAD"]),
			pi.exec("git", ["-C", cwd, "diff", "HEAD", "--binary", "--no-ext-diff"]),
			pi.exec("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"]),
		]);
		if (head.code !== 0 || diff.code !== 0 || untracked.code !== 0) {
			throw new Error(head.stderr || diff.stderr || untracked.stderr || "Unable to fingerprint the review worktree");
		}
		const hash = createHash("sha256").update(head.stdout).update("\0").update(diff.stdout);
		const paths = untracked.stdout.split("\0").filter(Boolean).sort();
		for (const relativePath of paths) {
			hash.update("\0").update(relativePath).update("\0");
			try {
				hash.update(readFileSync(join(cwd, relativePath)));
			} catch {
				hash.update("<unreadable-or-removed>");
			}
		}
		return hash.digest("hex");
	};

	const startFreshPhase = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!state) throw new Error("No active Matt flow");

		if (state.phase === "implement") {
			let ticket = ticketById(state, state.activeTicketId);
			if (!ticket) {
				ticket = nextTicket(state);
				if (!ticket) {
					const remaining = state.tickets.filter((item) => item.status !== "done");
					if (remaining.length > 0) {
						throw new Error(`No ticket is on the frontier. Check blocking ids for: ${remaining.map((item) => item.id).join(", ")}`);
					}
					state.phase = "review";
				} else {
					ticket.status = "active";
					ticket.baseline = await resolveHead();
					state.activeTicketId = ticket.id;
				}
			}
		}

		const kickoff = flowInstructions(state);
		const snapshot = cloneState(state);
		const parentSession = ctx.sessionManager.getSessionFile();
		const sessionName = `matt:${state.phase}${state.activeTicketId ? ` ${state.activeTicketId}` : ""}`;
		persist(ctx);

		const result = await ctx.newSession({
			parentSession,
			setup: async (sessionManager) => {
				sessionManager.appendCustomEntry(STATE_ENTRY, snapshot);
				sessionManager.appendSessionInfo(sessionName);
			},
			withSession: async (newCtx) => {
				await newCtx.sendUserMessage(kickoff);
			},
		});
		if (result.cancelled) ctx.ui.notify("Matt flow session transition was cancelled", "warning");
	};

	const TicketInput = Type.Object({
		id: Type.String({ description: "Canonical tracker id, URL, or local ticket path" }),
		title: Type.String(),
		blockedBy: Type.Optional(Type.Array(Type.String({ description: "Exact id of another ticket in this list" }))),
	});

	pi.registerTool({
		name: "matt_flow",
		label: "Matt Flow",
		description: "Report durable milestones to the active Matt idea-to-ship workflow. Never call a completion action before the current skill's human gates and deliverables are complete.",
		promptSnippet: "Advance or inspect the active Matt idea-to-ship workflow",
		parameters: Type.Object({
			action: StringEnum([
				"status",
				"phase_complete",
				"tickets_created",
				"ticket_implemented",
				"wayfinder_charted",
				"wayfinder_ticket_resolved",
				"review_complete",
				"pause",
			] as const),
			artifact: Type.Optional(Type.String({ description: "Canonical spec, map, or resolved-ticket reference" })),
			tickets: Type.Optional(Type.Array(TicketInput)),
			ticketId: Type.Optional(Type.String()),
			commitSha: Type.Optional(Type.String()),
			mapComplete: Type.Optional(Type.Boolean()),
			summary: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) throw new Error("No active Matt flow. Start one with /matt-flow <idea>.");

			switch (params.action) {
				case "status":
					return { content: [{ type: "text", text: formatState(state) }], details: { state: cloneState(state) } as FlowToolDetails };

				case "phase_complete":
					if (state.phase === "setup") {
						if (!existsSync(join(state.repoRoot, "docs", "agents", "issue-tracker.md"))) {
							throw new Error("Setup is not complete: docs/agents/issue-tracker.md is missing");
						}
						state.phase = state.route === "wayfinder" ? "wayfinder-chart" : "grill";
					} else if (state.phase === "grill") {
						state.phase = "spec";
					} else if (state.phase === "spec") {
						if (!params.artifact?.trim()) throw new Error("phase_complete for spec requires artifact with the published spec reference");
						state.specRef = params.artifact.trim();
						state.phase = "tickets";
					} else {
						throw new Error(`phase_complete is not valid during ${state.phase}`);
					}
					persist(ctx);
					queueCurrentKickoff();
					break;

				case "tickets_created": {
					if (state.phase !== "tickets") throw new Error(`tickets_created is not valid during ${state.phase}`);
					if (!params.tickets?.length) throw new Error("tickets_created requires at least one ticket");
					const ids = new Set(params.tickets.map((ticket) => ticket.id.trim()));
					if (ids.size !== params.tickets.length || ids.has("")) throw new Error("Ticket ids must be non-empty and unique");
					for (const ticket of params.tickets) {
						for (const blocker of ticket.blockedBy ?? []) {
							if (!ids.has(blocker)) throw new Error(`Ticket ${ticket.id} has unknown blocker ${blocker}; use exact ids from this ticket list`);
							if (blocker === ticket.id) throw new Error(`Ticket ${ticket.id} cannot block itself`);
						}
					}
					state.tickets = params.tickets.map((ticket) => ({
						id: ticket.id.trim(),
						title: ticket.title.trim(),
						blockedBy: [...(ticket.blockedBy ?? [])],
						status: "pending" as const,
					}));
					state.phase = "implement";
					persist(ctx);
					queueAdvanceCommand();
					break;
				}

				case "ticket_implemented": {
					if (state.phase !== "implement") throw new Error(`ticket_implemented is not valid during ${state.phase}`);
					const active = ticketById(state, state.activeTicketId);
					if (!active) throw new Error("There is no active ticket");
					if (params.ticketId !== active.id) throw new Error(`Expected active ticket ${active.id}, received ${params.ticketId ?? "none"}`);
					await assertCleanWorktree(ctx);
					const head = await resolveHead();
					if (params.commitSha && params.commitSha !== head) throw new Error(`commitSha ${params.commitSha} is not current HEAD ${head}`);
					if (active.baseline === head) throw new Error("HEAD did not change; the ticket has no implementation commit");
					active.status = "done";
					active.commit = head;
					state.activeTicketId = undefined;
					persist(ctx);
					queueAdvanceCommand();
					break;
				}

				case "wayfinder_charted":
					if (state.phase !== "wayfinder-chart") throw new Error(`wayfinder_charted is not valid during ${state.phase}`);
					if (!params.artifact?.trim()) throw new Error("wayfinder_charted requires the map reference in artifact");
					state.mapRef = params.artifact.trim();
					state.phase = "wayfinder-work";
					persist(ctx);
					queueAdvanceCommand();
					break;

				case "wayfinder_ticket_resolved":
					if (state.phase !== "wayfinder-work") throw new Error(`wayfinder_ticket_resolved is not valid during ${state.phase}`);
					state.phase = params.mapComplete ? "spec" : "wayfinder-work";
					persist(ctx);
					queueAdvanceCommand();
					break;

				case "review_complete":
					if (state.phase !== "review") throw new Error(`review_complete is not valid during ${state.phase}`);
					await assertCleanWorktree(ctx);
					state.phase = "done";
					persist(ctx);
					ctx.ui.notify("Matt flow complete", "info");
					break;

				case "pause":
					if (state.phase === "paused" || state.phase === "done" || state.phase === "cancelled") {
						throw new Error(`Cannot pause during ${state.phase}`);
					}
					state.resumePhase = state.phase;
					state.phase = "paused";
					persist(ctx);
					ctx.ui.notify(params.summary?.trim() || "Matt flow paused", "warning");
					break;
			}

			return {
				content: [{ type: "text", text: `Recorded ${params.action}. Current phase: ${state.phase}` }],
				details: { state: cloneState(state) } as FlowToolDetails,
			};
		},
	});

	pi.registerCommand("matt-flow", {
		description: "Start Matt's idea-to-ship flow (grill → spec → tickets → fresh implementation sessions → review)",
		handler: async (rawArgs, ctx) => {
			if (state && !["done", "cancelled"].includes(state.phase)) {
				const replace = ctx.hasUI && (await ctx.ui.confirm("Replace active Matt flow?", formatState(state)));
				if (!replace) return;
			}

			let parsed: ParsedStartArgs;
			try {
				parsed = parseStartArgs(rawArgs);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const rootResult = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]);
			if (rootResult.code !== 0) {
				ctx.ui.notify("Matt's ship flow must be started inside a git repository", "error");
				return;
			}
			const repoRoot = rootResult.stdout.trim();

			let goal = parsed.goal;
			if (!goal && ctx.hasUI) goal = (await ctx.ui.editor("What idea should this flow take to shipped code?", ""))?.trim() ?? "";
			if (!goal) {
				ctx.ui.notify(
					"Usage: /matt-flow [--main|--wayfinder] [--docs|--grill-me] [--implement-with pi|codex|claude] [--review-with pi|codex|claude|cross] [--standards-review-with pi|codex|claude] [--spec-review-with pi|codex|claude] <idea>",
					"warning",
				);
				return;
			}

			let route = parsed.route;
			if (!route && ctx.hasUI) {
				const choice = await ctx.ui.select("Choose the Ask Matt route", [
					"Main flow — scoped feature that can be understood in one planning session (recommended)",
					"Wayfinder — huge/foggy effort requiring decision tickets across sessions",
				]);
				if (!choice) return;
				route = choice.startsWith("Wayfinder") ? "wayfinder" : "main";
			}
			route ??= "main";

			let grillMode = parsed.grillMode;
			if (route === "main" && !grillMode && ctx.hasUI) {
				const choice = await ctx.ui.select("Choose the grilling on-ramp", [
					"grill-with-docs — retain domain language and ADRs in this codebase (recommended)",
					"grill-me — interview only, without domain docs",
				]);
				if (!choice) return;
				grillMode = choice.startsWith("grill-me") ? "grill-me" : "grill-with-docs";
			}
			grillMode ??= "grill-with-docs";

			let implementationBackend = parsed.implementationBackend;
			if (!implementationBackend && ctx.hasUI) {
				const options: Array<[AgentBackend, string]> = [
					["pi", "Pi coordinator — implement directly in each fresh session (recommended)"],
					["codex", "Codex CLI — delegate edits through pi-flow"],
					["claude", "Claude Code — delegate edits through pi-flow"],
				];
				const choice = await ctx.ui.select("Who should implement each ticket?", options.map(([, label]) => label));
				if (!choice) return;
				implementationBackend = options.find(([, label]) => label === choice)?.[0];
			}
			implementationBackend ??= "pi";

			let reviewMode = parsed.reviewMode;
			if (!reviewMode && !parsed.standardsReviewBackend && !parsed.specReviewBackend && ctx.hasUI) {
				const options: Array<[AgentBackend | "cross", string]> = [
					["cross", "Cross review — Codex for Standards, Claude for Spec (recommended)"],
					["pi", "Pi subagents — Pi for both axes"],
					["codex", "Codex CLI — Codex for both axes"],
					["claude", "Claude Code — Claude for both axes"],
				];
				const choice = await ctx.ui.select("Who should run the independent review axes?", options.map(([, label]) => label));
				if (!choice) return;
				reviewMode = options.find(([, label]) => label === choice)?.[0];
			}
			reviewMode ??= "pi";
			const standardsReviewBackend: AgentBackend = parsed.standardsReviewBackend ?? (reviewMode === "cross" ? "codex" : reviewMode);
			const specReviewBackend: AgentBackend = parsed.specReviewBackend ?? (reviewMode === "cross" ? "claude" : reviewMode);

			const installedProfiles = installMattProfiles();
			if (installedProfiles.length > 0) {
				ctx.ui.notify(`Installed pi-flow profiles: ${installedProfiles.join(", ")}`, "info");
			}

			const externalBackends = new Set(
				[implementationBackend, standardsReviewBackend, specReviewBackend].filter(
					(backend): backend is Exclude<AgentBackend, "pi"> => backend !== "pi",
				),
			);
			for (const backend of externalBackends) {
				const info = BACKENDS[backend];
				const check = await pi.exec(info.command!, ["--version"]);
				if (check.code !== 0) {
					ctx.ui.notify(`${info.label} is not available on PATH`, "error");
					return;
				}
			}
			if (externalBackends.size > 0) {
				ctx.ui.notify(
					"External pi-flow backends bypass normal approval/sandbox prompts. Continue only in a trusted repository.",
					"warning",
				);
			}

			const headResult = await pi.exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
			if (headResult.code !== 0) {
				ctx.ui.notify("The repository needs an initial commit before this workflow can review fixed-point diffs", "error");
				return;
			}

			const candidate = { route, grillMode };
			const missing = requiredSkills(candidate).filter((skill) => !skillIsAvailable(pi, skill));
			if (missing.length > 0) {
				const researchHint = missing.includes("research") ? " Run /matt-flow-install-research to install it globally." : "";
				ctx.ui.notify(`Missing required skills: ${missing.join(", ")}.${researchHint}`, "error");
				return;
			}

			const setupExists = existsSync(join(repoRoot, "docs", "agents", "issue-tracker.md"));
			const now = new Date().toISOString();
			state = {
				version: 2,
				flowId: Math.random().toString(36).slice(2, 8),
				goal,
				repoRoot,
				route,
				grillMode,
				implementationBackend,
				standardsReviewBackend,
				specReviewBackend,
				phase: setupExists ? (route === "wayfinder" ? "wayfinder-chart" : "grill") : "setup",
				baseRef: headResult.stdout.trim(),
				tickets: [],
				startedAt: now,
				updatedAt: now,
			};
			pi.setSessionName(`matt:${state.phase} ${goal.slice(0, 50)}`);
			persist(ctx);
			pi.sendUserMessage(flowInstructions(state));
		},
	});

	pi.registerCommand("matt-flow-install-research", {
		description: "Install Matt Pocock's research skill globally and reload pi resources",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Installing Matt's research skill…", "info");
			const result = await pi.exec(
				"npx",
				["--yes", "skills", "add", "mattpocock/skills", "--global", "--skill", "research", "--agent", "*", "--yes"],
				{ timeout: 120_000 },
			);
			if (result.code !== 0) {
				ctx.ui.notify(result.stderr.trim() || "Research skill installation failed", "error");
				return;
			}
			ctx.ui.notify("Research skill installed; reloading pi resources", "info");
			await ctx.reload();
			return;
		},
	});

	pi.registerCommand("matt-flow-install-profiles", {
		description: "Install the bundled Pi, Codex, and Claude pi-flow profiles without overwriting existing profiles",
		handler: async (_args, ctx) => {
			const installed = installMattProfiles();
			ctx.ui.notify(
				installed.length > 0 ? `Installed pi-flow profiles: ${installed.join(", ")}` : "Matt pi-flow profiles are already installed",
				"info",
			);
		},
	});

	pi.registerCommand("matt-flow-status", {
		description: "Show the active Matt workflow state and captured ticket ids",
		handler: async (_args, ctx) => {
			ctx.ui.notify(state ? formatState(state) : "No Matt flow in this session", "info");
		},
	});

	pi.registerCommand("matt-flow-resume", {
		description: "Resume a paused Matt workflow",
		handler: async (_args, ctx) => {
			if (!state) return ctx.ui.notify("No Matt flow in this session", "warning");
			if (state.phase !== "paused" || !state.resumePhase) {
				return ctx.ui.notify(`Flow is ${state.phase}, not paused`, "warning");
			}
			state.phase = state.resumePhase;
			state.resumePhase = undefined;
			persist(ctx);
			if (["wayfinder-work", "implement", "review"].includes(state.phase)) await startFreshPhase(ctx);
			else pi.sendUserMessage(flowInstructions(state));
		},
	});

	pi.registerCommand("matt-flow-cancel", {
		description: "Cancel the active Matt workflow without changing tracker artifacts or git history",
		handler: async (_args, ctx) => {
			if (!state) return ctx.ui.notify("No Matt flow in this session", "warning");
			if (ctx.hasUI && !(await ctx.ui.confirm("Cancel Matt flow?", formatState(state)))) return;
			state.phase = "cancelled";
			state.resumePhase = undefined;
			persist(ctx);
			ctx.ui.notify("Matt flow cancelled", "info");
		},
	});

	pi.registerCommand("matt-flow-advance", {
		description: "Internal: continue the Matt workflow in a fresh session",
		handler: async (_args, ctx) => {
			if (!state) return ctx.ui.notify("No Matt flow in this session", "warning");
			if (!["wayfinder-work", "spec", "implement", "review"].includes(state.phase)) {
				return ctx.ui.notify(`Cannot start a fresh phase from ${state.phase}`, "warning");
			}
			await ctx.waitForIdle();
			await startFreshPhase(ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "Agent") return;
		const subagentType = (event.input as { subagent_type?: unknown }).subagent_type;
		if (!Object.values(BACKENDS).some((backend) => backend.reviewProfile === subagentType)) return;
		const rootResult = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]);
		if (rootResult.code !== 0) throw new Error(rootResult.stderr || "Unable to resolve the review repository root");
		const repoRoot = rootResult.stdout.trim();
		reviewWorktreeFingerprints.set(event.toolCallId, {
			cwd: repoRoot,
			fingerprint: await fingerprintWorktree(repoRoot),
		});
	});

	pi.on("tool_result", async (event) => {
		const baseline = reviewWorktreeFingerprints.get(event.toolCallId);
		if (!baseline) return;
		reviewWorktreeFingerprints.delete(event.toolCallId);
		const current = await fingerprintWorktree(baseline.cwd);
		if (current === baseline.fingerprint) return;
		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: "REVIEW SAFETY FAILURE: the worktree changed during this read-only review. Inspect and restore or intentionally incorporate the changes before advancing the Matt flow.",
				},
			],
			isError: true,
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!state || ["paused", "done", "cancelled"].includes(state.phase)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${activePhaseInstructions(state)}` };
	});

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
}
