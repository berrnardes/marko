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
import { z } from "zod";

import type { ClassificationBand, QualificationFields } from "@/core/types";
import type { HandoffManager } from "@/services/handoff-manager";
import type { LifecycleManager } from "@/services/lifecycle-manager";
import type { LeadRepository } from "@/services/repositories";

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
