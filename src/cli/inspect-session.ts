import { buildSessionArgv, buildTurnEnv } from "../interpretation/argv.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { resolveSessionMemory } from "../interpretation/resolve-options.js";
import { mergeToolMaps } from "../interpretation/tool-vocabulary.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import {
  memoryFlagOf,
  parseCommonFlags,
  parseSessionPermissionOptions,
  parseSettingSourcesValue,
  resumeIdOf,
  splitPassthrough,
} from "./args.js";
import { ConfigError, loadProjectConfig, loadUserConfig } from "./config.js";
import { resolveLaunchEnvironment } from "./launch-environment.js";
import { writeProvenance } from "./provenance.js";
import { refusalOf, refuse } from "./refuse.js";
import { runtimeCompatibility } from "./runtime-compatibility.js";

/** The id a session preview names when the caller names none: a stable,
 * well-formed UUID, so the previewed argv is the same on every run
 * instead of a fresh random id each time. */
const PREVIEW_SESSION_ID = "00000000-0000-4000-8000-000000000000";

const SESSION_PREVIEW_OPTIONS = new Set([
  "argv",
  "context-window",
  "cwd",
  "effort",
  "json",
  "memory",
  "no-memory",
  "mode",
  "model",
  "prompt",
  "provider",
  "resume",
  "runtime",
  // issue #443: --session-id names a FRESH session, --resume a resumed
  // one; both are previewable, and neither is required.
  "session-id",
  // issue #443: the permission dimensions a session spawn accepts, parsed
  // and rendered by the same owners a one-shot turn uses.
  "tools",
  "exclude-tools",
  "no-tools",
  "autonomy",
  "no-autonomy",
  "access",
  // issue #457: the setting-source selection a claude session accepts.
  "setting-sources",
]);

/** Session startup has no prompt and uses no launch-only defaults. */
export async function inspectSessionRuntime(
  harness: HarnessDescriptor,
  args: string[],
): Promise<boolean> {
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(args, { nativeSettingsFingerprint: true });
  } catch (error) {
    refuse(
      {
        issue: "invalid-option-value",
        message: error instanceof Error ? error.message : String(error),
      },
      false,
    );
    return true;
  }
  const values = parsed.values as Record<string, unknown>;
  if (values.mode !== "headless-session") return false;
  // The runtime inspection reports what the INSTALLED harness accepts;
  // the argv preview reports the argv hcn would spawn. Both build the
  // session argv, so the preview and the spawn agree by construction.
  const wantRuntime = values.runtime === true;
  const wantArgv = values.argv === true;
  if (!wantRuntime && !wantArgv) return false;
  const unsupported = Object.keys(values).filter((key) => !SESSION_PREVIEW_OPTIONS.has(key));
  if (
    unsupported.length ||
    parsed.positionals.length ||
    splitPassthrough(args).passthrough.length
  ) {
    refuse(
      {
        issue: "invalid-option-value",
        message: `Unsupported persistent session preview options: ${unsupported.join(", ") || "positional or passthrough arguments"}`,
      },
      false,
    );
    return true;
  }
  // Which session the preview names: --resume previews a resumed one,
  // --session-id a fresh one, neither the stable placeholder id. The
  // runtime inspection keeps its narrower rule - it reports a RESUME, so
  // it needs the id that names one.
  let sessionId = PREVIEW_SESSION_ID;
  let isResume = false;
  let resumeId: string | undefined;
  try {
    resumeId = resumeIdOf(values);
  } catch (error) {
    if (!(error instanceof ArgvRefusalError)) throw error;
    refuse(refusalOf(error), false);
    return true;
  }
  if (wantRuntime) {
    const resume = values.resume;
    if (typeof resume !== "string" || !harness.resume.idShape.test(resume)) {
      refuse(
        {
          issue: "invalid-option-value",
          message: "Persistent session runtime inspection requires a valid --resume ID",
        },
        false,
      );
      return true;
    }
    sessionId = resume;
    isResume = true;
  } else {
    if (resumeId !== undefined) {
      const flag = values.resume !== undefined ? "--resume" : "--session-id";
      if (!harness.resume.idShape.test(resumeId)) {
        refuse(
          {
            issue: "invalid-option-value",
            message: `${flag} ${JSON.stringify(resumeId.slice(0, 64))} is not a ${harness.name} session id`,
            supported: [`a session id matching ${String(harness.resume.idShape)}`],
          },
          false,
        );
        return true;
      }
      sessionId = resumeId;
      isResume = values.resume !== undefined;
    }
  }
  const cwd = typeof values.cwd === "string" ? values.cwd : undefined;
  try {
    // issue #443: the permission dimensions a session spawn accepts,
    // through the same parser and the same renderers a one-shot turn
    // uses. The toolMap the config tiers carry is merged (project over
    // user) exactly as the run path merges it.
    const permissions = parseSessionPermissionOptions(values);
    const settingSources = parseSettingSourcesValue(values["setting-sources"]);
    const userConfig = loadUserConfig()?.config;
    const projectConfig = loadProjectConfig()?.config;
    const mergedToolMap = mergeToolMaps({
      user: userConfig?.toolMap,
      project: projectConfig?.toolMap,
    });
    const toolMap = Object.keys(mergedToolMap).length > 0 ? mergedToolMap : undefined;
    const argv = buildSessionArgv(harness, {
      sessionId,
      isResume,
      model: typeof values.model === "string" ? values.model : undefined,
      effort: typeof values.effort === "string" ? values.effort : undefined,
      provider: typeof values.provider === "string" ? values.provider : undefined,
      contextWindow:
        typeof values["context-window"] === "string" ? Number(values["context-window"]) : undefined,
      ...(settingSources === undefined ? {} : { settingSources }),
      ...permissions,
      ...(toolMap === undefined ? {} : { toolMap }),
    });
    const resolved = resolveSessionMemory(memoryFlagOf(values), {
      project: projectConfig,
      user: userConfig,
    });
    const turnEnv = buildTurnEnv(harness, { memory: resolved.memory }, "launch");
    const launchEnv = resolveLaunchEnvironment(harness, userConfig, process.env);
    writeProvenance(harness.name, launchEnv.provenance, []);
    process.stderr.write(`provenance: memory = ${resolved.memory} (${resolved.tier})\n`);
    if (Object.keys(turnEnv).length > 0) {
      process.stderr.write(
        `env: ${Object.entries(turnEnv)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")}\n`,
      );
    }
    process.stderr.write(`argv: ${argv.join(" ")}\n`);
    if (wantRuntime) {
      process.stdout.write(
        `${JSON.stringify({ v: 1, argvKind: "redacted-preview", argv, ...(await runtimeCompatibility(harness, { cwd, env: { ...launchEnv.env, ...turnEnv } })) })}\n`,
      );
      return true;
    }
    // The plain preview is the argv array, like the turn preview: the
    // diagnostics go to stderr, stdout carries the argv alone.
    process.stdout.write(`${JSON.stringify(argv)}\n`);
  } catch (error) {
    if (error instanceof ConfigError) {
      refuse({ issue: "invalid-option-value", message: `config error: ${error.message}` }, false);
      return true;
    }
    if (!(error instanceof ArgvRefusalError)) throw error;
    refuse(refusalOf(error), false);
  }
  return true;
}
