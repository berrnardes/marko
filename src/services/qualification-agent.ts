// Qualification_Agent ("Marko") — compiled LangGraph turn scaffolding.
//
// The qualification turn is modeled as a compiled LangGraph state graph
// (`@langchain/langgraph`) rather than a single model call. An injectable
// LangChain.js `BaseChatModel` is bound into the graph so tests can compile the
// same graph against a fake chat model with no live LLM.
//
// Side-effect boundary: this module performs all persistence/orchestration I/O
// through injected INTERFACE dependencies only (never concrete Drizzle/DB code):
//   - `LeadRepository`   — progressive qualification-field writes (Req 9.5);
//   - `ScoringEngine`    — recompute the Lead's Score and band (Req 11.1, 12);
//   - `LifecycleManager` — lifecycle transitions during the turn (Req 14.1);
//   - `HandoffManager`   — hand a hot/frustrated/out-of-data Lead off (Req 13).
// The chat model is the only LLM seam and is injected so the provider is
// swappable and mockable in tests.
//
// This module now assembles the full compiled qualification turn (task 20.10):
// the zod schemas, inferred types, the threaded `TurnState`, the per-node
// factories (`extract_fields`, `persist_fields`, `score_and_classify`,
// `select_next_question`, `generate_reply`, `detect_triggers`, `guard`,
// `handoff`, `enqueue_reply`), and `buildQualificationGraph(deps)` which wires
// them into a compiled `@langchain/langgraph` StateGraph behind
// `QualificationAgent.nextTurn`.
//
// Node-ordering reconciliation (design.md mermaid vs the data model): the
// design mermaid draws `detect_triggers` BETWEEN `score_and_classify` and
// `select_next_question`, yet the design's own `AgentOutputSchema` makes
// `detectedFrustration` and `outOfDataRequest` OUTPUTS of `generate_reply`
// (Req 8.3, 8.5), and Property 11 ties the triggers to "the agent graph output"
// — i.e. the `generate_reply` candidate. A graph that ran `detect_triggers`
// before `generate_reply` would read frustration/out-of-data flags off a
// `candidate` that does not yet exist. We therefore reconcile by running
// `detect_triggers` immediately AFTER `generate_reply` (so it reads the real
// candidate flags + the recomputed score) and routing its handoff edge before
// the `guard`/`enqueue_reply` finalization. This preserves every per-requirement
// behavior — frustration → handoff (Req 8.5), out-of-data → handoff with the
// reply short-circuited (Req 8.3), `score >= 70` → handoff (Req 13.1), and no
// automated reply on any handoff (Req 13.4) — while keeping the candidate flags
// well-defined at the point they are read.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

import type {
	ClassificationBand,
	HandoffReason,
	QualificationFields,
} from "@/core/types";
import type { HandoffManager } from "@/services/handoff-manager";
import {
	UnknownLeadError,
	type LifecycleManager,
} from "@/services/lifecycle-manager";
import type { OutboundSendQueue } from "@/services/outbound-worker";
import type {
	LeadRepository,
	QualificationFieldsPatch,
} from "@/services/repositories";

// ---------------------------------------------------------------------------
// Structured-output schemas (zod)
// ---------------------------------------------------------------------------

/**
 * zod schema for the qualification fields a Lead may volunteer in a single turn
 * (Req 9.2). Every field is `nullable().optional()` so the structured-output
 * extraction can omit a field the Lead did not mention; an omitted field never
 * clears an already-known value when persisted (Req 9.4, 9.5). Mirrors the
 * value shape of {@link QualificationFields} from `@/core/types`.
 */
export const ExtractedFieldsSchema = z.object({
	segment: z.string().nullable().optional(),
	creditValue: z.number().nullable().optional(),
	objective: z.enum(["housing", "investment"]).nullable().optional(),
	hasLanceReserve: z.boolean().nullable().optional(),
	income: z.number().nullable().optional(),
});

/** Fields the Lead volunteered this turn, inferred from {@link ExtractedFieldsSchema} (Req 9.2). */
export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

/**
 * zod schema for the structured agent output produced by the reply node. The
 * `reply` carries at most one question after the guard (Req 8.4); the boolean
 * flags drive the honesty/handoff routing, and `assertedFacts` lists the
 * factual tokens the reply asserts so the guard can reject claims absent from
 * the Lead's available data (Req 8.6).
 */
export const AgentOutputSchema = z.object({
	/** The "Marko" persona reply; at most one question after the guard (Req 8.4). */
	reply: z.string(),
	/** The agent detected Lead frustration this turn (Req 8.5). */
	detectedFrustration: z.boolean(),
	/** The Lead requested a fact outside the agent's available data (Req 8.3). */
	outOfDataRequest: z.boolean(),
	/** The Lead asked whether they are talking to an AI (Req 8.2). */
	asksAreYouAI: z.boolean(),
	/** Factual tokens the reply asserts, checked by the guard (Req 8.6). */
	assertedFacts: z.array(z.string()),
});

/** The structured "Marko" reply, inferred from {@link AgentOutputSchema} (Req 8.1). */
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

// ---------------------------------------------------------------------------
// Inbound message and scoring boundaries
// ---------------------------------------------------------------------------

/**
 * An inbound WhatsApp message handed to the qualification turn (Req 7). The
 * `from` sender id is normalized to E.164 internally; `waMessageId` supports
 * at-least-once inbound idempotency. This is the value the Inbound_Handler
 * (task 21) forwards to {@link QualificationAgent.nextTurn}.
 */
export interface InboundMessage {
	/** Raw WhatsApp sender id, normalized to E.164 internally. */
	from: string;
	/** The inbound message text. */
	text: string;
	/** When the message was received. */
	receivedAt: Date;
	/** WAHA message id, used for inbound idempotency. */
	waMessageId: string;
}

/**
 * I/O boundary that recomputes a Lead's Score from its current qualification
 * and behavioral signals and classifies the resulting band (Req 11.1, 12). The
 * `score_and_classify` node (task 20.6) calls this; the concrete implementation
 * wraps the pure `@/core/scoring` functions and the score-band classifier.
 */
export interface ScoringEngine {
	/**
	 * Recompute and persist the Lead's Score and classification band (Req 11.1,
	 * 12, 19.4), returning the new values for the turn's routing decisions.
	 */
	recompute(
		leadId: string,
	): Promise<{ score: number; band: ClassificationBand }>;
}

// ---------------------------------------------------------------------------
// Graph turn state
// ---------------------------------------------------------------------------

/**
 * The LangGraph turn state threaded through the qualification nodes. Each node
 * reads and augments this value: `extract_fields` fills {@link extracted},
 * `score_and_classify` sets {@link score} and {@link band},
 * `select_next_question` sets {@link nextField}, `generate_reply` produces
 * {@link candidate}, and `detect_triggers` sets {@link handoffReason} when a
 * frustration / out-of-data / hot-score trigger fires (Req 8.3, 8.5, 13.1).
 */
export interface TurnState {
	/** The Lead whose turn is being processed. */
	leadId: string;
	/** The inbound message text for this turn. */
	inboundText: string;
	/** The Lead's already-known qualification field set. */
	currentFields: QualificationFields;
	/** Fields volunteered this turn, filled by `extract_fields` (Req 9.2). */
	extracted: ExtractedFields;
	/** The Lead's Score recomputed this turn by `score_and_classify` (Req 11.1). */
	score: number;
	/** The score band classified this turn by `score_and_classify` (Req 12.1–12.4). */
	band: ClassificationBand;
	/** The single field `select_next_question` chose to ask, or null when all are filled (Req 9.3). */
	nextField: keyof QualificationFields | null;
	/** The candidate reply produced by `generate_reply` (Req 8.1). */
	candidate: AgentOutput;
	/** The triggering handoff reason, when one fired this turn (Req 8.3, 8.5, 13.1). */
	handoffReason: "frustration" | "out_of_data" | "hot_score" | null;
}

// ---------------------------------------------------------------------------
// QualificationAgent boundary and graph factory
// ---------------------------------------------------------------------------

/**
 * The mockable boundary for the qualification turn. The compiled LangGraph is
 * hidden behind this interface so callers (the Inbound_Handler) depend on the
 * behavior, not the graph wiring, and tests can substitute a fake (Req 8.1).
 */
export interface QualificationAgent {
	/**
	 * Run one qualification turn for a Lead against an inbound message: extract
	 * volunteered fields, persist them progressively, recompute the Score,
	 * detect handoff triggers, and either generate a guarded reply or hand off
	 * (Req 8, 9, 11, 12, 13).
	 */
	nextTurn(leadId: string, inbound: InboundMessage): Promise<void>;
}

/**
 * Construction dependencies for {@link buildQualificationGraph}. The chat model
 * is injectable so the compiled graph runs against a fake `BaseChatModel` in
 * tests; the remaining dependencies are the persistence/orchestration interface
 * boundaries the graph nodes write through.
 */
export interface QualificationGraphDeps {
	/** Injectable LangChain.js chat model; a fake ChatModel in tests (Req 8.1). */
	model: BaseChatModel;
	/** Persistence boundary for progressive qualification-field writes (Req 9.5). */
	leads: LeadRepository;
	/** Recomputes and classifies the Lead's Score during the turn (Req 11.1, 12). */
	scoring: ScoringEngine;
	/** Lifecycle transitions applied during the turn (Req 14.1). */
	lifecycle: LifecycleManager;
	/** Hands a hot/frustrated/out-of-data Lead off to a consultant (Req 13). */
	handoff: HandoffManager;
	/**
	 * Enqueue boundary onto the outbound choke point (design "Outbound choke
	 * point"). A guarded qualification reply is enqueued as a `qualification`
	 * outbound send job rather than sent inline, so the per-number anti-ban
	 * invariants are enforced in the single `Outbound_Worker` path. Reuses the
	 * same {@link OutboundSendQueue} seam the cadence/nurture workers depend on.
	 */
	outbound: OutboundSendQueue;
}

// ---------------------------------------------------------------------------
// Graph node: extract_fields (Req 9.2)
// ---------------------------------------------------------------------------

/**
 * The system prompt that frames the structured-output extraction: capture only
 * what the Lead actually volunteered this turn, leaving every other field
 * omitted/null so a partial extraction never overwrites already-known data
 * (Req 9.2, 9.4).
 */
const EXTRACT_FIELDS_SYSTEM_PROMPT =
	"You extract consórcio qualification fields a lead volunteers in a WhatsApp message. " +
	"Return only fields the lead actually stated in THIS message; leave every field the " +
	"lead did not mention as null. Never guess or infer values that were not stated.";

/**
 * Build the prompt messages for the {@link createExtractFieldsNode} structured
 * extraction. The already-known fields are supplied as context so the model can
 * focus on what is newly volunteered, but the schema still permits omitting any
 * field the Lead did not mention this turn (Req 9.2).
 */
function buildExtractFieldsMessages(
	state: Pick<TurnState, "inboundText" | "currentFields">,
): [SystemMessage, HumanMessage] {
	const known = JSON.stringify(state.currentFields);
	return [
		new SystemMessage(EXTRACT_FIELDS_SYSTEM_PROMPT),
		new HumanMessage(
			`Already-known fields (do not repeat unless restated): ${known}\n` +
				`Lead message: ${state.inboundText}`,
		),
	];
}

/**
 * Create the `extract_fields` graph node (Req 9.2).
 *
 * The node performs a `model.withStructuredOutput(ExtractedFieldsSchema)` call
 * to capture every qualification field the Lead volunteered this turn, filling
 * {@link TurnState.extracted}. Fields the Lead did not mention are omitted/null
 * by the schema so downstream {@link createPersistFieldsNode} never clears an
 * already-known value (Req 9.2, 9.4).
 *
 * @param model - The injectable LangChain.js chat model (a fake in tests).
 * @returns A node mapping a {@link TurnState} to the `extracted` field update.
 */
export function createExtractFieldsNode(
	model: BaseChatModel,
): (
	state: Pick<TurnState, "inboundText" | "currentFields">,
) => Promise<Pick<TurnState, "extracted">> {
	const structuredModel = model.withStructuredOutput(ExtractedFieldsSchema, {
		name: "extract_fields",
	});
	return async function extractFields(
		state: Pick<TurnState, "inboundText" | "currentFields">,
	): Promise<Pick<TurnState, "extracted">> {
		const extracted = (await structuredModel.invoke(
			buildExtractFieldsMessages(state),
		)) as ExtractedFields;
		return { extracted };
	};
}

// ---------------------------------------------------------------------------
// Graph node: persist_fields (Req 9.4, 9.5)
// ---------------------------------------------------------------------------

/**
 * Reduce a turn's {@link ExtractedFields} to a {@link QualificationFieldsPatch}
 * that progressively persists only the values the Lead actually volunteered
 * (Req 9.5). A field whose extracted value is `null`/`undefined` (the Lead did
 * not mention it this turn) is omitted from the patch, so the repository leaves
 * any already-set value intact and never clears it (Req 9.4). Boolean `false`
 * and numeric `0` are real volunteered values and are therefore preserved.
 *
 * @param extracted - The fields captured by `extract_fields` this turn.
 * @returns A patch containing only the provided (non-nullish) field values.
 */
export function buildQualificationPatch(
	extracted: ExtractedFields,
): QualificationFieldsPatch {
	const patch: QualificationFieldsPatch = {};
	if (extracted.segment != null) patch.segment = extracted.segment;
	if (extracted.creditValue != null) patch.creditValue = extracted.creditValue;
	if (extracted.objective != null) patch.objective = extracted.objective;
	if (extracted.hasLanceReserve != null) {
		patch.hasLanceReserve = extracted.hasLanceReserve;
	}
	if (extracted.income != null) patch.income = extracted.income;
	return patch;
}

/**
 * Create the `persist_fields` graph node (Req 9.4, 9.5).
 *
 * The node writes the values volunteered this turn onto the Lead progressively
 * via the injected {@link LeadRepository.updateQualification}, building the
 * patch with {@link buildQualificationPatch} so an extraction that omits a
 * field never clears an already-set value (Req 9.4). When nothing was
 * volunteered the node makes no write and threads the unchanged fields forward.
 * The persisted snapshot's qualification is threaded back into
 * {@link TurnState.currentFields} so later nodes observe the freshly-written
 * values (Req 9.5).
 *
 * @param leads - The persistence boundary for progressive field writes.
 * @returns A node mapping a {@link TurnState} to the `currentFields` update.
 */
export function createPersistFieldsNode(
	leads: LeadRepository,
): (
	state: Pick<TurnState, "leadId" | "currentFields" | "extracted">,
) => Promise<Pick<TurnState, "currentFields">> {
	return async function persistFields(
		state: Pick<TurnState, "leadId" | "currentFields" | "extracted">,
	): Promise<Pick<TurnState, "currentFields">> {
		const patch = buildQualificationPatch(state.extracted);
		if (Object.keys(patch).length === 0) {
			// Nothing volunteered this turn: leave every stored field intact.
			return { currentFields: state.currentFields };
		}
		const updated = await leads.updateQualification(state.leadId, patch);
		return { currentFields: updated.qualification };
	};
}

// ---------------------------------------------------------------------------
// Graph node: select_next_question (Req 9.3)
// ---------------------------------------------------------------------------

/**
 * The deterministic order in which qualification fields are asked about. The
 * `select_next_question` node walks this order and picks the first field that
 * is still `null`, so a Lead is asked about its missing data in a stable,
 * documented sequence rather than an arbitrary one (Req 9.3). The order mirrors
 * the declaration order of {@link QualificationFields} in `@/core/types`:
 * `segment` → `creditValue` → `objective` → `hasLanceReserve` → `income`.
 */
const QUALIFICATION_FIELD_ORDER: readonly (keyof QualificationFields)[] = [
	"segment",
	"creditValue",
	"objective",
	"hasLanceReserve",
	"income",
];

/**
 * Choose the single qualification field to ask about next, or `null` when the
 * Lead's field set is fully filled (Req 9.3).
 *
 * This is a pure selection over the Lead's current fields — no LLM call. It
 * returns the first field in {@link QUALIFICATION_FIELD_ORDER} whose value is
 * still `null`, guaranteeing the chosen field is always one that is currently
 * unfilled; when every field is set it returns `null` so no question is asked
 * (Req 9.3). A field's value is "filled" when it is not `null`, so a
 * volunteered boolean `false` or numeric `0` counts as answered.
 *
 * @param fields - The Lead's already-known qualification field set.
 * @returns The first unfilled field in order, or `null` when all are filled.
 */
export function selectNextQuestionField(
	fields: QualificationFields,
): keyof QualificationFields | null {
	for (const field of QUALIFICATION_FIELD_ORDER) {
		if (fields[field] === null) return field;
	}
	return null;
}

/**
 * Create the `select_next_question` graph node (Req 9.3).
 *
 * The node reads the Lead's current qualification fields and, via the pure
 * {@link selectNextQuestionField}, sets {@link TurnState.nextField} to a single
 * field that is still `null` — or to `null` when all fields are filled, so the
 * downstream reply asks no further question (Req 9.3). The decision is a
 * deterministic selection over the current fields and performs no I/O and no
 * model call.
 *
 * @returns A node mapping a {@link TurnState} to the `nextField` update.
 */
export function createSelectNextQuestionNode(): (
	state: Pick<TurnState, "currentFields">,
) => Promise<Pick<TurnState, "nextField">> {
	return async function selectNextQuestion(
		state: Pick<TurnState, "currentFields">,
	): Promise<Pick<TurnState, "nextField">> {
		return { nextField: selectNextQuestionField(state.currentFields) };
	};
}

// ---------------------------------------------------------------------------
// Graph node: score_and_classify (Req 11.1, 12.1–12.4)
// ---------------------------------------------------------------------------

/**
 * Create the `score_and_classify` graph node (Req 11.1, 12.1–12.4).
 *
 * The node recomputes the Lead's Score from its current qualification and
 * behavioral signals via the injected {@link ScoringEngine.recompute} and
 * threads the returned `{ score, band }` into the turn state (Req 11.1). The
 * band partitions the score range per Req 12 (`HOT` >= 70, `WARM` 40–69, `cold`
 * 1–39, `DISQUALIFIED` 0) and is produced by the {@link ScoringEngine}; this
 * node consumes and forwards it so the downstream `detect_triggers` node can
 * route a hot Lead to handoff (Req 13.1). The recompute is the single I/O the
 * node performs; all routing decisions read the threaded values.
 *
 * @param scoring - The injected scoring boundary (Req 11.1, 12).
 * @returns A node mapping a {@link TurnState} to the `score`/`band` update.
 */
export function createScoreAndClassifyNode(
	scoring: ScoringEngine,
): (
	state: Pick<TurnState, "leadId">,
) => Promise<Pick<TurnState, "score" | "band">> {
	return async function scoreAndClassify(
		state: Pick<TurnState, "leadId">,
	): Promise<Pick<TurnState, "score" | "band">> {
		const { score, band } = await scoring.recompute(state.leadId);
		return { score, band };
	};
}

// ---------------------------------------------------------------------------
// Graph node: detect_triggers (Req 8.3, 8.5, 13.1)
// ---------------------------------------------------------------------------

/**
 * The Score at or above which a Lead is hot and must be handed off immediately,
 * regardless of its current funnel stage (Req 13.1). This mirrors the `HOT`
 * band's lower edge in `@/core/classify` so the `hot_score` trigger fires for
 * exactly the scores classified `HOT`.
 */
const HOT_SCORE_THRESHOLD = 70;

/**
 * The handoff-trigger signals evaluated by {@link detectHandoffReason}, drawn
 * from the turn state: the two boolean flags the reply node surfaces on its
 * {@link AgentOutput} (Req 8.3, 8.5) and the Score recomputed by
 * `score_and_classify` (Req 13.1).
 */
export interface HandoffTriggerSignals {
	/** The agent detected Lead frustration this turn (Req 8.5). */
	detectedFrustration: boolean;
	/** The Lead requested a fact outside the agent's available data (Req 8.3). */
	outOfDataRequest: boolean;
	/** The Lead's recomputed Score this turn (Req 13.1). */
	score: number;
}

/**
 * Decide which handoff trigger, if any, fired this turn (Req 8.3, 8.5, 13.1).
 *
 * Any one of three independent conditions routes the turn to the `handoff`
 * node and short-circuits the automated reply:
 *
 *   - detected Lead frustration  → `"frustration"`  (Req 8.5);
 *   - an out-of-data factual request → `"out_of_data"` (Req 8.3);
 *   - `score >= 70`              → `"hot_score"`    (Req 13.1).
 *
 * When more than one condition holds the reasons are prioritized in that order:
 * a frustrated Lead is de-escalated to a human first, an unanswerable factual
 * request next, and the score-threshold handoff last. The chosen reason is only
 * the *recorded* trigger — all three route to the same `handoff` node — so the
 * ordering affects the `handoff_events` reason, not whether a handoff occurs.
 * When no condition holds the function returns `null` and the turn continues to
 * the reply path.
 *
 * Pure and total: a function of its inputs with no I/O, so it is unit-testable
 * in isolation from the graph.
 *
 * @param signals - The frustration/out-of-data flags and the recomputed Score.
 * @returns The triggering handoff reason, or `null` when no trigger fired.
 */
export function detectHandoffReason(
	signals: HandoffTriggerSignals,
): TurnState["handoffReason"] {
	if (signals.detectedFrustration) return "frustration";
	if (signals.outOfDataRequest) return "out_of_data";
	if (signals.score >= HOT_SCORE_THRESHOLD) return "hot_score";
	return null;
}

/**
 * The destination a conditional edge routes to after `detect_triggers`: either
 * the `handoff` node (a trigger fired) or the `guard` node (the turn continues
 * down the reply-finalization path).
 *
 * Per the node-ordering reconciliation (see the module header), `detect_triggers`
 * runs AFTER `generate_reply`, so the "continue" branch routes to `guard` — which
 * repairs/rejects the already-produced candidate before `enqueue_reply` sends it
 * — rather than back to `select_next_question`.
 */
export type DetectTriggersRoute = "handoff" | "guard";

/**
 * Routing function for the conditional edge leaving `detect_triggers`
 * (Req 8.3, 8.5, 13.1).
 *
 * Routes to the `handoff` node when a trigger fired this turn — short-circuiting
 * the reply path so no automated message is sent to a frustrated, out-of-data,
 * or hot Lead (Req 8.3, 8.5, 13.1, 13.4) — and otherwise to `guard` to finalize
 * and enqueue the candidate reply. Pure: derived solely from the
 * {@link TurnState.handoffReason} set by `detect_triggers`.
 *
 * @param state - The turn state carrying the detected `handoffReason`.
 * @returns The next node: `"handoff"` when a trigger fired, else `"guard"`.
 */
export function routeAfterDetectTriggers(
	state: Pick<TurnState, "handoffReason">,
): DetectTriggersRoute {
	return state.handoffReason !== null ? "handoff" : "guard";
}

/**
 * Create the `detect_triggers` graph node (Req 8.3, 8.5, 13.1).
 *
 * The node evaluates the three handoff triggers via the pure
 * {@link detectHandoffReason} — frustration and an out-of-data factual request
 * (read from the reply node's {@link AgentOutput} flags on
 * {@link TurnState.candidate}, Req 8.3, 8.5) and a hot Score (read from
 * {@link TurnState.score}, Req 13.1) — and sets {@link TurnState.handoffReason}
 * accordingly. The companion {@link routeAfterDetectTriggers} reads that value
 * on the conditional edge to either route to `handoff` (short-circuiting the
 * reply path) or continue to `select_next_question` (Req 13.4). The node
 * performs no I/O and no model call.
 *
 * @returns A node mapping a {@link TurnState} to the `handoffReason` update.
 */
export function createDetectTriggersNode(): (
	state: Pick<TurnState, "candidate" | "score">,
) => Promise<Pick<TurnState, "handoffReason">> {
	return async function detectTriggers(
		state: Pick<TurnState, "candidate" | "score">,
	): Promise<Pick<TurnState, "handoffReason">> {
		return {
			handoffReason: detectHandoffReason({
				detectedFrustration: state.candidate.detectedFrustration,
				outOfDataRequest: state.candidate.outOfDataRequest,
				score: state.score,
			}),
		};
	};
}

// ---------------------------------------------------------------------------
// Graph node: generate_reply (Req 8.1, 8.2, 8.4)
// ---------------------------------------------------------------------------

/**
 * The system prompt that frames the "Marko" persona reply (Req 8.1, 8.2, 8.4,
 * 8.6). It pins the persona (an attentive, direct consórcio specialist), the
 * honesty rules (confirm being an AI when the Lead asks — Req 8.2; never state
 * consórcio rates, group details, or contemplation outcomes absent from the
 * supplied data — Req 8.6), and the one-question constraint (Req 8.4). The
 * model is also asked to surface the honesty/handoff flags and to list, in
 * `assertedFacts`, every factual token the reply asserts so the downstream
 * {@link createGuardNode} can repair or reject unsupported claims (Req 8.6).
 */
const GENERATE_REPLY_SYSTEM_PROMPT =
	'You are "Marko," an attentive and direct Brazilian consórcio specialist ' +
	"talking to a lead on WhatsApp. Reply in Brazilian Portuguese, warm but " +
	"concise. Rules you must always follow:\n" +
	"- Ask AT MOST ONE question in your reply. When a field to collect " +
	"is provided, ask only about that single field.\n" +
	"- If the lead directly asks whether you are an AI, confirm that you are an " +
	"AI and set asksAreYouAI=true.\n" +
	"- NEVER state consórcio rates, group details, or contemplation outcomes " +
	"that are not present in the supplied available data; do not invent numbers " +
	"or guarantees.\n" +
	"- List in assertedFacts every concrete factual token your reply asserts " +
	"(e.g. a rate, a group id, a contemplation claim) so it can be verified " +
	"against the available data; leave it empty when you assert no such fact.\n" +
	"- Set detectedFrustration=true when the lead sounds frustrated or angry, " +
	"and outOfDataRequest=true when the lead asks for a fact you do not hold.";

/**
 * Build the prompt messages for {@link createGenerateReplyNode}. The inbound
 * text, the Lead's already-known fields, and the single field
 * `select_next_question` chose are supplied as context so the persona reply
 * asks about exactly that one field — or asks no question when every field is
 * already filled (`nextField === null`) (Req 8.4, 9.3).
 */
function buildGenerateReplyMessages(
	state: Pick<TurnState, "inboundText" | "currentFields" | "nextField">,
): [SystemMessage, HumanMessage] {
	const known = JSON.stringify(state.currentFields);
	const ask =
		state.nextField === null
			? "All qualification fields are already collected; do not ask a new " +
				"qualifying question — acknowledge the lead and keep the conversation warm."
			: `Ask the lead about exactly this one field: ${state.nextField}.`;
	return [
		new SystemMessage(GENERATE_REPLY_SYSTEM_PROMPT),
		new HumanMessage(
			`Available data (the only facts you may assert): ${known}\n` +
				`Lead message: ${state.inboundText}\n` +
				ask,
		),
	];
}

/**
 * Create the `generate_reply` graph node (Req 8.1, 8.2, 8.4).
 *
 * The node performs a `model.withStructuredOutput(AgentOutputSchema)` call to
 * produce the "Marko" persona reply, filling {@link TurnState.candidate}. The
 * prompt incorporates the inbound text, the Lead's current fields, and the
 * single {@link TurnState.nextField} chosen by `select_next_question`, so the
 * reply asks about that one field and carries at most one question (Req 8.4).
 * Persona and honesty rules (confirm being an AI when asked — Req 8.2; never
 * assert consórcio rate/group/contemplation facts absent from the available
 * data — Req 8.6) are framed in {@link GENERATE_REPLY_SYSTEM_PROMPT}; the
 * downstream {@link createGuardNode} additionally repairs or rejects any reply
 * that violates the one-question or no-unsupported-facts rules (Req 8.4, 8.6).
 *
 * @param model - The injectable LangChain.js chat model (a fake in tests).
 * @returns A node mapping a {@link TurnState} to the `candidate` reply update.
 */
export function createGenerateReplyNode(
	model: BaseChatModel,
): (
	state: Pick<TurnState, "inboundText" | "currentFields" | "nextField">,
) => Promise<Pick<TurnState, "candidate">> {
	const structuredModel = model.withStructuredOutput(AgentOutputSchema, {
		name: "generate_reply",
	});
	return async function generateReply(
		state: Pick<TurnState, "inboundText" | "currentFields" | "nextField">,
	): Promise<Pick<TurnState, "candidate">> {
		const candidate = (await structuredModel.invoke(
			buildGenerateReplyMessages(state),
		)) as AgentOutput;
		return { candidate };
	};
}

// ---------------------------------------------------------------------------
// Graph node: guard (Req 8.4, 8.6)
// ---------------------------------------------------------------------------

/**
 * Count the number of questions a candidate reply contains, taken as the number
 * of `?` characters in the text (Req 8.4). A reply is within the one-question
 * limit when this count is at most one.
 *
 * @param reply - The candidate reply text.
 * @returns The number of `?` occurrences in the reply.
 */
export function countQuestions(reply: string): number {
	let count = 0;
	for (const char of reply) {
		if (char === "?") count += 1;
	}
	return count;
}

/**
 * Truncate a reply to keep only its first question (Req 8.4). Everything up to
 * and including the first `?` is retained and trailing content after it is
 * dropped, so a reply that asked several questions is repaired down to a single
 * one. A reply with no `?` is returned unchanged.
 *
 * @param reply - The candidate reply text.
 * @returns The reply truncated to its first question, trimmed of trailing space.
 */
export function truncateToFirstQuestion(reply: string): string {
	const firstMark = reply.indexOf("?");
	if (firstMark === -1) return reply;
	return reply.slice(0, firstMark + 1).trimEnd();
}

/**
 * Normalize the Lead's available qualification data into a single lowercase
 * string of its non-null field values, used by {@link findUnsupportedFacts} to
 * decide whether a factual token the reply asserts is backed by data (Req 8.6).
 * A `null` field contributes nothing, so it can never support an assertion.
 *
 * @param data - The Lead's available qualification fields.
 * @returns A lowercase, space-joined string of the present field values.
 */
export function availableDataText(data: QualificationFields): string {
	const parts: string[] = [];
	if (data.segment != null) parts.push(String(data.segment));
	if (data.creditValue != null) parts.push(String(data.creditValue));
	if (data.objective != null) parts.push(String(data.objective));
	if (data.hasLanceReserve != null) parts.push(String(data.hasLanceReserve));
	if (data.income != null) parts.push(String(data.income));
	return parts.join(" ").toLowerCase();
}

/**
 * Find the factual tokens a reply asserts that are NOT supported by the Lead's
 * available data (Req 8.6). A token is supported when, after lowercasing and
 * trimming, it is a non-empty substring of {@link availableDataText}; any
 * asserted token absent from the available data — a consórcio rate, group
 * detail, or contemplation outcome the agent does not actually hold — is
 * returned as unsupported so the guard can reject the reply.
 *
 * Pure and total: a function of its inputs with no I/O.
 *
 * @param assertedFacts - The factual tokens the candidate reply asserts.
 * @param data - The Lead's available qualification fields.
 * @returns The subset of `assertedFacts` not backed by the available data.
 */
export function findUnsupportedFacts(
	assertedFacts: readonly string[],
	data: QualificationFields,
): string[] {
	const available = availableDataText(data);
	return assertedFacts.filter((fact) => {
		const token = fact.trim().toLowerCase();
		if (token.length === 0) return false;
		return !available.includes(token);
	});
}

/**
 * The outcome of {@link guardReply}: the reply is accepted unchanged, repaired
 * into a safe reply, or rejected because it cannot be made safe (Req 8.4, 8.6).
 *
 *   - `"accept"` — the reply already has at most one question and asserts only
 *     supported facts; `reply` is the original, unchanged.
 *   - `"repair"` — the reply exceeded one question but asserts only supported
 *     facts; `reply` is the original truncated to its first question (Req 8.4).
 *   - `"reject"` — the reply asserts one or more facts absent from the Lead's
 *     available data, which cannot be safely stripped from free text, so the
 *     reply must not be sent; `unsupportedFacts` lists the offending tokens
 *     (Req 8.6).
 */
export type ReplyGuardResult =
	| { decision: "accept"; reply: AgentOutput }
	| { decision: "repair"; reply: AgentOutput }
	| { decision: "reject"; unsupportedFacts: string[] };

/**
 * The honesty / one-question guard over a candidate reply (Req 8.4, 8.6).
 *
 * Decides whether a candidate {@link AgentOutput} may be sent against the Lead's
 * available data:
 *
 *   1. If the reply asserts any fact absent from the available data, it is
 *      REJECTED — an unsupported consórcio rate, group, or contemplation claim
 *      cannot be reliably stripped from free-text prose, so the reply is not
 *      sent (Req 8.6).
 *   2. Otherwise, if the reply contains more than one question, it is REPAIRED
 *      by truncating to its first question (Req 8.4).
 *   3. Otherwise the reply is ACCEPTED unchanged.
 *
 * Pure and total: a function of the candidate and the available data with no
 * I/O, so it is unit-testable in isolation from the graph.
 *
 * @param candidate - The reply produced by `generate_reply`.
 * @param data - The Lead's available qualification fields.
 * @returns The guard decision and the resulting (possibly repaired) reply.
 */
export function guardReply(
	candidate: AgentOutput,
	data: QualificationFields,
): ReplyGuardResult {
	const unsupportedFacts = findUnsupportedFacts(candidate.assertedFacts, data);
	if (unsupportedFacts.length > 0) {
		return { decision: "reject", unsupportedFacts };
	}
	if (countQuestions(candidate.reply) > 1) {
		return {
			decision: "repair",
			reply: { ...candidate, reply: truncateToFirstQuestion(candidate.reply) },
		};
	}
	return { decision: "accept", reply: candidate };
}

/**
 * Create the `guard` graph node (Req 8.4, 8.6).
 *
 * The node post-processes {@link TurnState.candidate} through the pure
 * {@link guardReply} against the Lead's {@link TurnState.currentFields} (the
 * agent's available data) and threads the guarded reply back into
 * {@link TurnState.candidate}:
 *
 *   - an accepted reply passes through unchanged;
 *   - a reply with more than one question is repaired down to its first
 *     question before it can be sent (Req 8.4);
 *   - a reply asserting facts absent from the available data is rejected — the
 *     candidate's text is blanked and its `assertedFacts` cleared so no
 *     unsupported consórcio rate/group/contemplation claim is ever sent
 *     (Req 8.6). The honesty/handoff flags are preserved so downstream routing
 *     still observes them.
 *
 * The node performs no I/O and no model call.
 *
 * @returns A node mapping a {@link TurnState} to the guarded `candidate` update.
 */
export function createGuardNode(): (
	state: Pick<TurnState, "candidate" | "currentFields">,
) => Promise<Pick<TurnState, "candidate">> {
	return async function guard(
		state: Pick<TurnState, "candidate" | "currentFields">,
	): Promise<Pick<TurnState, "candidate">> {
		const result = guardReply(state.candidate, state.currentFields);
		if (result.decision === "reject") {
			// The reply asserts unsupported facts that cannot be safely stripped
			// from free text: emit nothing while preserving the honesty/handoff
			// flags for downstream routing (Req 8.6).
			return {
				candidate: { ...state.candidate, reply: "", assertedFacts: [] },
			};
		}
		return { candidate: result.reply };
	};
}

// ---------------------------------------------------------------------------
// Graph node: handoff (Req 13.1–13.4)
// ---------------------------------------------------------------------------

/**
 * Create the `handoff` graph node (Req 13.1–13.4).
 *
 * Reached only on the conditional edge from `detect_triggers` when a trigger
 * fired this turn (see {@link routeAfterDetectTriggers}). The node invokes the
 * injected {@link HandoffManager.handoff} with the triggering
 * {@link TurnState.handoffReason} — which moves the Lead to `HOT`, records the
 * handoff event, and cancels the Lead's pending outreach (Req 13.1–13.4) — and
 * then terminates the turn WITHOUT producing or enqueuing any reply, so the
 * reply path is short-circuited for a frustrated, out-of-data, or hot Lead
 * (Req 8.3, 8.5, 13.4). It performs no model call.
 *
 * The non-null narrowing is sound: this node is only entered when
 * `handoffReason !== null`, and the non-null subset of
 * {@link TurnState.handoffReason} is exactly {@link HandoffReason}. The guard is
 * kept defensively so a direct call with a null reason is a harmless no-op.
 *
 * @param handoff - The injected hot-lead handoff boundary (Req 13).
 * @returns A node that performs the handoff and threads no state change.
 */
export function createHandoffNode(
	handoff: HandoffManager,
): (
	state: Pick<TurnState, "leadId" | "handoffReason">,
) => Promise<Partial<TurnState>> {
	return async function handoffNode(
		state: Pick<TurnState, "leadId" | "handoffReason">,
	): Promise<Partial<TurnState>> {
		if (state.handoffReason !== null) {
			await handoff.handoff(state.leadId, state.handoffReason as HandoffReason);
		}
		return {};
	};
}

// ---------------------------------------------------------------------------
// Graph node: enqueue_reply (Req 8.1; design "Outbound choke point")
// ---------------------------------------------------------------------------

/**
 * Create the `enqueue_reply` graph node (Req 8.1; design "Outbound choke
 * point").
 *
 * The terminal node of the reply-finalization path: it enqueues the guarded
 * {@link TurnState.candidate} reply as a `qualification` outbound send job
 * through the injected {@link OutboundSendQueue}, so the message flows through
 * the single `Outbound_Worker` choke point rather than being sent inline (the
 * per-number anti-ban invariants are enforced there). Because this node is only
 * reached on the non-handoff branch of `detect_triggers`, no reply is ever
 * enqueued when a handoff fires (Req 13.4).
 *
 * A reply the `guard` node REJECTED is blanked to an empty string (Req 8.6); in
 * that case nothing is enqueued, so an unsupported-fact reply is never sent. A
 * non-empty reply — including the all-fields-collected acknowledgement that
 * carries no question — is enqueued verbatim.
 *
 * @param outbound - The enqueue boundary onto the outbound choke point.
 * @returns A node that enqueues the guarded reply and threads no state change.
 */
export function createEnqueueReplyNode(
	outbound: OutboundSendQueue,
): (
	state: Pick<TurnState, "leadId" | "candidate">,
) => Promise<Partial<TurnState>> {
	return async function enqueueReply(
		state: Pick<TurnState, "leadId" | "candidate">,
	): Promise<Partial<TurnState>> {
		if (state.candidate.reply.trim().length > 0) {
			await outbound.enqueueSend({
				leadId: state.leadId,
				content: state.candidate.reply,
				kind: "qualification",
			});
		}
		return {};
	};
}

// ---------------------------------------------------------------------------
// Compiled graph state channels and assembly
// ---------------------------------------------------------------------------

/**
 * The LangGraph state channels for the qualification turn, one per
 * {@link TurnState} field. Each channel uses the default last-value reducer, so
 * a node that returns a field overwrites it for downstream nodes (e.g.
 * `persist_fields` overwrites {@link TurnState.currentFields} with the
 * freshly-written snapshot). The inferred state value is structurally identical
 * to {@link TurnState}, so the per-node factories' `Pick<TurnState, …>` inputs
 * and updates type-check against the graph.
 */
const QualificationStateAnnotation = Annotation.Root({
	leadId: Annotation<string>(),
	inboundText: Annotation<string>(),
	currentFields: Annotation<QualificationFields>(),
	extracted: Annotation<ExtractedFields>(),
	score: Annotation<number>(),
	band: Annotation<ClassificationBand>(),
	nextField: Annotation<keyof QualificationFields | null>(),
	candidate: Annotation<AgentOutput>(),
	handoffReason: Annotation<TurnState["handoffReason"]>(),
});

/**
 * Build the compiled qualification-turn graph behind the {@link QualificationAgent}
 * boundary (Req 8.1, 9.1).
 *
 * Wires the per-node factories into a compiled `@langchain/langgraph`
 * `StateGraph` over {@link QualificationStateAnnotation}. The reconciled node
 * ordering (see the module header) is:
 *
 * ```text
 *   START → extract_fields → persist_fields → score_and_classify
 *         → select_next_question → generate_reply → detect_triggers
 *   detect_triggers ─ handoff ─→ handoff → END        (a trigger fired)
 *   detect_triggers ─ guard ───→ guard → enqueue_reply → END   (continue)
 * ```
 *
 * `detect_triggers` runs after `generate_reply` so it reads the real candidate
 * frustration/out-of-data flags (Req 8.3, 8.5) alongside the recomputed score
 * (Req 13.1); its conditional edge either short-circuits to `handoff` (no
 * automated reply, Req 13.4) or continues to `guard` → `enqueue_reply`, which
 * places the guarded reply on the outbound choke point.
 *
 * Re-engagement opener (Req 9.1, 8.1): when a NEW Lead enters `QUALIFYING` its
 * qualification fields are all `null`, so `select_next_question` picks the first
 * unfilled field and `generate_reply` (constrained by the persona prompt and the
 * one-question `guard`) asks about exactly that single field — a single
 * re-engagement question rather than the whole questionnaire at once.
 *
 * @param deps - Injectable chat model and persistence/orchestration boundaries.
 * @returns A {@link QualificationAgent} hiding the compiled graph.
 */
export function buildQualificationGraph(
	deps: QualificationGraphDeps,
): QualificationAgent {
	const compiled = new StateGraph(QualificationStateAnnotation)
		.addNode("extract_fields", createExtractFieldsNode(deps.model))
		.addNode("persist_fields", createPersistFieldsNode(deps.leads))
		.addNode("score_and_classify", createScoreAndClassifyNode(deps.scoring))
		.addNode("select_next_question", createSelectNextQuestionNode())
		.addNode("generate_reply", createGenerateReplyNode(deps.model))
		.addNode("detect_triggers", createDetectTriggersNode())
		.addNode("handoff", createHandoffNode(deps.handoff))
		.addNode("guard", createGuardNode())
		.addNode("enqueue_reply", createEnqueueReplyNode(deps.outbound))
		.addEdge(START, "extract_fields")
		.addEdge("extract_fields", "persist_fields")
		.addEdge("persist_fields", "score_and_classify")
		.addEdge("score_and_classify", "select_next_question")
		.addEdge("select_next_question", "generate_reply")
		.addEdge("generate_reply", "detect_triggers")
		.addConditionalEdges("detect_triggers", routeAfterDetectTriggers, {
			handoff: "handoff",
			guard: "guard",
		})
		.addEdge("handoff", END)
		.addEdge("guard", "enqueue_reply")
		.addEdge("enqueue_reply", END)
		.compile();

	return {
		async nextTurn(leadId: string, inbound: InboundMessage): Promise<void> {
			// Load the Lead's already-known qualification fields so progressive
			// extraction never re-asks what is already collected and so `guard`
			// has the available data to honesty-check the reply against (Req 9.3,
			// 8.6). A missing Lead is a hard error — a turn cannot run without one.
			const lead = await deps.leads.findById(leadId);
			if (!lead) {
				throw new UnknownLeadError(leadId);
			}

			// Seed the turn state with the inbound text and the Lead's current
			// fields; every other channel is populated by the nodes in order
			// before it is read. The compiled graph performs the extraction,
			// persistence, scoring, trigger detection, guarding, and either the
			// handoff or the outbound enqueue as its terminal step (Req 8, 9, 11,
			// 12, 13).
			await compiled.invoke({
				leadId,
				inboundText: inbound.text,
				currentFields: lead.qualification,
			});
		},
	};
}
