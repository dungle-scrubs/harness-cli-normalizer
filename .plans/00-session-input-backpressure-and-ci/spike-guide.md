# Session Input, Pump Settlement, and Main-Branch CI - Spike Guide

## Assumptions

### A-001: Destroying adapter output streams settles held-pipe reads in Node and Bun

- **Impact if false:** Keep the process interface seam but replace `destroy()` with an
  adapter-specific abort or explicit iterator-disposal operation before Phase 2.
- **Experiment:** Under Node and Bun, use `node:child_process` to spawn a direct child that starts a
  descendant with inherited stdout and stderr, then exits. Begin async iteration of both output
  streams. Confirm the iterators remain pending after direct-child exit. Destroy both readable
  streams. Await both iterators and record whether they settle without terminating the descendant
  by process-pattern kill.
- **Pass criteria:** Both output iterators settle within the experiment's 1-second safety bound in
  Node 24+ and Bun 1.3. The direct child exit code remains observable. Destruction is idempotent.
- **Effort:** S (under 1 day)

## Evidence to Capture

1. Exact Node and Bun versions.
2. Direct-child exit code before pipe disposal.
3. Iterator state before disposal.
4. Iterator settlement result after disposal.
5. Second-disposal result.
6. Any runtime-specific error code.

## Decision Rule

- **Pass in both runtimes:** Implement `SpawnedProcess.disposeOutput()` with readable `destroy()`.
- **Fail in one runtime:** Keep one process interface but implement the failing runtime's supported
  abort mechanism in the adapter.
- **Fail in both runtimes:** Rework Phase 2 around explicit iterator ownership and cancellation.
  Do not fall back to queue-only cleanup.
