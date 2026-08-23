# harness-cli-normalizer

`hcn` is a CLI that drives four coding-agent harnesses through one surface. It
does two different jobs, and the difference matters enough to name: it
**normalizes** the harnesses' interfaces, and it **supervises** the runs it
starts. This file says which parts are which.

The `hcn` binary is the product. The layers inside it - knowledge,
interpretation, execution - are internal structure, not an install surface.
There is no supported way to import them.

## Language

### The two jobs

**Normalize**: express what four harnesses each do in one vocabulary, deciding
nothing. A normalizing part translates. Remove it and you write the translation
yourself, but the same runs succeed and fail at the same moments. _Avoid_:
"abstract", "wrap".

**Supervise**: own a policy, a clock, or state that no harness has. A
supervising part decides. Remove it and behaviour changes - runs that were
killed now hang, defaults shift, questions never get asked. _Avoid_: "manage",
"orchestrate" (an orchestrator is hcn's caller, not hcn).

**Divergence**: a dimension a harness cannot express, reported rather than
faked. Divergence reporting is the clearest normalizing act hcn performs - it
says "this is not available here" instead of pretending parity. _Avoid_:
"unsupported", "fallback".

### The domain

**Harness**: one coding-agent CLI that hcn drives - claude, codex, pi, or muse.
_Avoid_: "provider" (that is the model vendor), "agent" (that is the model).

**Descriptor**: the immutable data describing one harness - its flags, its
vocabularies, what it can express. Pure data, never behaviour. _Avoid_:
"config", "adapter".

**verifiedAgainst**: the harness CLI version a descriptor's facts were checked
against. It bounds hcn's correctness: outside that version, the facts are
unverified.

**Turn**: one prompt in, one result out. The unit hcn spawns and reports on.

**Session**: one harness process held open across several turns. Only claude
and pi have one.

**Turn option**: a per-call dimension hcn can express, keyed by a closed
vocabulary. A harness that cannot express one reports divergence.

**Failure class**: the named reason a turn failed, from a closed set. Naming it
is normalization; deciding whether to retry it is not - see `retryable` below.

**Refusal**: hcn declining before spawning, because the call cannot be
expressed on that harness. Exit code 2, distinct from a harness's own error.

**Native error**: the harness failing on its own arguments. Exit code 1,
labelled `NATIVE ERROR`, never confused with a refusal.

**Escalation**: hcn's protocol for a model to ask its caller a question - a
preamble in, a fenced block out. No harness offers a headless equivalent.

## The scope test

hcn **supervises one process at a time, and nothing wider.** A feature belongs
when it normalizes a harness difference, or supervises one process hcn spawned
for as long as that process runs. Anything tracking or storing state across
process boundaries belongs to the caller, because only the caller knows what a
unit of work is.

Recorded as ADR 0007. `AGENTS.md` carries it as the test applied before adding
functionality.

## What hcn normalizes

These translate and decide nothing:

- argv construction and per-harness flag spellings
- the `HarnessEvent` vocabulary and the exit-code contract
- failure **classification** - reading a stream and naming what happened
- the tool vocabulary, with `native:` passthrough for names hcn cannot vouch for
- access presets rendered per harness (`--tools`, `--sandbox`, category switches)
- session store paths
- divergence reporting

## What hcn supervises

These own state, a clock, or a policy that no harness has. Each is deliberate.

- **The escalation preamble.** hcn writes instructions into the model's context.
  Furthest from normalization: hcn becomes a participant in the conversation,
  and the run's output is partly downstream of hcn's own text.
- **Killing on stall or deadline.** hcn ends the child process and synthesizes
  the failure.
- **The stall clock.** `stall` appears in no descriptor. hcn invented the idea
  that a turn can be too quiet.
- **`retryable`.** No harness says whether a caller should try again. hcn
  decides, and the whole fallback walk runs on that decision.
- **The defaults profile.** effort medium, autonomy off, discovery on, sandbox
  workspace-write. These are hcn's opinions about how a bare run should behave.
- **Queued sends.** In a session, hcn holds input the harness has not accepted
  yet, and owes the caller an account of what became of it.

## Relationships

- A **descriptor** describes one **harness** and is pinned to a
  **verifiedAgainst** version
- A **turn option** the descriptor cannot express produces **divergence**
- A **session** holds many **turns**; only harnesses with a session mode have one
- A **refusal** happens before spawn; a **failure class** after it
- **Escalation** ends a turn successfully with cause `awaiting-input`

## Flagged ambiguities

- **"Library API"** is used two ways and both are true. hcn ships no importable
  library: the binary is the product. But `hcn session --json` has named
  operations, typed arguments, typed responses, and ordering rules, which is an
  API by shape. The first claim is about packaging, the second about interface.
  Neither cancels the other, and the README should say which it means.

- **"Normalizer"** describes hcn's identity but not all of its code. Six parts
  supervise, listed above. Calling the whole product a normalizer overstates
  roughly a third of it.

- **"Question"** means two different things across the harnesses. A *permission
  prompt* is the harness asking about its own tool use, and every harness has
  one. An *open decision question* is the model asking about the work, and no
  harness can answer one headlessly. **Escalation** means only the second.

- **"Provider"** is the model vendor on pi, not the harness and not the model.
  hcn's `--provider` flag is pi-only for this reason.
