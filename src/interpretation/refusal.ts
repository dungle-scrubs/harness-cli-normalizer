/**
 * Structured argv refusals: closed issue vocabulary and the typed error
 * that carries harness, option, facet, and supported alternatives. The
 * helper builds the message from those fields so the two cannot drift - a
 * consumer branching on `issue` never has to parse English.
 */

import type { DiscoveryFacet, HarnessName, TurnOptionKey } from "../knowledge/descriptor.js";
import { deepFreeze } from "../knowledge/descriptor.js";

export const REFUSAL_ISSUES = deepFreeze([
  "unsupported-option",
  "unsupported-option-facet",
  "unsupported-on-resume",
  "invalid-option-value",
  "unknown-effort",
  "unknown-model",
  "invalid-env",
  "invalid-tool-grant",
  "unknown-tool-name",
  "mutually-exclusive-options",
  "prompt-flag-injection",
  "no-autonomy-mode",
  "no-session-mode",
] as const);
export type RefusalIssue = (typeof REFUSAL_ISSUES)[number];

/** The option a refusal names: turn-option spec keys (descriptor tables)
 * plus the tool-list dimensions and autonomy, which render via dedicated
 * descriptor fields rather than a spec table. Kept closed so consumers can
 * branch on it without a default arm. */
export type RefusalOption =
  | TurnOptionKey
  | "tools"
  | "excludeTools"
  | "skills"
  | "autonomy"
  | "questions"
  | `discovery.${string}`;

/** One helper builds the message from the structured fields so message and
 * fields cannot drift. Every message names an alternative, not only a
 * negation, so an agent can pivot without reading the descriptor. */
export const buildRefusalMessage = (
  issue: RefusalIssue,
  harness: HarnessName,
  option?: RefusalOption,
  facet?: DiscoveryFacet,
  supported: readonly string[] = [],
  detail?: string,
): string => {
  const supportedStr =
    supported.length > 0 ? `supported: ${supported.join(", ")}` : "supported: (none)";
  const facetSuffix = facet ? ` facet ${JSON.stringify(facet)}` : "";
  const optionPart = option
    ? ` option ${JSON.stringify(option)}${facetSuffix}`
    : facet
      ? ` facet ${JSON.stringify(facet)}`
      : "";
  const detailSuffix = detail ? ` (${detail})` : "";
  switch (issue) {
    case "unsupported-option":
      return `${harness} cannot express${optionPart}${detailSuffix}; ${supportedStr} - drop the option or route this work to a harness that supports it`;
    case "unsupported-option-facet":
      return `${harness} cannot express discovery${facetSuffix}${detailSuffix}; ${supportedStr} - drop the facet or route this work to a harness that supports it`;
    case "unsupported-on-resume": {
      const name = option
        ? JSON.stringify(option) + (facet ? `:${facet}` : "")
        : facet
          ? JSON.stringify(facet)
          : "option";
      return `${name} cannot be expressed on resume for ${harness}${detailSuffix}; ${supportedStr} - re-launch instead of resuming or drop the option`;
    }
    case "invalid-option-value":
      return `invalid value for${optionPart} on ${harness}${detailSuffix}; ${supportedStr} - use a supported value instead`;
    case "unknown-effort":
      return `unknown effort for ${harness}${detail ? ` ${JSON.stringify(detail)}` : ""}; ${supportedStr} - use one of the ladder values`;
    case "unknown-model":
      return `unknown ${harness} model${detail ? ` ${JSON.stringify(detail)}` : ""}; ${supportedStr} - use one of the supported models`;
    case "invalid-env":
      return `invalid env key or value for ${harness}${detailSuffix}; ${supportedStr} - keys must match ^[A-Za-z_][A-Za-z0-9_]*$ and contain no NUL`;
    case "invalid-tool-grant":
      return `tool grant for ${harness} contains an empty entry or a comma; a blank tool flag value grants nothing detectable, and a comma inside one name silently splits the grant; ${supportedStr} - provide comma-free, non-empty tool names as separate entries`;
    case "unknown-tool-name":
      return `${harness} cannot compute a tool complement around an unknown name${detailSuffix}; ${supportedStr} - exclude only curated names, or pass the unknown name through an include list instead`;
    case "mutually-exclusive-options":
      return `${harness} cannot combine${optionPart}${detailSuffix}; ${supportedStr} - pass exactly one of them`;
    case "prompt-flag-injection":
      return `positional prompt may not start with '-'; it would be parsed as a flag by ${harness}${detailSuffix}; ${supportedStr} - remove leading '-' or prefix with a space`;
    case "no-autonomy-mode":
      return `${harness} has no unattended-run flag; ${supportedStr} - drop autonomy or route to a supporting harness (claude --dangerously-skip-permissions, codex/muse --yolo)`;
    case "no-session-mode":
      return `${harness} declares no persistent headless session mode; ${supportedStr} - use hcn run --resume <id>`;
    default: {
      const exhaustive: never = issue;
      return `${exhaustive as string} for ${harness}${optionPart}${detailSuffix}; ${supportedStr}`;
    }
  }
};

/** Raised when launch options would corrupt or subvert the spawned argv. */
export class ArgvRefusalError extends Error {
  readonly issue: RefusalIssue;
  readonly harness: HarnessName;
  readonly option?: RefusalOption;
  readonly facet?: DiscoveryFacet;
  readonly supported: readonly string[];
  /** D7: which harnesses DO express the refused option, native spellings
   * included. Derived by the raise site from descriptors - absent when the
   * refusing layer has no descriptor set in scope. */
  readonly supportedBy?: ReadonlyArray<{ harness: string; spelling: string }>;
  /** D8: nearest-alternative suggestion for the CURRENT harness - keeps a
   * scanning agent on its chosen harness instead of switching. Curatorial
   * data set at the raise site; absent when no hint exists. */
  readonly hint?: string;
  constructor(args: {
    readonly issue: RefusalIssue;
    readonly harness: HarnessName;
    readonly option?: RefusalOption;
    readonly facet?: DiscoveryFacet;
    readonly supported?: readonly string[];
    readonly supportedBy?: ReadonlyArray<{ harness: string; spelling: string }>;
    readonly hint?: string;
    readonly detail?: string;
    readonly message?: string;
  }) {
    const message =
      args.message ??
      buildRefusalMessage(
        args.issue,
        args.harness,
        args.option,
        args.facet,
        args.supported ?? [],
        args.detail,
      );
    super(message);
    this.name = "ArgvRefusalError";
    this.issue = args.issue;
    this.harness = args.harness;
    this.option = args.option;
    this.facet = args.facet;
    this.supported = args.supported ?? [];
    this.supportedBy = args.supportedBy;
    this.hint = args.hint;
  }
}
