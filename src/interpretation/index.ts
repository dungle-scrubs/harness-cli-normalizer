/**
 * Interpretation layer: owns pure functions that operate over descriptors.
 *
 * This includes argv building, identity decoding, limit detection, and
 * capability queries. Every function here is total and side-effect free: it
 * performs no I/O and imports no side-effecting Node builtins. That purity is
 * test-enforced in later milestones, so nothing in this file may spawn a
 * process, touch the filesystem, or read the environment. It is NOT
 * responsible for handling streams or running anything.
 */
export {};
