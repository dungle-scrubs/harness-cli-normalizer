/**
 * Interpretation layer: owns pure functions that operate over descriptors.
 *
 * This includes argv building, identity decoding, limit detection, and
 * capability queries. Every function here is total and side-effect free: it
 * performs no I/O and imports no side-effecting Node builtins - purity is
 * test-enforced. It is NOT responsible for spawning processes or handling
 * streams; that is the execution layer's job.
 */
export * from "./argv.js";
export * from "./capabilities.js";
export * from "./context.js";
export * from "./dimensions.js";
export * from "./identity.js";
export * from "./limits.js";
export * from "./parse-resume.js";
export * from "./presence.js";
export * from "./resume-last.js";
export * from "./session-id.js";
export * from "./session-input.js";
export * from "./store.js";
export * from "./vocabulary.js";
