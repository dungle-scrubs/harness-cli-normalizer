/**
 * Execution layer: owns the process lifecycle for a harness session.
 *
 * It exposes openSession() and streamTurn(), which drive a CLI process via
 * injected {spawn, clock, signal} primitives and emit HarnessEvent values.
 * This module knows nothing about any chat protocol. Because it must run
 * identically on Node and Bun, it never imports child_process and never calls
 * process.kill directly; all process I/O and signalling flows through the
 * injected primitives instead.
 */
export {};
