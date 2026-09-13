import type { HarnessName } from "../knowledge/descriptor.js";
import { HARNESS_NAMES } from "../knowledge/descriptor.js";
import type { InteractiveControlBody, InteractiveControlRecord } from "../knowledge/interactive.js";
import { INTERACTIVE_INTERFACES } from "../knowledge/interactive.js";
import { parseEnvEntries } from "./environment.js";
import { isNativeFolder } from "./native-path.js";
import { isUsableSessionId } from "./session-id.js";

export interface InteractiveControlAddress {
  readonly fd: number;
  readonly launchId: string;
}

export interface InteractiveRequest {
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly harness: HarnessName;
  readonly interface: string;
  readonly launchId: string;
  readonly sessionId: string;
  readonly startupPrompt?: string;
}

const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validStartupPrompt(prompt: string | undefined): boolean {
  return (
    prompt === undefined ||
    (prompt.length > 0 &&
      !prompt.includes("\0") &&
      new TextDecoder().decode(new TextEncoder().encode(prompt)) === prompt &&
      new TextEncoder().encode(prompt).byteLength <= 8192)
  );
}

function oneValue(args: readonly string[], flag: string): string | undefined {
  const positions = args.flatMap((word, index) =>
    index % 2 === 1 && word === flag ? [index] : [],
  );
  return positions.length === 1 ? args[(positions[0] ?? 0) + 1] : undefined;
}

/** An invalid request can be refused only over an unambiguous caller channel. */
export function interactiveControlAddress(
  args: readonly string[],
): InteractiveControlAddress | undefined {
  const launchId = oneValue(args, "--launch-id");
  const fdText = oneValue(args, "--control-fd");
  const fd = Number(fdText);
  if (
    !launchId ||
    !LAUNCH_ID.test(launchId) ||
    !fdText ||
    !/^\d+$/.test(fdText) ||
    !Number.isSafeInteger(fd) ||
    fd < 3 ||
    fd > 2_147_483_647
  )
    return undefined;
  return { fd, launchId };
}

export function parseInteractiveRequest(args: readonly string[]): InteractiveRequest | undefined {
  const control = interactiveControlAddress(args);
  const harness = HARNESS_NAMES.find((name) => name === args[0]);
  const allowed = [
    "--interface",
    "--launch-id",
    "--resume",
    "--cwd",
    "--control-fd",
    "--env",
    "--startup-prompt",
  ];
  if (!control || !harness || args.length < 11 || args.length % 2 !== 1) return undefined;
  const environmentEntries: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    if (!allowed.includes(flag) || (flag !== "--env" && seen.has(flag))) return undefined;
    seen.add(flag);
    if (flag === "--env") environmentEntries.push(args[index + 1] ?? "");
  }
  const iface = oneValue(args, "--interface");
  const sessionId = oneValue(args, "--resume");
  const cwd = oneValue(args, "--cwd");
  const startupPrompt = oneValue(args, "--startup-prompt");
  if (!validStartupPrompt(startupPrompt)) return undefined;
  if (!iface || !sessionId || !isUsableSessionId(sessionId) || !isNativeFolder(cwd))
    return undefined;
  try {
    const environment = parseEnvEntries(environmentEntries);
    return {
      cwd,
      environment,
      harness,
      interface: iface,
      launchId: control.launchId,
      sessionId,
      startupPrompt,
    };
  } catch {
    return undefined;
  }
}

export function interactiveArgv(request: InteractiveRequest): readonly string[] | undefined {
  if (!Object.hasOwn(INTERACTIVE_INTERFACES, request.interface)) return undefined;
  const descriptor =
    INTERACTIVE_INTERFACES[request.interface as keyof typeof INTERACTIVE_INTERFACES];
  if (descriptor.harness !== request.harness || descriptor.resume === null) return undefined;
  const args = descriptor.resume.map((word) =>
    word === "{sessionId}" ? request.sessionId : word === "{cwd}" ? request.cwd : word,
  );
  const prompt = request.startupPrompt;
  if (prompt === undefined) return args;
  if (!("startup" in descriptor)) return undefined;
  return [...args, ...descriptor.startup.map((word) => (word === "{prompt}" ? prompt : word))];
}

export function makeInteractiveRecord(
  launchId: string,
  body: InteractiveControlBody,
): InteractiveControlRecord {
  return { ...body, launchId, operation: "interactive", v: 1 };
}
