import type { HarnessEvent } from "../execution/events.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export interface RenderState {
  streamed: boolean;
}

export const createRenderState = (): RenderState => ({ streamed: false });

export const renderEvent = (event: HarnessEvent, state: RenderState): void => {
  switch (event.kind) {
    case "identity":
      process.stdout.write(dim(`  ● session ${event.sessionId} (${event.authority})\n`));
      break;
    case "token":
      process.stdout.write(event.text);
      state.streamed = true;
      break;
    case "message":
      if (!state.streamed) process.stdout.write(event.text);
      break;
    case "tool":
      process.stdout.write(cyan(`\n  ⚙ ${event.name}`));
      break;
    case "progress":
      // droppable
      break;
    case "context":
      process.stdout.write(dim(`\n  ▪ context ${event.usedPct}%`));
      break;
    case "limit":
      process.stdout.write(yellow(`\n  ⚠ limit: ${event.code} ${event.message}`));
      break;
    case "error":
      process.stdout.write(red(`\n  ✗ ${event.message}`));
      break;
    case "failure": {
      const detail = event.message ?? `${event.class}`;
      // D6: native failures get an unmistakable prefix and the native exit
      // code shown as data, so a human never reads a harness error as an
      // hcn error.
      if (event.class === "native") {
        const nat =
          event.nativeExitCode !== undefined ? ` [native exit ${event.nativeExitCode}]` : "";
        process.stdout.write(red(`\n  ✗ NATIVE${nat} ${detail}`));
      } else {
        process.stdout.write(red(`\n  ✗ failure ${event.class}: ${detail}`));
      }
      break;
    }
    case "done": {
      const mark = event.cause === "clean" ? green("○ clean") : red(`○ ${event.cause}`);
      const tail = event.failure ? ` ${event.failure.class}: ${event.failure.message}` : "";
      process.stdout.write(`\n  ${mark} (exit ${event.exitCode ?? "none"})${tail}\n`);
      break;
    }
    default: {
      const exhaustive: never = event as never;
      process.stdout.write(dim(`\n  ? ${(exhaustive as { kind: string }).kind}`));
    }
  }
};

export const writeEventNdjson = (event: HarnessEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
