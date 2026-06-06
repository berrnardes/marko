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
// This module is the SCAFFOLDING for the qualification turn (task 20.1): the
// zod schemas, inferred types, the threaded `TurnState`, the mockable
// `QualificationAgent` boundary, and the `buildQualificationGraph(deps)`
// factory skeleton. The individual graph nodes (`extract_fields`,
// `persist_fields`, `select_next_question`, `score_and_classify`,
// `detect_triggers`, `generate_reply`, `guard`, `handoff`) are wired in later
// tasks (20.2+); until then the compiled graph is not yet assembled.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

import type { ClassificationBand, QualificationFields } from "@/core/types";
import type { HandoffManager } from "@/services/handoff-manager";
import type { LifecycleManager } from "@/services/lifecycle-manager";
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
 * the `handoff` node (a trigger fired) or the `select_next_question` node (the
 * turn continues down the reply path).
 */
export type DetectTriggersRoute = "handoff" | "select_next_question";

/**
 * Routing function for the conditional edge leaving `detect_triggers`
 * (Req 8.3, 8.5, 13.1).
 *
 * Routes to the `handoff` node when a trigger fired this turn — short-circuiting
 * the reply path so no automated message is sent to a frustrated, out-of-data,
 * or hot Lead (Req 8.3, 8.5, 13.1, 13.4) — and otherwise to
 * `select_next_question` to continue building the guarded reply. Pure: derived
 * solely from the {@link TurnState.handoffReason} set by `detect_triggers`.
 *
 * @param state - The turn state carrying the detected `handoffReason`.
 * @returns The next node: `"handoff"` when a trigger fired, else `"select_next_question"`.
 */
export function routeAfterDetectTriggers(
	state: Pick<TurnState, "handoffReason">,
): DetectTriggersRoute {
	return state.handoffReason !== null ? "handoff" : "select_next_question";
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

/**
 * Build the compiled qualification-turn graph behind the {@link QualificationAgent}
 * boundary (Req 8.1, 9.2).
 *
 * SCAFFOLDING (task 20.1): this factory establishes the dependency seam and the
 * returned boundary. The individual graph nodes (`extract_fields`,
 * `persist_fields`, `select_next_question`, `score_and_classify`,
 * `detect_triggers`, `generate_reply`, `guard`, `handoff`) and their conditional
 * edges are wired in later tasks (20.2+); until then {@link QualificationAgent.nextTurn}
 * is a not-yet-implemented placeholder.
 *
 * @param deps - Injectable chat model and persistence/orchestration boundaries.
 * @returns A {@link QualificationAgent} hiding the compiled graph.
 */
export function buildQualificationGraph(
	deps: QualificationGraphDeps,
): QualificationAgent {
	// The graph nodes are assembled against these dependencies in tasks 20.2+.
	void deps;
	return {
		async nextTurn(): Promise<void> {
			throw new Error(
				"buildQualificationGraph: qualification graph nodes are not yet implemented (tasks 20.2+)",
			);
		},
	};
}
