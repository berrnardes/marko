# Requirements Document

## Introduction

This document specifies the requirements for a WhatsApp lead-reactivation agent with an integrated CRM, built for a Brazilian consórcio (group-purchasing credit) sales operation. The system ingests a list of previously interested but currently cold leads, re-engages them automatically over a 5-touch / 15-day cadence, and — when a lead replies — switches into an AI-driven conversational qualification mode. Qualified leads are scored continuously and the highest-value ("hot") leads are handed off to a human consultant.

The system is designed to run continuously, to operate at near-zero marginal cost per lead, and to remain compliant with Brazilian data-protection law (LGPD). Because the WhatsApp channel uses an unofficial protocol via WAHA, the system also enforces anti-ban and deliverability safeguards (per-number daily caps, warm-up ramp, randomized send delays, and human-like presence simulation).

The initial deployment processes a static CSV import of roughly 1,000 cold leads. The data model and ingestion path are designed so that a future lead source (such as Meta Ads or a landing page) can feed leads into the same lifecycle without redesign.

## Glossary

- **System**: The complete WhatsApp lead-reactivation application, including all services defined below.
- **Lead**: A potential consórcio customer represented by a record in the CRM, identified by a normalized phone number.
- **Operator**: An authenticated internal user (sales operator or consultant) who uses the CRM UI.
- **Consultant**: A human sales specialist who receives handed-off hot leads.
- **CRM**: The PostgreSQL-backed data store and domain model holding leads, qualification fields, scores, lifecycle state, and message history.
- **CRM_UI**: The minimal internal web interface for operators and consultants.
- **Lead_Importer**: The service that parses a CSV file and creates or updates Lead records.
- **Cadence**: The fixed sequence of five outreach touches (T1–T5) spanning days 0 through 15.
- **Cadence_Scheduler**: The service that enrolls a Lead into the Cadence by creating delayed jobs.
- **Cadence_Worker**: The service that executes a scheduled Cadence touch job.
- **Touch**: A single scheduled outreach message within the Cadence (T1 through T5).
- **Inbound_Handler**: The service that receives and processes WAHA inbound message webhooks.
- **Qualification_Agent**: The AI agent, persona "Marko," that conducts conversational qualification.
- **Message_Generator**: The component that produces personalized message text from a Lead's data.
- **Scoring_Engine**: The component that computes a Lead's qualification score.
- **Handoff_Manager**: The service that transfers a Lead to a Consultant and notifies relevant parties.
- **Lifecycle_Manager**: The component that owns and enforces Lead lifecycle state transitions.
- **Nurture_Scheduler**: The service that manages the monthly nurture flow for unresponsive leads.
- **Compliance_Manager**: The component that enforces LGPD opt-out and lawful-basis recording.
- **Anti_Ban_Controller**: The component that enforces per-number daily caps, warm-up ramp, and send pacing.
- **WAHA_Client**: The outbound integration component that calls the WAHA REST API (sendText, presence/typing, seen).
- **Auth_Service**: The Better Auth authentication service guarding the CRM_UI.
- **E.164**: The international phone number format (e.g. `+5511987654321`).
- **Lifecycle_State**: One of: `COLD_QUEUED`, `IN_CADENCE`, `REPLIED`, `QUALIFYING`, `HOT`, `WARM`, `DISQUALIFIED`, `CADENCE_EXHAUSTED`, `MONTHLY_NURTURE`, `OPTED_OUT`.
- **Opt_In_Status**: The lawful-basis flag for a Lead, one of: `opt_in`, `opt_out`.
- **Score**: An integer qualification value in the range 0–100 (before any dynamic bumps are capped).
- **Lance**: A bid amount used in consórcio contemplation; "lance reserve" is cash a Lead holds toward a bid.
- **Segment**: The consórcio product category for a Lead's interest (e.g. real estate, vehicle).
- **Send_Window**: The configured business-hours interval during which outbound messages are permitted.

## Requirements

### Requirement 1: Import Cold Leads from CSV

**User Story:** As an operator, I want to import a CSV list of cold leads into the CRM, so that previously interested contacts are available for automated reactivation.

#### Acceptance Criteria

1. WHEN an Operator submits a CSV file, THE Lead_Importer SHALL parse each row into a candidate Lead record.
2. WHEN the Lead_Importer parses a candidate Lead, THE Lead_Importer SHALL normalize the phone number to E.164 format.
3. IF a candidate Lead's phone number cannot be normalized to E.164 format, THEN THE Lead_Importer SHALL reject that row and record the row number and rejection reason in an import result report.
4. WHEN the Lead_Importer encounters a candidate Lead whose normalized phone number matches an existing Lead, THE Lead_Importer SHALL update the existing Lead rather than create a duplicate record, and SHALL count that row as an updated Lead in the import result report.
5. WHEN the Lead_Importer creates a new Lead, THE Lead_Importer SHALL set the Lead's Lifecycle_State to `COLD_QUEUED`.
6. WHEN an import completes, THE Lead_Importer SHALL return an import result report containing the count of created Leads, the count of updated Leads, and the count of rejected rows.

### Requirement 2: Accept Leads from Future Sources

**User Story:** As a product owner, I want the lead intake path to be source-agnostic, so that future sources such as Meta Ads or a landing page can feed leads into the same lifecycle without redesign.

#### Acceptance Criteria

1. THE System SHALL record the originating source on each Lead record.
2. WHEN a Lead is created from any source, THE System SHALL apply the same normalization, deduplication, and lifecycle rules used for CSV-imported Leads.
3. WHERE a Lead is created from an external real-time source, THE System SHALL enroll the Lead into the Cadence using the same enrollment process used for imported Leads.

### Requirement 3: Enroll Leads into the Reactivation Cadence

**User Story:** As an operator, I want each imported lead enrolled into a 5-touch cadence, so that reactivation outreach happens automatically without manual sending.

#### Acceptance Criteria

1. WHEN a Lead enters Lifecycle_State `COLD_QUEUED`, THE Cadence_Scheduler SHALL enroll the Lead into the Cadence and set the Lead's Lifecycle_State to `IN_CADENCE`.
2. WHEN the Cadence_Scheduler enrolls a Lead, THE Cadence_Scheduler SHALL create five delayed jobs corresponding to touches T1 through T5.
3. THE Cadence_Scheduler SHALL schedule T1 for day 0, T2 for day 3, T3 for day 7, T4 for day 11, and T5 for the interval day 14 through day 15, measured relative to the Lead's enrollment time.
4. WHEN the Cadence_Scheduler creates Cadence jobs, THE Cadence_Scheduler SHALL persist each scheduled job so that it can be cancelled before execution.

### Requirement 4: Cadence Touch Content

**User Story:** As an operator, I want each cadence touch to carry a distinct, purpose-built message, so that the sequence builds re-engagement rather than repeating the same pitch.

#### Acceptance Criteria

1. WHEN the Cadence_Worker executes touch T1, THE Message_Generator SHALL produce a context re-opener message personalized from the Lead's collected data.
2. WHEN the Cadence_Worker executes touch T2, THE Message_Generator SHALL produce a value-content message referencing market data.
3. WHEN the Cadence_Worker executes touch T3, THE Message_Generator SHALL produce a social-proof message referencing a recent contemplation of a similar profile.
4. WHEN the Cadence_Worker executes touch T4, THE Message_Generator SHALL produce a message offering a fresh simulation, an updated condition, or a free guide.
5. WHEN the Cadence_Worker executes touch T5, THE Message_Generator SHALL produce a breakup message that asks whether to remove the Lead from the list or whether continued contact still makes sense.
6. THE Cadence_Worker SHALL execute touch T5 for every Lead that reaches it without an earlier reply, opt-out, or block.
7. WHEN the Message_Generator produces a T1 message, THE Message_Generator SHALL produce text that differs per Lead based on that Lead's collected data.

### Requirement 5: State Guard Before Sending a Touch

**User Story:** As an operator, I want the worker to re-check a lead's state before sending each touch, so that the system never sends a stale message to someone who already replied, opted out, or was handed off.

#### Acceptance Criteria

1. WHEN the Cadence_Worker begins executing a Touch, THE Cadence_Worker SHALL re-read the Lead's current Lifecycle_State and block flag from the CRM.
2. IF the Lead's Lifecycle_State is `REPLIED`, `QUALIFYING`, `HOT`, `WARM`, `DISQUALIFIED`, or `OPTED_OUT` at Touch execution time, THEN THE Cadence_Worker SHALL skip the Touch and cancel remaining Cadence jobs for that Lead.
3. IF the Lead is marked as blocked at Touch execution time, THEN THE Cadence_Worker SHALL skip the Touch and cancel remaining Cadence jobs for that Lead.
4. IF the Lead's Opt_In_Status is `opt_out` at Touch execution time, THEN THE Cadence_Worker SHALL skip the Touch and cancel remaining Cadence jobs for that Lead.

### Requirement 6: Cadence Exhaustion and Monthly Nurture

**User Story:** As an operator, I want unresponsive leads to move into a low-frequency nurture flow, so that they are retained for future opportunities without daily outreach.

#### Acceptance Criteria

1. WHEN the Cadence_Worker completes touch T5 for a Lead that has not replied, THE Lifecycle_Manager SHALL set the Lead's Lifecycle_State to `CADENCE_EXHAUSTED`.
2. WHEN a Lead enters Lifecycle_State `CADENCE_EXHAUSTED`, THE Nurture_Scheduler SHALL transition the Lead to `MONTHLY_NURTURE` and schedule recurring monthly nurture outreach.
3. WHILE a Lead is in Lifecycle_State `MONTHLY_NURTURE`, THE Nurture_Scheduler SHALL schedule outreach at an interval of one calendar month between messages.
4. WHEN a Lead in Lifecycle_State `MONTHLY_NURTURE` replies, THE Inbound_Handler SHALL cancel scheduled nurture outreach and transition the Lead into qualification.

### Requirement 7: Handle Inbound Replies

**User Story:** As an operator, I want any inbound reply to immediately stop outreach and start qualification, so that the system responds to interest in real time and never talks over a responsive lead.

#### Acceptance Criteria

1. WHEN the Inbound_Handler receives a WAHA inbound message webhook, THE Inbound_Handler SHALL identify the corresponding Lead by normalized phone number.
2. WHEN the Inbound_Handler receives an inbound message for a Lead with pending Cadence jobs, THE Inbound_Handler SHALL cancel all remaining Cadence jobs for that Lead.
3. WHEN the Inbound_Handler processes the first inbound message from a Lead in Lifecycle_State `IN_CADENCE`, THE Lifecycle_Manager SHALL set the Lead's Lifecycle_State to `REPLIED` and then to `QUALIFYING`.
4. WHEN the Inbound_Handler records an inbound message, THE Inbound_Handler SHALL persist the message content and receipt timestamp in the Lead's message history.
5. IF the Inbound_Handler receives an inbound message that matches no existing Lead, THEN THE Inbound_Handler SHALL record the message and create a Lead record for the originating phone number.

### Requirement 8: AI Agent Persona and Behavior

**User Story:** As an operator, I want the AI agent to behave as a credible, honest consórcio specialist, so that conversations build trust and never expose the business to misinformation or reputational risk.

#### Acceptance Criteria

1. THE Qualification_Agent SHALL conduct conversations using the persona "Marko," an attentive and direct consórcio specialist.
2. IF a Lead directly asks whether the Qualification_Agent is an AI, THEN THE Qualification_Agent SHALL confirm that it is an AI.
3. IF a Lead asks for factual information that the Qualification_Agent does not hold in its available data, THEN THE Qualification_Agent SHALL state that it will check and SHALL trigger a Consultant handoff.
4. THE Qualification_Agent SHALL ask at most one qualifying question per outbound message.
5. WHEN the Qualification_Agent detects frustration or anger in an inbound message, THE Handoff_Manager SHALL transfer the Lead to a Consultant.
6. THE Qualification_Agent SHALL NOT state consórcio rates, group details, or contemplation outcomes that are absent from its available data.

### Requirement 9: Conversational Qualification and Field Extraction

**User Story:** As an operator, I want qualification to feel like a natural conversation, so that leads stay engaged while the system collects the data it needs.

#### Acceptance Criteria

1. WHEN a Lead enters Lifecycle_State `QUALIFYING`, THE Qualification_Agent SHALL begin with a single re-engagement question rather than presenting all qualification questions at once.
2. WHEN the Qualification_Agent processes an inbound message, THE Qualification_Agent SHALL extract every qualification field that the Lead has volunteered into the corresponding CRM fields.
3. WHEN the Qualification_Agent prepares its next question, THE Qualification_Agent SHALL ask only for qualification fields that remain unfilled.
4. THE CRM SHALL store qualification fields as nullable values that can be populated progressively across multiple messages.
5. WHEN the Qualification_Agent extracts a qualification field, THE CRM SHALL persist the extracted value on the Lead record.

### Requirement 10: Lead Scoring

**User Story:** As an operator, I want each lead scored on a 0–100 scale, so that I can prioritize the leads most likely to convert.

#### Acceptance Criteria

1. THE Scoring_Engine SHALL compute a base Score as the sum of the following weights, where each weight is added only when its condition holds: all qualification questions answered (+20); income compatible with desired value (+25); has a lance reserve (+20); clear objective of housing or investment (+15); replied within 10 minutes (+10); replied during the Send_Window business hours (+5); mobile number that is not VoIP (+5).
2. THE Scoring_Engine SHALL produce a base Score in the inclusive range 0 to 100.
3. WHEN no scoring condition holds for a Lead, THE Scoring_Engine SHALL assign that Lead a Score of 0.
4. WHEN the Lead's income is incompatible with the desired value or the Lead shows no real interest, THE Scoring_Engine SHALL assign that Lead a Score of 0.

### Requirement 11: Dynamic Scoring on Inbound Messages

**User Story:** As an operator, I want scores to update as the conversation progresses, so that behavioral buying signals raise a lead's priority in real time.

#### Acceptance Criteria

1. WHEN the Inbound_Handler records an inbound message during qualification, THE Scoring_Engine SHALL recompute the Lead's Score.
2. WHERE a Lead replies within 2 minutes of the prior outbound message, THE Scoring_Engine SHALL add 10 points to the Lead's Score.
3. WHERE an inbound message asks about available groups or lance, THE Scoring_Engine SHALL add 10 points to the Lead's Score.
4. WHERE an inbound message mentions an urgent deadline, THE Scoring_Engine SHALL add 15 points to the Lead's Score.
5. THE Scoring_Engine SHALL cap the Lead's Score at a maximum of 100 after applying behavioral additions.

### Requirement 12: Score-Based Classification

**User Story:** As an operator, I want leads classified by score band, so that the lifecycle reflects each lead's qualification outcome.

#### Acceptance Criteria

1. WHEN a Lead's Score is greater than or equal to 70, THE Lifecycle_Manager SHALL set the Lead's Lifecycle_State to `HOT`.
2. WHEN a Lead's Score is in the inclusive range 40 to 69, THE Lifecycle_Manager SHALL set the Lead's Lifecycle_State to `WARM`.
3. WHEN a Lead's Score is in the inclusive range 1 to 39, THE Lifecycle_Manager SHALL classify the Lead as cold within qualification.
4. WHEN a Lead's Score is 0, THE Lifecycle_Manager SHALL set the Lead's Lifecycle_State to `DISQUALIFIED`.

### Requirement 13: Hot-Lead Handoff

**User Story:** As a consultant, I want hot leads handed to me immediately, so that I can engage the highest-value prospects while their interest is fresh.

#### Acceptance Criteria

1. WHEN a Lead's Score crosses 70 during a conversation, THE Handoff_Manager SHALL transfer the Lead to a Consultant immediately regardless of the Lead's current funnel stage.
2. WHEN the Handoff_Manager transfers a Lead, THE Handoff_Manager SHALL record the handoff event and the triggering reason on the Lead record.
3. WHEN the Handoff_Manager transfers a Lead, THE Handoff_Manager SHALL make the Lead's collected qualification data and message history available to the Consultant in the CRM_UI.
4. WHEN a Lead is handed off, THE Qualification_Agent SHALL stop sending automated messages to that Lead.

### Requirement 14: Lead Lifecycle State Integrity

**User Story:** As an operator, I want lifecycle transitions to be well-defined, so that a lead is always in exactly one valid state and invalid transitions cannot occur.

#### Acceptance Criteria

1. THE Lifecycle_Manager SHALL maintain exactly one Lifecycle_State per Lead at all times.
2. THE Lifecycle_Manager SHALL permit transitions only along the defined path: `COLD_QUEUED` to `IN_CADENCE` to `REPLIED` to `QUALIFYING` to one of `HOT`, `WARM`, or `DISQUALIFIED`; and the parallel path `IN_CADENCE` to `CADENCE_EXHAUSTED` to `MONTHLY_NURTURE`.
3. WHEN a Lead opts out, THE Lifecycle_Manager SHALL transition the Lead to `OPTED_OUT` from any Lifecycle_State.
4. WHILE a Lead is in Lifecycle_State `OPTED_OUT`, THE Lifecycle_Manager SHALL reject any transition to another Lifecycle_State.
5. IF a transition request does not match a defined transition, THEN THE Lifecycle_Manager SHALL reject the transition and leave the Lead's Lifecycle_State unchanged.

### Requirement 15: LGPD Opt-Out Compliance

**User Story:** As a compliance owner, I want opt-out requests honored immediately and recorded, so that the operation complies with LGPD and stops messaging anyone who asks.

#### Acceptance Criteria

1. WHEN an inbound message expresses an opt-out request, THE Compliance_Manager SHALL set the Lead's Opt_In_Status to `opt_out`.
2. WHEN the Compliance_Manager sets a Lead's Opt_In_Status to `opt_out`, THE Lifecycle_Manager SHALL transition the Lead to `OPTED_OUT` and cancel all scheduled outreach for that Lead.
3. WHILE a Lead's Opt_In_Status is `opt_out`, THE System SHALL NOT send any outbound message to that Lead.
4. WHEN the Compliance_Manager changes a Lead's Opt_In_Status, THE Compliance_Manager SHALL record the Opt_In_Status value and an opt-in timestamp as the lawful-basis record.

### Requirement 16: Per-Number Daily Send Cap and Warm-Up Ramp

**User Story:** As an operator, I want outbound volume capped per number with a gradual ramp, so that an unofficial-protocol number is not banned by sending too much too soon.

#### Acceptance Criteria

1. THE Anti_Ban_Controller SHALL enforce a configurable per-number daily send cap.
2. IF the per-number daily send cap is reached, THEN THE Anti_Ban_Controller SHALL defer further outbound messages from that number until the next day.
3. THE Anti_Ban_Controller SHALL apply a configurable warm-up ramp that increases the daily send cap over a configured ramp period.
4. WHILE a number is within its first day of the warm-up ramp, THE Anti_Ban_Controller SHALL hold the daily send cap within the configured initial range.
5. THE Anti_Ban_Controller SHALL prevent the daily send count for any single number from exceeding that number's current daily send cap.

### Requirement 17: Send Pacing and Human-Like Presence

**User Story:** As an operator, I want outbound messages paced and made to look human, so that sending patterns do not trigger automated-behavior detection.

#### Acceptance Criteria

1. WHEN the WAHA_Client sends consecutive outbound messages from a number, THE Anti_Ban_Controller SHALL apply a randomized delay between sends within a configurable range.
2. WHEN the WAHA_Client prepares to send an outbound message, THE WAHA_Client SHALL simulate typing presence before sending.
3. WHEN the WAHA_Client receives an inbound message, THE WAHA_Client SHALL mark the inbound message as seen.
4. THE Anti_Ban_Controller SHALL restrict outbound sends to the configured Send_Window.

### Requirement 18: Number-Block Detection

**User Story:** As an operator, I want the system to stop sending from a banned number, so that detection does not escalate and remaining numbers stay healthy.

#### Acceptance Criteria

1. WHEN the System detects that one of its numbers is blocked, THE Anti_Ban_Controller SHALL set the block flag on that number.
2. WHILE a number's block flag is set, THE WAHA_Client SHALL NOT send outbound messages from that number.
3. WHEN a number's block flag is set, THE Anti_Ban_Controller SHALL stop scheduling new outbound sends from that number.

### Requirement 19: CRM Data Model

**User Story:** As an operator, I want a CRM that stores lead, qualification, scoring, and conversation data, so that all lead context lives in one place.

#### Acceptance Criteria

1. THE CRM SHALL store for each Lead a normalized E.164 phone number, originating source, Lifecycle_State, Opt_In_Status, opt-in timestamp, Score, and block flag.
2. THE CRM SHALL store qualification fields including segment, credit value, objective, lance reserve, and income, each as a nullable value.
3. THE CRM SHALL store the message history for each Lead, including direction, content, and timestamp for each message.
4. WHEN a Lead's Score or Lifecycle_State changes, THE CRM SHALL persist the updated value.

### Requirement 20: CRM User Interface

**User Story:** As an operator, I want a minimal internal interface, so that I can monitor and control leads without a full product.

#### Acceptance Criteria

1. THE CRM_UI SHALL display a list of Leads with their Lifecycle_State and Score.
2. WHEN an Operator opens a Lead, THE CRM_UI SHALL display the Lead's qualification fields and message history.
3. WHEN an Operator initiates a CSV import through the CRM_UI, THE CRM_UI SHALL display the import result report.
4. THE CRM_UI SHALL allow an Operator to view Leads that have been handed off to a Consultant.

### Requirement 21: Authentication and Access Control

**User Story:** As a compliance owner, I want the CRM restricted to authenticated users, so that lead personal data is not exposed to unauthorized parties.

#### Acceptance Criteria

1. IF an unauthenticated user requests a CRM_UI page or data endpoint, THEN THE Auth_Service SHALL deny access and redirect the user to authentication.
2. WHEN an Operator authenticates successfully through the Auth_Service, THE System SHALL grant access to the CRM_UI.
3. WHILE an Operator session is unauthenticated or expired, THE System SHALL deny access to Lead data.
