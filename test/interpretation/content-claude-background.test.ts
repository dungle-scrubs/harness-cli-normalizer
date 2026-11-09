import { describe, expect, test } from "vitest";
import {
  type ContentEvent,
  contentEventsOf,
  contentEventsWithState,
  freshReaderState,
  type ReaderState,
} from "../../src/interpretation/content.js";

/**
 * Background jobs and subagent steps on claude's stream-json, spec
 * sections 1 and 2. Every record below is real, quoted from the
 * 2026-11-09 capture of claude 2.1.319 in
 * ~/dev/dotfiles/.scratch/herdr-harness-controls/evidence/claude-background-events-2026-11-09.ndjson
 * (a `run_in_background` Bash loop, task bcrfa3pxt, and a background
 * Agent, task a34310bd3dc4bd051). Synthetic records appear only where
 * the spec decides a skip no captured line exercised, and say so.
 */

const shellStarted = {
  type: "system",
  subtype: "task_started",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  tool_use_id: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
  description: "Run background tick loop",
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "f8158f2f-29f1-4565-b28e-f12c7c5394ea",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentStarted = {
  type: "system",
  subtype: "task_started",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  description: "Count files",
  subagent_type: "general-purpose",
  is_backgrounded: true,
  spawn_depth: 1,
  task_type: "local_agent",
  prompt: "Run ls / | wc -l and report the number.",
  uuid: "681862fb-e292-4782-8f83-13f31d0f5855",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentProgress = {
  type: "system",
  subtype: "task_progress",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  description: "Running Count entries in root directory",
  subagent_type: "general-purpose",
  usage: { total_tokens: 27921, tool_uses: 1, duration_ms: 2100 },
  last_tool_name: "Bash",
  uuid: "0986a776-135c-4a50-89b2-8a457237325a",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentUpdatedCompleted = {
  type: "system",
  subtype: "task_updated",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  patch: { status: "completed", end_time: 1794203904772 },
  uuid: "78813ec5-395a-42be-8eca-fe5e49cf6535",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const shellUpdatedCompleted = {
  type: "system",
  subtype: "task_updated",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  patch: { status: "completed", end_time: 1794203909753 },
  uuid: "134a053b-1382-4c7f-8da7-e99835901111",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentNotification = {
  type: "system",
  subtype: "task_notification",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  status: "completed",
  output_file:
    "/private/tmp/claude-501/-private-tmp-claude-501--Users-kevin-dev-dotfiles-978d1578-5554-4735-80a1-2bfadd959edd-scratchpad-bgprobe/c81a836f-e08d-4fe1-ae5c-b6988292d264/tasks/a34310bd3dc4bd051.output",
  summary: "`ls / | wc -l` printed **17**, so the root directory has 17 entries.",
  usage: { total_tokens: 30933, tool_uses: 1, duration_ms: 3723 },
  uuid: "1681ea64-4e86-452b-9cda-0c9d36553648",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const shellNotification = {
  type: "system",
  subtype: "task_notification",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  tool_use_id: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
  status: "completed",
  output_file:
    "/private/tmp/claude-501/-private-tmp-claude-501--Users-kevin-dev-dotfiles-978d1578-5554-4735-80a1-2bfadd959edd-scratchpad-bgprobe/c81a836f-e08d-4fe1-ae5c-b6988292d264/tasks/bcrfa3pxt.output",
  summary: 'Background command "Run background tick loop" completed (exit code 0)',
  uuid: "ce29c49d-a96f-453c-ab5e-85ad009ac556",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const tasksChanged = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [
    {
      task_id: "bcrfa3pxt",
      run_id: "0mw8uobqx-def2eb6d",
      task_type: "local_bash",
      description: "Run background tick loop",
    },
  ],
  uuid: "4b0194cb-279b-4769-b7e5-a650fc25247e",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

/** The subagent's own Bash call, a real assistant line carrying
 * `parent_tool_use_id` (the Agent call toolu_012jE8yMKUqo4bjJcHR7ZVkL). */
const subagentBashCall = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5-5",
    id: "msg_011Cgrqko2X3f77i8niW4hEQ",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01MUEttnZ12CienaciPXJPmq",
        name: "Bash",
        input: { command: "ls / | wc -l", description: "Count entries in root directory" },
        caller: { type: "direct" },
      },
    ],
  },
  parent_tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  agent_id: "a34310bd3dc4bd051",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "00fd85ae-549c-4b76-8386-e2542ffbd5a0",
  timestamp: "2026-11-09T05:58:23.147Z",
  request_id: "req_011Cgrqknq7fQxEhx9eJAbLc",
  subagent_type: "general-purpose",
  task_description: "Count files",
};

const subagentBashResult = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_01MUEttnZ12CienaciPXJPmq",
        type: "tool_result",
        content: "      17",
        is_error: false,
      },
    ],
  },
  parent_tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  agent_id: "a34310bd3dc4bd051",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "58c2e27e-d5af-4a19-9295-67a65cde9a2f",
  timestamp: "2026-11-09T05:58:23.517Z",
  subagent_type: "general-purpose",
  task_description: "Count files",
};

const subagentAnswer = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5-5",
    id: "msg_011CgrqkyFBEhkEJwCJyYiSV",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "`ls / | wc -l` printed **17**, so the root directory has 17 entries.",
      },
    ],
  },
  parent_tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  agent_id: "a34310bd3dc4bd051",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "2fd7537c-5887-4007-948c-1146dbba6ce5",
  timestamp: "2026-11-09T05:58:24.725Z",
  subagent_type: "general-purpose",
  task_description: "Count files",
};

/** A main-loop assistant line: `parent_tool_use_id` null, no parentCallId. */
const mainLoopAnswer = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5-5",
    id: "msg_011CgrqkoBhVtH7aPhpHQV3k",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "started" }],
  },
  parent_tool_use_id: null,
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "802743cd-5fb2-4a81-88cb-670d31cd7e8f",
  timestamp: "2026-11-09T05:58:22.079Z",
};

/** Thread the reader state the way the decode pumps do, so a job's own
 * start can teach the registry its later lines read. */
const decodeAll = (records: readonly unknown[]): ContentEvent[] => {
  let state: ReaderState = freshReaderState("claude");
  const events: ContentEvent[] = [];
  for (const record of records) {
    const step = contentEventsWithState("claude", record, state);
    state = step.state;
    events.push(...step.events);
  }
  return events;
};

const backgroundOf = (events: ContentEvent[]) => events.filter((e) => e.kind === "background");

describe("claude background jobs: the mapping rows", () => {
  test("task_started of a background Bash loop is a running shell job", () => {
    expect(decodeAll([shellStarted])).toEqual([
      {
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "running",
        description: "Run background tick loop",
        callId: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
      },
    ]);
  });

  test("task_started of a background Agent is a running agent job with its type", () => {
    expect(decodeAll([agentStarted])).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        description: "Count files",
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
    ]);
  });

  test("task_progress reports the step, its usage and the job last seen", () => {
    expect(decodeAll([agentStarted, agentProgress]).slice(1)).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        detail: "Running Count entries in root directory",
        toolUses: 1,
        totalTokens: 27921,
        durationMs: 2100,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
    ]);
  });

  test("task_updated with a status patch reports the state and nothing else", () => {
    expect(decodeAll([agentStarted, agentUpdatedCompleted]).slice(1)).toEqual([
      { kind: "background", id: "a34310bd3dc4bd051", job: "agent", state: "completed" },
    ]);
    expect(decodeAll([shellStarted, shellUpdatedCompleted]).slice(1)).toEqual([
      { kind: "background", id: "bcrfa3pxt", job: "shell", state: "completed" },
    ]);
  });

  test("task_notification carries the output file, the summary and the call id", () => {
    expect(decodeAll([agentStarted, agentNotification]).slice(1)).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "completed",
        outputFile: agentNotification.output_file,
        summary: agentNotification.summary,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
    ]);
    expect(decodeAll([shellStarted, shellNotification]).slice(1)).toEqual([
      {
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "completed",
        outputFile: shellNotification.output_file,
        summary: shellNotification.summary,
        callId: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
      },
    ]);
  });

  test("one job's full crossing, in capture order", () => {
    expect(
      backgroundOf(
        decodeAll([
          tasksChanged,
          agentStarted,
          agentProgress,
          subagentBashCall,
          subagentBashResult,
          subagentAnswer,
          agentUpdatedCompleted,
          agentNotification,
        ]),
      ),
    ).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        description: "Count files",
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        detail: "Running Count entries in root directory",
        toolUses: 1,
        totalTokens: 27921,
        durationMs: 2100,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
      { kind: "background", id: "a34310bd3dc4bd051", job: "agent", state: "completed" },
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "completed",
        outputFile: agentNotification.output_file,
        summary: agentNotification.summary,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
    ]);
  });

  test("the end statuses the spec maps: killed, stopped and cancelled all read stopped", () => {
    // The capture held only `completed`; these are the spec's mapping, so
    // the records are synthetic patch/notification shapes on a real id.
    for (const status of ["killed", "stopped", "cancelled"]) {
      expect(
        backgroundOf(
          decodeAll([
            shellStarted,
            { ...shellUpdatedCompleted, patch: { status, end_time: 1794203909753 } },
          ]),
        ).at(-1),
      ).toEqual({ kind: "background", id: "bcrfa3pxt", job: "shell", state: "stopped" });
    }
    expect(
      backgroundOf(decodeAll([shellStarted, { ...shellNotification, status: "failed" }])).at(-1),
    ).toEqual(
      expect.objectContaining({
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "failed",
      }),
    );
    expect(
      backgroundOf(
        decodeAll([shellStarted, { ...shellUpdatedCompleted, patch: { status: "running" } }]),
      ).at(-1),
    ).toEqual({ kind: "background", id: "bcrfa3pxt", job: "shell", state: "running" });
  });

  test("a FOREGROUND Agent call's task records emit too: the field is not a discriminator", () => {
    // Live check 2026-11-09 (fix round 1, item 5): an inline Agent call
    // (no run_in_background) still gets task records, and the captured
    // task_started - quoted below from
    // claude-foreground-agent-task-records-2026-11-09.ndjson - carries
    // `is_backgrounded: true`, shape-identical to a background agent's.
    // Neither 2026-11-09 capture holds an `is_backgrounded: false`, so
    // the field gates nothing: every tracked task reports, and the
    // mapping is the spec's unchanged one.
    const inlineAgentStarted = {
      type: "system",
      subtype: "task_started",
      task_id: "a5fa5c99e746ed563",
      run_id: "0mw90bp2q-2b03be98",
      tool_use_id: "toolu_01DsuF4cfn5iSuiAQumzRpPJ",
      description: "Read note.txt contents",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: "local_agent",
      prompt: "Use the Bash tool to run `cat note.txt` in the current working directory.",
      session_id: "f01bef5e-4762-4185-b847-a42daf12e00d",
    };
    expect(decodeAll([inlineAgentStarted])).toEqual([
      {
        kind: "background",
        id: "a5fa5c99e746ed563",
        job: "agent",
        state: "running",
        description: "Read note.txt contents",
        callId: "toolu_01DsuF4cfn5iSuiAQumzRpPJ",
        agent: "general-purpose",
      },
    ]);
  });

  test("a task_type on a later line still names the job", () => {
    expect(decodeAll([{ ...agentProgress, task_type: "local_agent" }])).toEqual([
      expect.objectContaining({ kind: "background", id: "a34310bd3dc4bd051", job: "agent" }),
    ]);
  });
});

describe("claude background jobs: the skips", () => {
  test("background_tasks_changed emits nothing, not even progress", () => {
    expect(decodeAll([tasksChanged])).toEqual([]);
    expect(decodeAll([{ type: "system", subtype: "background_tasks_changed", tasks: [] }])).toEqual(
      [],
    );
  });

  test("task_summary emits nothing (synthetic; the binary has it, the capture does not)", () => {
    expect(decodeAll([{ type: "system", subtype: "task_summary" }])).toEqual([]);
  });

  test("a task_type outside the two emits nothing and records nothing", () => {
    expect(decodeAll([{ ...shellStarted, task_type: "local_mcp" }])).toEqual([]);
    // The job was never seen, so its later lines without a task_type are
    // unknown too.
    expect(decodeAll([{ ...shellStarted, task_type: "local_mcp" }, shellNotification])).toEqual([]);
  });

  test("a line without a task_id emits nothing", () => {
    const { task_id: _dropped, ...withoutId } = shellStarted;
    expect(decodeAll([withoutId])).toEqual([]);
  });

  test("a later line for an id whose job was never seen emits nothing", () => {
    expect(decodeAll([agentProgress])).toEqual([]);
    expect(decodeAll([agentUpdatedCompleted])).toEqual([]);
    expect(decodeAll([agentNotification])).toEqual([]);
  });

  test("a task_updated without a status patch, or with an unknown status, emits nothing", () => {
    expect(decodeAll([shellStarted, { ...shellUpdatedCompleted, patch: {} }]).slice(1)).toEqual([]);
    expect(
      decodeAll([shellStarted, { ...shellUpdatedCompleted, patch: { status: "pending" } }]).slice(
        1,
      ),
    ).toEqual([]);
    expect(
      decodeAll([
        shellStarted,
        { type: "system", subtype: "task_updated", task_id: "bcrfa3pxt" },
      ]).slice(1),
    ).toEqual([]);
  });

  test("a task_notification with an unknown status emits nothing", () => {
    expect(
      decodeAll([shellStarted, { ...shellNotification, status: "vanished" }]).slice(1),
    ).toEqual([]);
  });

  test("a job survives another job's lines: the registry keys by id", () => {
    const events = decodeAll([shellStarted, agentStarted, agentProgress, shellNotification]);
    expect(backgroundOf(events).map((e) => [e.id, e.job, e.state])).toEqual([
      ["bcrfa3pxt", "shell", "running"],
      ["a34310bd3dc4bd051", "agent", "running"],
      ["a34310bd3dc4bd051", "agent", "running"],
      ["bcrfa3pxt", "shell", "completed"],
    ]);
  });

  test("a job is kept through its terminal task_updated and dropped at its task_notification", () => {
    // The updated marks the entry ended but keeps it: the notification
    // that follows (no task_type of its own) still finds the job.
    expect(
      backgroundOf(decodeAll([shellStarted, shellUpdatedCompleted, shellNotification])).map(
        (e) => e.state,
      ),
    ).toEqual(["running", "completed", "completed"]);
    // The notification retires the entry: a later line for the same id
    // with no task_type names an unknown job and emits nothing.
    expect(
      decodeAll([
        shellStarted,
        shellNotification,
        { type: "system", subtype: "task_progress", task_id: "bcrfa3pxt" },
      ]),
    ).toHaveLength(2);
  });

  test("a long-running shell spanning more than 64 newer jobs still reports its end", () => {
    // 65 newer agent jobs (synthetic ids on the captured started shape),
    // each reaching its terminal task_updated but not its notification:
    // all 65 stay in the registry as ended entries, past the 64 bound.
    // The bound evicts ended entries first and never the running shell,
    // so the shell's own end - whose lines carry no task_type - still
    // decodes (review round 1).
    const records: unknown[] = [shellStarted];
    for (let index = 0; index < 65; index += 1) {
      const id = `newer-agent-${index}`;
      records.push(
        { ...agentStarted, task_id: id, description: `newer ${index}` },
        { type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed" } },
      );
    }
    records.push(shellUpdatedCompleted, shellNotification);
    expect(
      backgroundOf(decodeAll(records))
        .filter((e) => e.id === "bcrfa3pxt")
        .map((e) => e.state),
    ).toEqual(["running", "completed", "completed"]);
  });
});

describe("claude subagent lines carry parentCallId", () => {
  test("the subagent's tool call, tool result and message all carry it", () => {
    const events = decodeAll([subagentBashCall, subagentBashResult, subagentAnswer]);
    expect(events).toEqual([
      {
        kind: "tool",
        name: "Bash",
        input: { command: "ls / | wc -l", description: "Count entries in root directory" },
        callId: "toolu_01MUEttnZ12CienaciPXJPmq",
        parentCallId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
      {
        kind: "tool-result",
        callId: "toolu_01MUEttnZ12CienaciPXJPmq",
        result: "      17",
        isError: false,
        parentCallId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
      {
        kind: "message",
        role: "assistant",
        text: "`ls / | wc -l` printed **17**, so the root directory has 17 entries.",
        parentCallId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
    ]);
  });

  test("a main-loop line carries no parentCallId", () => {
    const events = decodeAll([mainLoopAnswer]);
    expect(events).toEqual([{ kind: "message", role: "assistant", text: "started" }]);
  });

  test("a subagent line does not enter the turn's main-loop model attestations", () => {
    // Asserted on the emission, not the reader's internals: a claude
    // result's turn usage reports the models the MAIN LOOP attested and
    // singles one out only when exactly one was. The result records are
    // synthetic minimal shapes (the decoder reads usage alone); the
    // assistant lines are the captured records above.
    const turnResult = {
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
      usage: { input_tokens: 4, output_tokens: 376 },
    };
    const afterSubagent = contentEventsWithState(
      "claude",
      subagentAnswer,
      freshReaderState("claude"),
    );
    const subagentOnly = contentEventsWithState("claude", turnResult, afterSubagent.state);
    expect(subagentOnly.events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: 4,
        outputTokens: 376,
        inputIncludesCache: false,
      },
    ]);
    const afterMainLoop = contentEventsWithState("claude", mainLoopAnswer, afterSubagent.state);
    const withMainLoop = contentEventsWithState("claude", turnResult, afterMainLoop.state);
    expect(withMainLoop.events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: 4,
        outputTokens: 376,
        inputIncludesCache: false,
        model: "claude-sonnet-5-5",
        models: ["claude-sonnet-5-5"],
      },
    ]);
  });
});

describe("run-mode decoding reaches the background event statelessly", () => {
  test("contentEventsOf decodes a task_started without threaded state", () => {
    expect(contentEventsOf("claude", shellStarted)).toEqual([
      {
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "running",
        description: "Run background tick loop",
        callId: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
      },
    ]);
  });
});
