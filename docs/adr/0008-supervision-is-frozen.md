# Supervision is frozen

Status: accepted 2026-09-20. The four named surfaces are marked for the
maintainer's own review; this ADR does not settle any of them.

hcn's supervising parts are capped at the list in `CONTEXT.md`
("What hcn supervises"). A new supervising part, or a widening of one that
exists so it owns a new decision, is added only when the maintainer asks for it
in the request. An agent or contributor that finds a candidate records it and
stops.

## Why this exists

ADR 0007 drew a boundary: hcn supervises one process at a time and nothing
wider. That boundary held. Nothing since has crossed a process boundary.

It does not limit how much can be added *inside* the boundary. A second clock,
a per-turn token budget, another permission category hcn answers on its own -
each one supervises a single process for as long as it runs, so each one passes
ADR 0007. Supervision grows one reasonable feature at a time. The normalizing
side cannot grow this way: it grows when a harness ships or changes a flag, and
those are external events.

A review on 2026-09-20 named four supervising bundles and made the point that
these, not the transcript reader, are the part that grows every time someone
asks for a feature:

1. Liveness policing - `--timeout` as an hcn-enforced wall clock, `--stall` as a
   per-turn inactivity budget, and child cleanup before `done`.
2. The native-approvals responder - `--native-approvals` puts hcn in the loop on
   Codex permission gates, with decision ids, conflicting-re-answer refusal, and
   an answer right that expires when the request clears.
3. Policy translation - `--access`, `--tools`, `--sandbox`, `--isolation
   tool-free`, and `--autonomy` rendered into six native spellings.
4. Retry steering - the `retryable` bit, the effort ladders, and the documented
   fallback chain.

## What the rule covers

The baseline is the "What hcn supervises" list in `CONTEXT.md`. The rule binds
to that list, which is why the list was corrected in the same change (see
pushback 2 below).

**Needs the maintainer to ask:**

- A new supervising part: hcn decides something no harness decides, holds state
  no harness holds, or runs a clock no harness runs.
- Widening one that exists so it owns a new decision: another approval category
  hcn answers, another clock, another entry in the defaults profile, a new
  dimension on `retryable`.

**Not an addition, so no ask:**

- Rendering an existing preset onto a harness being added. Same policy, one more
  spelling in one more descriptor.
- Fixing a supervising part that behaves wrong: a clock that misfires, a failure
  class classified wrong, an approval conflict resolved wrong.
- Removing supervision, or handing a policy back to a harness that gained the
  native mechanism. Shrinking needs no permission.
- Reporting a new observation: an event, a field, a divergence. Reporting is
  normalization.

## The pushback, and what survived it

Four arguments were made against the rule as stated. Three changed it.

1. **Two of the four named bundles do not grow on request.** Access rendering is
   descriptor data: a closed value vocabulary (`read | write`), one `renders`
   entry per harness, and a null render that produces divergence instead of
   invented behaviour. `retryableOf` is one pure function over the closed
   `FailureClass` union. Both grow when the harness roster grows or a failure
   class is added. Neither grows when someone asks for a feature. The two that
   do are the native-approvals responder (1,416 lines across knowledge,
   interpretation, and execution, with its own state machine) and the liveness
   clocks, which are small today and are where "add an idle timeout" or "add a
   token budget" will land. Effect: none on what the rule covers. Recorded so
   the later review starts from the right ranking rather than treating the four
   as equal.

2. **The inventory the rule binds to was stale.** `CONTEXT.md` listed eight
   supervising parts and did not list the native-approvals responder, the
   largest of them. A freeze measured against an inventory that misses its
   biggest item does not bind. Effect: the list is corrected in this change, and
   the rule cites it.

3. **"No more supervision features", read literally, fires on routine work.**
   Adding a seventh harness means rendering the access preset into its native
   spelling, which is supervision under the review's reading. That would need an
   exemption every time a harness ships, and a rule that needs routine
   exemptions stops being consulted. Effect: the non-trigger list above.

4. **The rule as stated binds on new parts; most of the risk is inside the four
   that exist.** Another Codex approval category answered by hcn is not a new
   feature by any natural reading, and it is exactly the growth the review
   described. Effect: the trigger list covers widening as well as adding. This
   clause is the one the maintainer did not state. Strike it if the freeze was
   meant for new surfaces only.

What was not argued: that the rule costs too much. Approval is one sentence, the
maintainer is the only approver, and the failure the rule prevents is drift by
accumulation, which is the failure that produced ADR 0007.

## Consequences

- Four surfaces are marked for the maintainer's own review, in this order of
  growth risk: the native-approvals responder, the liveness clocks, access and
  tool and sandbox and autonomy rendering, `retryable` with the fallback ladder.
  This ADR settles none of them and retracts nothing.
- A declined candidate goes in `ROADMAP.md` under "Declined - supervision" with
  the date and the reason. Without a record the same candidate returns and is
  judged from scratch, which is how the product drifted before ADR 0007.
- The escalation preamble stays the furthest-from-normalization part hcn has. If
  a harness ships a native channel for a model's open question, normalizing onto
  it is a removal and needs no ask.
- No code changes. The rule governs what is added next.

## Rejected alternative

Leave ADR 0007 as the only gate and judge each supervising feature on its
merits. Rejected because that is the state ADR 0007 was written to end, one
level down: every candidate is reasonable alone, the boundary test passes, and
the surface grows anyway. The gate that catches it has to bind on the category,
not on the individual feature.
