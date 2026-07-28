import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const STATE_ENTRY = "matt-flow-state";
const STATUS_KEY = "matt-flow";
const WIDGET_KEY = "matt-flow-tickets";
const MAX_AGENT_OUTPUT_BYTES = 50 * 1024;

type Route = "main" | "wayfinder";
type GrillMode = "grill-with-docs" | "grill-me";
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
	version: 1;
	flowId: string;
	goal: string;
	repoRoot: string;
	route: Route;
	grillMode: GrillMode;
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
	goal: string;
}

function cloneState(state: FlowState): FlowState {
	return JSON.parse(JSON.stringify(state)) as FlowState;
}

function phaseLabel(phase: Phase): string {
	return phase.replaceAll("-", " ");
}

function parseStartArgs(raw: string): ParsedStartArgs {
	const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const goal: string[] = [];
	let route: Route | undefined;
	let grillMode: GrillMode | undefined;

	for (const rawToken of tokens) {
		const token = rawToken.replace(/^("|')|("|')$/g, "");
		switch (token) {
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
			default:
				goal.push(token);
		}
	}

	return { route, grillMode, goal: goal.join(" ").trim() };
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
	if (state.route === "wayfinder") skills.push("wayfinder");
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
		case "implement":
			if (!ticket) throw new Error("The implementation phase has no active ticket");
			return `/skill:implement ${ticket.id}\n\nImplement only this ticket: ${ticket.title}. Fetch its complete tracker body and comments. Its fixed review point is ${ticket.baseline}. Use TDD at the agreed seams, run focused checks regularly, then the full suite. Run /code-review against ${ticket.baseline}, fix every valid Standards and Spec finding, and re-check. Commit the finished work, close/update the ticket in the configured tracker so blockers can advance, ensure the worktree is clean, then call matt_flow with action "ticket_implemented", ticketId "${ticket.id}", and commitSha set to HEAD. Do not begin another ticket in this session.${common}`;
		case "review":
			return `/skill:code-review ${state.baseRef}\n\nThis is the final integration review for the entire flow. Use spec ${state.specRef ?? "(discover from the tickets)"} and tickets ${state.tickets.map((item) => item.id).join(", ")}. Review the diff from ${state.baseRef} through HEAD on both axes. Fix every valid finding, run the full verification suite, commit fixes, and repeat the two-axis review until no actionable findings remain. Ensure the worktree is clean, then call matt_flow with action "review_complete" and a concise summary.${common}`;
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
${state.specRef ? `Spec: ${state.specRef}\n` : ""}${ticket ? `Active ticket: ${ticket.id} — ${ticket.title}\nTicket fixed point: ${ticket.baseline}\n` : ""}
Rules:
- Follow the current Matt skill and all of its user-confirmation gates.
- Stay in the current phase; never start a later phase or another implementation ticket yourself.
- Report durable tracker identifiers to matt_flow rather than merely mentioning them in prose.
- A ticket is not implemented until review findings are fixed, tests pass, it is committed, its tracker status is updated, and the worktree is clean.
- If blocked, call matt_flow action "pause" with a reason instead of pretending the phase completed.`;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
	return `${text.slice(0, end)}\n\n[Agent output truncated to ${maxBytes} bytes]`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function runReviewAgent(
	prompt: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<string> {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--approve", "--tools", "read,bash"];
	if (ctx.model) args.push("--provider", ctx.model.provider, "--model", ctx.model.id);
	if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
	args.push(prompt);

	const invocation = getPiInvocation(args);
	return new Promise<string>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: ctx.cwd,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let stderr = "";
		let finalText = "";
		let aborted = false;

		const consumeLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; content?: string | Array<{ type?: string; text?: string }>; errorMessage?: string };
				};
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				if (typeof event.message.content === "string") finalText = event.message.content;
				else if (Array.isArray(event.message.content)) {
					const text = event.message.content
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => part.text)
						.join("\n");
					if (text) finalText = text;
				}
				if (event.message.errorMessage) stderr += `\n${event.message.errorMessage}`;
			} catch {
				// Ignore non-JSON diagnostics; pi's JSON mode is line-delimited.
			}
		};

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) consumeLine(line);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
			if (aborted) return reject(new Error("Agent sub-process was aborted"));
			if (code !== 0) return reject(new Error(`Agent exited with code ${code}: ${stderr.trim() || "no diagnostic"}`));
			if (!finalText.trim()) return reject(new Error(`Agent returned no final text: ${stderr.trim() || "no diagnostic"}`));
			resolve(truncateUtf8(finalText, MAX_AGENT_OUTPUT_BYTES));
		});

		const abort = () => {
			aborted = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

export default function mattFlowExtension(pi: ExtensionAPI): void {
	let state: FlowState | undefined;

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
		state = entry?.data ? cloneState(entry.data) : undefined;
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

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: "Run an isolated general-purpose sub-agent. Multiple Agent calls in one assistant message execute in parallel. Intended for Matt's code-review skill.",
		promptSnippet: "Run isolated general-purpose sub-agents for parallel review work",
		parameters: Type.Object({
			description: Type.Optional(Type.String({ description: "Short label for the delegated task" })),
			prompt: Type.String({ description: "Complete task instructions for the sub-agent" }),
			subagent_type: Type.Optional(Type.String({ description: "Agent type; general-purpose is supported" })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${params.description || params.subagent_type || "agent"}…` }],
				details: {},
			});
			const output = await runReviewAgent(params.prompt, ctx, signal);
			return { content: [{ type: "text", text: output }], details: { description: params.description } };
		},
	});

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

			const parsed = parseStartArgs(rawArgs);
			const rootResult = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]);
			if (rootResult.code !== 0) {
				ctx.ui.notify("Matt's ship flow must be started inside a git repository", "error");
				return;
			}
			const repoRoot = rootResult.stdout.trim();

			let goal = parsed.goal;
			if (!goal && ctx.hasUI) goal = (await ctx.ui.editor("What idea should this flow take to shipped code?", ""))?.trim() ?? "";
			if (!goal) {
				ctx.ui.notify("Usage: /matt-flow [--main|--wayfinder] [--docs|--grill-me] <idea>", "warning");
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

			const headResult = await pi.exec("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
			if (headResult.code !== 0) {
				ctx.ui.notify("The repository needs an initial commit before this workflow can review fixed-point diffs", "error");
				return;
			}

			const candidate = { route, grillMode };
			const missing = requiredSkills(candidate).filter((skill) => !skillIsAvailable(pi, skill));
			if (missing.length > 0) {
				ctx.ui.notify(`Missing required skills: ${missing.join(", ")}`, "error");
				return;
			}
			if (route === "wayfinder" && !skillIsAvailable(pi, "research")) {
				ctx.ui.notify(
					"The optional /research skill is not installed. Wayfinder can still chart and resolve non-research tickets, but research tickets must be handled manually or after installing that skill.",
					"warning",
				);
			}

			const setupExists = existsSync(join(repoRoot, "docs", "agents", "issue-tracker.md"));
			const now = new Date().toISOString();
			state = {
				version: 1,
				flowId: Math.random().toString(36).slice(2, 8),
				goal,
				repoRoot,
				route,
				grillMode,
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

	pi.on("before_agent_start", async (event) => {
		if (!state || ["paused", "done", "cancelled"].includes(state.phase)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${activePhaseInstructions(state)}` };
	});

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
}
