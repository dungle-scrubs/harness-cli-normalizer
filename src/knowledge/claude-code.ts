/**
 * The claude-code descriptor: facts about the `claude` CLI as data, verified
 * against claude 2.1.226 and the 00-chat-substrate spike evidence (A-001,
 * A-002, A-005). No process logic lives here.
 */
import type { HarnessDescriptor } from "./descriptor.js";

export const claudeCode: HarnessDescriptor = {
  name: "claude",
  bin: "claude",
  launch: {
    baseFlags: ["-p"],
    promptStyle: "positional",
    toolsFlag: "--allowedTools",
  },
};
