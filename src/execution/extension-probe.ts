/**
 * The runtime probe for an extension-registered option (map #300, ticket
 * #302 decision 2): spawn the harness's own probe argv (pi: `--help`)
 * through the injected runner deps, under the caller's merged environment
 * and cwd, bounded, and answer whether the declared token appears. The
 * helper never writes stderr and never renders anything - the CLI gate
 * owns the refusal and the provenance line.
 *
 * Evidence base (ticket #301): `--help` is the only reliable probe -
 * extensions follow PI_CODING_AGENT_DIR (so the caller's env must apply),
 * `pi list` is blind to the subagent extension, and parse-level
 * acceptance is fooled by stock pi's early-exit `--version` path.
 */
import type { HarnessDescriptor, OptionProbe } from "../knowledge/descriptor.js";
import type { RunnerDeps } from "./deps.js";

export type ExtensionProbeReason = "flag-present" | "flag-absent" | "spawn-failed" | "timeout";

export interface ExtensionProbeOutcome {
  readonly ok: boolean;
  readonly reason: ExtensionProbeReason;
  /** The extension the option's probe names; rides refusal and provenance. */
  readonly providedBy: string;
  /** Human-readable probe shape for refusal detail, e.g. "pi --help". */
  readonly probeShape: string;
  /** Set when the probe ran but the flag was absent: the probe's exit code. */
  readonly exitCode?: number | null;
  /** Set when the probe never ran (spawn failure) - the adapter's message. */
  readonly startupError?: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/** Match against whitespace-normalized output so a wrapped help line
 * (the token split across a newline) still matches. */
const containsNormalized = (output: string, token: string): boolean =>
  output.replace(/\s+/g, " ").includes(token.replace(/\s+/g, " "));

export const probeExtensionOption = async (
  h: HarnessDescriptor,
  probe: OptionProbe,
  opts: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    /** Injectable for tests; production uses the 10 s bound. */
    readonly timeoutMs?: number;
  },
  deps: RunnerDeps,
): Promise<ExtensionProbeOutcome> => {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const argv = [h.bin, ...probe.argv];
  const base: Omit<ExtensionProbeOutcome, "ok" | "reason"> = {
    providedBy: probe.providedBy,
    probeShape: argv.join(" "),
  };
  const child = deps.spawn(argv, {
    stdin: "close",
    output: "pipe",
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });

  let out = "";
  let err = "";
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      deps.signal(child, "SIGTERM");
      resolve();
    }, timeoutMs);
  });
  const drained = (async () => {
    for await (const chunk of child.stdout) out += String(chunk);
    for await (const chunk of child.stderr) err += String(chunk);
  })();
  const exited = await Promise.race([child.exited, deadline]);
  if (timedOut) {
    // Best-effort reaping; the outcome is already decided.
    await Promise.race([child.exited, new Promise((r) => setTimeout(r, 2_000))]);
    void drained.catch(() => {});
    return { ...base, ok: false, reason: "timeout" };
  }
  if (timer !== undefined) clearTimeout(timer);
  await drained;

  const startupError = child.startupError?.() ?? null;
  if (startupError !== null) {
    return { ...base, ok: false, reason: "spawn-failed", startupError };
  }
  // A probe command that dies nonzero answered nothing; treat as a failed
  // probe, not as an absent extension (the distinction rides `reason`).
  if (exited !== 0) {
    return {
      ...base,
      ok: false,
      reason: "spawn-failed",
      startupError: `exit ${String(exited)}: ${(err || out).slice(0, 200)}`,
    };
  }
  const present =
    containsNormalized(out, probe.contains) || containsNormalized(err, probe.contains);
  return {
    ...base,
    ok: present,
    reason: present ? "flag-present" : "flag-absent",
    exitCode: exited,
  };
};
