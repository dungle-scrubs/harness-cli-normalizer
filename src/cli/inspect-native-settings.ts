import { homedir } from "node:os";
import { inspectNativeSettings } from "../execution/native-settings.js";
import type { HarnessName } from "../knowledge/descriptor.js";
import type { NativeSettingsResult } from "../knowledge/native-settings.js";
import { type parseCommonFlags, resumeIdOf } from "./args.js";

export function inspectNativeSettingsCommand(
  harness: HarnessName,
  parsed: ReturnType<typeof parseCommonFlags>,
  hasSeparator: boolean,
): void {
  let result: NativeSettingsResult;
  try {
    const { values, positionals } = parsed;
    const allowed = new Set(["cwd", "json", "native-settings", "resume", "session-id"]);
    const sessionId = resumeIdOf(values);
    result =
      !hasSeparator &&
      positionals.length === 0 &&
      Object.keys(values).every((key) => allowed.has(key)) &&
      typeof values.cwd === "string" &&
      sessionId
        ? inspectNativeSettings(
            { cwd: values.cwd, harness, sessionId },
            {
              codexHome: process.env.CODEX_HOME,
              home: homedir(),
            },
          )
        : { harness, reason: "invalid-request", status: "unavailable", v: 1 };
  } catch {
    result = { harness, reason: "invalid-request", status: "unavailable", v: 1 };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "available" ? 0 : 2;
}
