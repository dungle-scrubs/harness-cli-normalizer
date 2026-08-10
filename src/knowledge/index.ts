/**
 * Knowledge layer: owns harness descriptors as pure data.
 *
 * Each supported CLI (claude, codex, pi, muse) is described by an immutable
 * descriptor capturing its argv shapes, identity and store locations, flag
 * sets, and capability claims. The point of this module is to keep every fact
 * about a harness in one declarative place as data, rather than scattered
 * through branching logic. It is intentionally NOT responsible for interpreting
 * those descriptors or for executing any process.
 */
export {};
