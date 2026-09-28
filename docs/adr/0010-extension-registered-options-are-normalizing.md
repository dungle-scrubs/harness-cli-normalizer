# Extension-registered options are normalizing

Status: accepted 2026-09-28.

An option whose expressibility depends on a harness extension installed on
the machine - first case: pi's `--agent`, registered by the subagent
extension - is **extension-registered**. The descriptor declares a runtime
probe beside the option's render (`argv`, match token, providing
extension); the CLI verifies the probe against the installed harness
before spawning, lazily, only when such an option is passed. A missing
extension refuses pre-spawn (`extension-option-unavailable`, exit 2)
naming the extension and the passthrough alternative; a verified pass
prints one provenance line.

This is classified as a **normalizing** act, not a supervising one.

## The argument

The probe translates what the *installed* harness's interface can express -
the same job the version-keyed descriptor facts do, with a wider
information basis: machine state beside the published version. The gate is
the existing refusal concept applied to that translation. It holds no
clock, keeps no state across runs, and decides nothing beyond
expressibility. Remove it and the same runs succeed and fail at the same
moments - the failure moves from an exit-2 refusal to the harness's own
`Error: Unknown option` - which is CONTEXT.md's own test for Normalize.

The published-version facts cannot carry this option at all: published pi
0.87.1 rejects the flag while the maintainer's install accepts it, same
version string, because an extension registers it. Only the installed
binary answers the question, so the translation asks it.

## The counterargument, recorded

A 2026-09-28 review could read the gate as supervision, and the reading is
defensible: hcn asks the binary a question no harness posed, before any
process exists, and it changes the observable failure mode - refusal
instead of native error - which meets the letter of CONTEXT.md's test for
Supervise ("remove it and behaviour changes"). The classification stands on
three properties the supervising parts do not share: nothing is decided
beyond *can this flag be spoken here*; no state outlives the process (the
probe runs per invocation, never cached - cross-run caching was declined on
the scope test); and the check is lazy, so runs that pass no such option
pay nothing. The frozen supervising list (ADR 0008) stays closed; nothing
joined it.

The maintainer asked for the feature, so the ADR 0008 gate is satisfied
under either classification; this ADR records which one the mechanism
actually has.

## The mechanisms (map #300)

- The `probe` declaration is ordinary shared descriptor data: any harness,
  any option kind. Only pi's agent declares one today.
- An execution-layer helper spawns the probe through the injected runner
  deps under the caller's merged environment (extensions follow the config
  dir env, so probe and spawn must see the same harness) and cwd, bounded.
- The CLI gates at the last pre-spawn point - after parse, resume guards,
  fingerprint exclusivity, and argv build - so a call refusing for another
  reason never probes.
- `capabilitiesOf` and the identity event are unchanged: the boolean means
  "the harness's interface can express this option"; machine truth lives
  in the gate, the provenance line, and `inspect --runtime`, which runs the
  declared probes and answers per machine.
