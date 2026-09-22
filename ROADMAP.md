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

- **Antigravity CLI 1.2.7** - authenticated qualification covers headless
  streaming, native permissions, cancellation, timeout, model selection,
  persistent sessions, named resume, resume last, native store creation,
  native transcript reads, and structured failures. Quota exhaustion remains
  uncaptured. See the
  [assessment](docs/research/2026-09-19-antigravity-cli-harness-assessment.md).

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

Planned, decided, not yet built. hcn reports live harness compaction as
`HarnessEvent` kind `compaction`. The design is settled in
[ADR 0009](docs/adr/0009-compaction-status-event.md); the decision map is
[#229](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/229).

Implementation is nine tickets. One is in `dungle-scrubs/lucid` and must merge
first, because lucid's context projector throws on an hcn event kind it does
not list.

- lucid [#296](https://github.com/dungle-scrubs/lucid/issues/296) - accept the
  kind. Blocks everything below.
- [#238](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/238) -
  the event, and claude's mapping. The tracer bullet.
- [#239](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/239) -
  pi's mapping.
- [#240](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/240) -
  antigravity's mapping.
- [#241](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/241) -
  muse's mapping, through the MSP view.
- [#242](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/242) -
  retire the reserved `context` event.
- [#243](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/243) -
  `compactionReporting` and the divergence surface.
- [#244](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/244) -
  descriptor re-verification across four harnesses. Unblocked; closes
  [#227](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/227).
- [#245](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/245) -
  audit the vendored hcn skill.

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
