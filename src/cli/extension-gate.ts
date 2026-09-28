/**
 * The pre-spawn gate for extension-registered options (map #300, ticket
 * #302 decision 2): when a parsed option's spec declares a probe, verify
 * against the installed harness BEFORE anything is spawned - the same
 * pre-spawn seam as the resume guard. Fail raises the exit-2
 * `extension-option-unavailable` refusal (#303 decision 1); pass returns
 * the verified records so the caller prints the lazy provenance line
 * (#303 decision 2). Bare runs and option-free runs never probe (map
 * out-of-scope line).
 */

import type { ExtensionProbeOutcome } from "../execution/extension-probe.js";
import { ArgvRefusalError, type RefusalOption } from "../interpretation/refusal.js";
import type { HarnessDescriptor, TurnOptionKey } from "../knowledge/descriptor.js";
import { TURN_OPTION_KEYS } from "../knowledge/descriptor.js";

export type ExtensionProbeFn = (
  h: HarnessDescriptor,
  probe: import("../knowledge/descriptor.js").OptionProbe,
  opts: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<ExtensionProbeOutcome>;

export interface ExtensionVerified {
  readonly option: TurnOptionKey;
  readonly value: string;
  readonly providedBy: string;
}

const detailOf = (outcome: ExtensionProbeOutcome): string =>
  outcome.reason === "flag-absent"
    ? `${outcome.providedBy} absent: ${outcome.probeShape} output carries no such flag`
    : outcome.reason === "timeout"
      ? `probe could not run (${outcome.probeShape}): timed out after 10 s`
      : `probe could not run (${outcome.probeShape}): ${outcome.startupError ?? "unknown failure"}`;

export const gateExtensionOptions = async (
  h: HarnessDescriptor,
  opts: { readonly agent?: string } & Record<string, unknown>,
  extra: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  probe: ExtensionProbeFn,
): Promise<readonly ExtensionVerified[]> => {
  const verified: ExtensionVerified[] = [];
  for (const key of TURN_OPTION_KEYS) {
    const spec = h.turnOptions[key];
    if (spec === undefined || spec.probe === undefined) continue;
    const raw = opts[key];
    if (raw === undefined) continue;
    const outcome = await probe(h, spec.probe, extra);
    if (!outcome.ok) {
      throw new ArgvRefusalError({
        issue: "extension-option-unavailable",
        harness: h.name,
        option: key as RefusalOption,
        supported: [
          `install the ${outcome.providedBy}`,
          `pass the flag natively after -- (hcn run ${h.name} -- ...)`,
        ],
        detail: detailOf(outcome),
      });
    }
    verified.push({ option: key, value: String(raw), providedBy: outcome.providedBy });
  }
  return verified;
};

export const writeExtensionProvenance = (verified: readonly ExtensionVerified[]): void => {
  for (const v of verified) {
    process.stderr.write(
      `provenance: ${v.option} = ${JSON.stringify(v.value)} (${v.providedBy} verified)\n`,
    );
  }
};
