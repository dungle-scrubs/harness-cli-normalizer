/**
 * Knowledge layer: owns harness descriptors as pure data.
 *
 * Each supported CLI (claude, codex, pi, muse) is described by an immutable
 * descriptor capturing its argv shapes, identity and store locations, flag
 * sets, and capability claims. The point of this module is to keep every fact
 * about a harness in one declarative place as data, rather than scattered
 * through branching logic. It is intentionally NOT responsible for
 * interpreting descriptors or executing processes - those live in the
 * interpretation and execution layers.
 */
export { claudeCode } from "./claude-code.js";
export { codexCli } from "./codex.js";
export * from "./descriptor.js";
export {
  SHARED_AUTH_MATCHERS,
  SHARED_LIMIT_MATCHERS,
  SHARED_TRANSPORT_MATCHERS,
  SHARED_UNAVAILABLE_MATCHERS,
} from "./matchers.js";
export { museCode } from "./muse.js";
export {
  type DescriptorSet,
  defaultDescriptors,
  OverrideRefusalError,
  parseOverrides,
} from "./overrides.js";
export { piCli } from "./pi.js";
