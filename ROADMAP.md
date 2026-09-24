# Roadmap

Planned work for hcn. Each item must pass the scope test in `AGENTS.md`.

## New harnesses

- **Junie CLI** - qualify a pinned stable release, then add a descriptor and
  support in the interpretation and execution layers. Verify headless streaming,
  approvals, cancellation, usage, and resume behavior. Blocked on an authenticated
  qualification because no Junie account or API key is available. Public and
  unauthenticated probes confirm the CLI shape but not execution behavior. See the
  [candidate research](docs/research/2026-09-19-junie-pricing-and-harness-fit.md).
- **Grok Build CLI** - add a descriptor and support in the interpretation and
  execution layers. Blocked: no Grok subscription to capture authenticated runs.

## Shipped harnesses

- **Popeye 0.1.0** - descriptor entry plus journal reader, session
  driving, and smoke wiring (RFC-02 P5). Verified: create/prompt
  snapshot turns, buffered pre-identity sends, close with grace,
  torn-tail report-only export. Deferred: full argv-corpus snapshot
  and hosted fixture re-capture.

- **Antigravity CLI 1.2.8** - authenticated qualification covers headless
  streaming, native permissions, cancellation, timeout, model selection,
  persistent sessions, named resume, resume last, native store creation,
  native transcript reads, and structured failures. Quota exhaustion remains
  uncaptured. See the
  [assessment](docs/research/2026-09-19-antigravity-cli-harness-assessment.md).
  The behavioural corpus behind that list was captured on 1.2.7
  (`test/fixtures/antigravity-1.2.7`) and stands; the anchor moved to 1.2.8
  when the capability tripwires were re-run on it
  (`test/fixtures/antigravity-1.2.8`).

## Provider configurations

- **OpenCode Go through Pi** - verify and document the subscription as a Pi
  provider configuration used through hcn. Check Go's dedicated endpoints,
  model selection, session headers, and subscription usage accounting with a
  harmless authenticated run. Keep billing credentials in the native provider
  configuration.
- **Ollama through Pi** - verify and document the cloud subscription as a Pi
  provider configuration used through hcn. Check authentication, cloud model
  selection, tool use, and subscription usage accounting with a harmless
  authenticated run. Keep billing credentials in the native provider
  configuration.

## Compaction reporting

Partly built. hcn reports live harness compaction as
`HarnessEvent` kind `compaction`. The design is settled in
[ADR 0009](docs/adr/0009-compaction-status-event.md); the decision map is
[#229](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/229).

**All nine have shipped.** The event exists; claude, pi, antigravity and muse
report on it; a caller can ask which harnesses do and set a stall budget above
the measured pause bands; the descriptors are re-verified; the vacancy the
event replaced is gone; and the vendored skill matches the shipped CLI.

- lucid [#296](https://github.com/dungle-scrubs/lucid/issues/296) - **shipped.**
  Lucid accepts the kind, classes it lossless and renders it. It had to land
  first, because lucid's context projector throws on an hcn event kind it does
  not list.
- [#238](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/238) -
  **shipped.** The event vocabulary, and claude's mapping end to end. The
  fixture was re-captured live: 50467 to 4182 tokens over 47.1 s. That capture
  also showed claude sending two `compacting` status records for one
  compaction, so starts repeat and a counting consumer counts ends.
- [#239](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/239) -
  **shipped.** pi's mapping. `threshold` normalizes to `auto`; a resultless
  end record reports `aborted` or `failed`, because pi drops the `result` key
  rather than setting it to null as its docs say. A pi compaction can also
  land outside the turn markers and reach the caller on the next turn.
- [#240](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/240) -
  **shipped.** antigravity's mapping. One `checkpoint` record in state DONE,
  carrying only a duration, so `compacted` is the only state it can report.
- [#241](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/241) -
  **shipped.** muse's mapping, through the MSP view - its stdout carries no
  compaction signal at all. The attach-timing risk closed by mechanism: the
  view is a durable cursor-paged log, so hcn's first page is taken with no
  anchor and still returns a compaction that ran before the observer attached.
- [#242](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/242) -
  **shipped.** The reserved `context` event is gone, with its decoder, its
  `DROPPABLE_KINDS` entry and the `contextHook` descriptor field on all six
  harnesses. This also resolved RFC-02 open question 3, which had recommended
  keeping the kind.
- [#243](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/243) -
  **shipped.** `compactionReporting` on every descriptor, carried onto the
  identity event and printed by inspect, so silence is never read as no
  compaction happening. Codex and cursor are null: both compact, neither
  reports. No per-run divergence line - nobody asks for the key.
- [#244](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/244) -
  descriptor re-verification across four harnesses. **Done**: pi, cursor and
  antigravity record their probed compaction facts, pi anchors 0.87.0,
  antigravity anchors 1.2.8, and muse records its moved build at an unchanged
  1.3.0. Closes
  [#227](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/227).
- [#245](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/245) -
  **shipped.** The vendored skill no longer documents the retired `context`
  event, carries the compaction contract, the reporting roster and the pause
  bands, and its claim check now reads the roster off the binary so it cannot
  drift silently. Source: `~/dev/skills/skills/vendor/hcn` at f590116.

Nothing here is takeable: the map is complete.

## Declined - supervision

ADR 0008 closed the supervising list in `CONTEXT.md`. A supervising candidate
declined under that rule is recorded here with its date and reason, so the next
session that thinks of it reads the answer instead of judging it from scratch.

### Teach the inactivity clock about compaction

Declined 2026-09-22, by the maintainer, while resolving the compaction map
(#229, design ticket #236, recorded as ADR 0009).

The candidate: pause the supervisor's inactivity clock between a
`compaction` event's `started` state and its end state, so a long compaction
pause is not reported as a stall. ADR 0008 names the liveness clocks as a
marked supervising surface, so this needed the maintainer's ask.

The reason it was declined: the pause can only be taken on the three
harnesses that announce a start (claude, pi, muse), and those are not where
the risk sits. Codex and cursor have the longest measured pauses (24 to 32 s
and 25 to 39 s) and announce nothing at all, so no clock change can reach
them. Antigravity announces no start either. A change that covers only the
harnesses already telling the caller what is happening buys little and widens
a frozen surface.

What was done instead: the measured pause bands per harness are documented,
so a caller sets `--stall` above them. `--stall` is opt-in and unset by
default, so nothing regresses today.
