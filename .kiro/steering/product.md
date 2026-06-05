# Product

**Marko** is a WhatsApp lead-reactivation agent with an integrated CRM, built for a Brazilian _consórcio_ (group-purchase financing) sales operation.

## What it does

- **Ingests cold leads** from a source-agnostic intake (CSV today, Meta Ads / landing pages later) into a single `Lead` lifecycle.
- **Reactivates** leads through a fixed **5-touch / 15-day cadence** of WhatsApp messages.
- **Qualifies conversationally** the moment a lead replies, handing off to an AI agent that extracts qualification fields over multiple turns.
- **Scores leads continuously** from qualification and behavioral signals, classifying them into bands (HOT / WARM / cold / DISQUALIFIED).
- **Hands off hot leads** to a human consultant.
- **Nurtures** unconverted leads with a monthly message.

## Operating constraints

- **Near-zero marginal cost.** Runs continuously without per-message infrastructure cost (PostgreSQL-backed queue, no Redis).
- **LGPD compliance.** Honors opt-out as a terminal state; lawful-basis (opt-in/opt-out) is recorded in an append-only log. `OPTED_OUT` leads never receive outbound messages.
- **Anti-ban protection.** Outbound traffic uses unofficial WhatsApp numbers (via self-hosted WAHA), so all sends flow through one choke point enforcing per-number daily caps, warm-up ramp, randomized pacing, send-window restriction, human-like presence, and block detection.

## Domain vocabulary

- **Touch** — one scheduled outreach message in the cadence (T1–T5).
- **Cadence** — the 5-touch reactivation sequence; **Nurture** — the monthly follow-up.
- **Lance reserve** — cash a lead holds toward a winning bid; a qualification signal.
- **Send window** — local business hours during which sends are permitted.
- **Send guard** — the pure predicate that stops outreach on opt-out, block, or engaged/terminal lifecycle states.
