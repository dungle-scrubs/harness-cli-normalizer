// Research harness only. Calls the unchanged release adapter below its CLI version gate.
// Run with Bun from the release worktree. Only synthetic prompts are accepted here.
import { randomUUID } from "node:crypto";
import { inspectContext } from "../../../src/execution/context-inspection.ts";
import { nodeRunnerDeps } from "../../../src/execution/node-deps.ts";
import { LineBuffer } from "../../../src/execution/lines.ts";
import { buildContextInspectionArgv } from "../../../src/interpretation/context-inspection.ts";
import { claudeCode } from "../../../src/knowledge/claude-code.ts";

const resume = process.argv[2];
const cwd = process.argv[3];
const prompt =
  "Synthetic accounting probe. Do not answer. Pending marker: ACCOUNTING_ONLY_913." +
  " Additional synthetic context.".repeat(Number(process.argv[4] ?? 0));
const argv = buildContextInspectionArgv(claudeCode, {
  model: "claude-opus-5",
  discovery: { extensions: false, skills: false },
  prompt: { explicit: true, text: prompt },
  ...(resume && resume !== "fresh" ? { resume } : {}),
});
argv[0] = "/Users/kevin/.local/share/claude/versions/2.1.267";
argv.push("--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
const deps = nodeRunnerDeps();
const frames = [];
let spawned = 0;
const result = await inspectContext(
  {
    argv,
    cwd,
    harness: claudeCode,
    inputId: randomUUID(),
    prompt,
  },
  {
    ...deps,
    spawn(args, options) {
      spawned += 1;
      const child = deps.spawn(args, options);
      const original = child.stdout;
      child.stdout = (async function* () {
        const lines = new LineBuffer(9 * 1024 * 1024);
        for await (const chunk of original) {
          for (const line of lines.push(chunk)) {
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              frames.push({ type: "invalid-json" });
              continue;
            }
            const response = frame.response;
            frames.push({
              type: frame.type,
              subtype: frame.subtype,
              responseSubtype: response?.subtype,
              resultSummary:
                frame.type === "result"
                  ? { turns: frame.num_turns, cost: frame.total_cost_usd, usage: frame.usage }
                  : undefined,
              responseKeys: response?.response ? Object.keys(response.response) : [],
              stagedMarkerPresent:
                frame.type === "user"
                  ? JSON.stringify(frame.message).includes("ACCOUNTING_ONLY_913")
                  : undefined,
            });
          }
          yield chunk;
        }
      })();
      return child;
    },
    turnTimeoutMs: 30000,
  },
);
console.log(
  JSON.stringify(
    {
      purpose: "research-only: unchanged 0.6.5 context adapter without CLI version gate",
      case: resume === "fresh" ? "fresh" : "forked-resume",
      version: "2.1.267",
      recordedVersion: claudeCode.verifiedAgainst,
      spawned,
      promptCharacters: prompt.length,
      frames,
      result,
    },
    null,
    2,
  ),
);
