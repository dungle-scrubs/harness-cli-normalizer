import type { HarnessName } from "../knowledge/descriptor.js";
import { HARNESS_NAMES } from "../knowledge/descriptor.js";
import type { InteractiveControlBody, InteractiveControlRecord } from "../knowledge/interactive.js";
import { INTERACTIVE_INTERFACES } from "../knowledge/interactive.js";
import { parseEnvEntries } from "./environment.js";
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
}

const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function oneValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || args.lastIndexOf(flag) !== index) return undefined;
  return args[index + 1];
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
  const allowed = ["--interface", "--launch-id", "--resume", "--cwd", "--control-fd", "--env"];
  if (!control || !harness || args.length < 11 || args.length % 2 !== 1) return undefined;
  const environmentEntries: string[] = [];
  for (let index = 1; index < args.length; index += 2) {
    if (!allowed.includes(args[index] ?? "")) return undefined;
    if (args[index] === "--env") environmentEntries.push(args[index + 1] ?? "");
  }
  const iface = oneValue(args, "--interface");
  const sessionId = oneValue(args, "--resume");
  const cwd = oneValue(args, "--cwd");
  if (
    !iface ||
    !sessionId ||
    !isUsableSessionId(sessionId) ||
    !cwd?.startsWith("/") ||
    /\p{Cc}/u.test(cwd) ||
    new TextEncoder().encode(cwd).length > 4096
  )
    return undefined;
  try {
    const environment = parseEnvEntries(environmentEntries);
    return { cwd, environment, harness, interface: iface, launchId: control.launchId, sessionId };
  } catch {
    return undefined;
  }
}

export function interactiveArgv(request: InteractiveRequest): readonly string[] | undefined {
  if (!Object.hasOwn(INTERACTIVE_INTERFACES, request.interface)) return undefined;
  const descriptor =
    INTERACTIVE_INTERFACES[request.interface as keyof typeof INTERACTIVE_INTERFACES];
  if (descriptor.harness !== request.harness || descriptor.resume === null) return undefined;
  return descriptor.resume.map((word) =>
    word === "{sessionId}" ? request.sessionId : word === "{cwd}" ? request.cwd : word,
  );
}

export function makeInteractiveRecord(
  launchId: string,
  body: InteractiveControlBody,
): InteractiveControlRecord {
  return { ...body, launchId, operation: "interactive", v: 1 };
}
