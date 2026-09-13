import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const cli = resolve("src/cli/index.ts");
const sessionId = "907feafe-e82b-4df4-91ba-4f1aeb987508";

test("public native approval refusal proves that no process or prompt was attempted", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-native-refusal-")));
  try {
    const result = spawnSync(
      bun,
      [
        cli,
        "run",
        "codex",
        "--json",
        "--native-approvals",
        "--resume",
        sessionId,
        "--cwd",
        root,
        "--native-settings-fingerprint",
        "a".repeat(64),
        "--model",
        "competing-model",
        "--prompt",
        "must not submit",
      ],
      {
        cwd: root,
        env: {
          CODEX_HOME: join(root, "codex-home"),
          HCN_CONFIG_DIR: join(root, "hcn-config"),
          PATH: "",
        },
        encoding: "utf8",
        timeout: 2000,
      },
    );
    expect(result.status).toBe(2);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toMatchObject([
      {
        kind: "failure",
        nativeApproval: {
          phase: "preflight",
          process: "not-attempted",
          prompt: "not-submitted",
          reason: "request-refused",
        },
      },
      {
        kind: "done",
        cause: "failed",
        failure: { nativeApproval: { process: "not-attempted", prompt: "not-submitted" } },
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken public output pipe terminates the owned approval process before HCN exits", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-native-broken-output-")));
  try {
    const { env, fingerprint, nativeLog } = nativeApprovalFixture(root);
    const peer = join(root, "bin", "codex");
    writeFileSync(
      peer,
      readFileSync(peer, "utf8") +
        '\nprocess.on("SIGTERM",()=>{save({signal:"SIGTERM"});process.exit(0);});\n',
    );
    const child = spawn(
      bun,
      [
        cli,
        "run",
        "codex",
        "--json",
        "--native-approvals",
        "--resume",
        sessionId,
        "--cwd",
        root,
        "--native-settings-fingerprint",
        fingerprint,
        "--questions",
        "none",
        "--prompt",
        "fixture",
      ],
      { cwd: root, env, stdio: "pipe" },
    );
    let output = "";
    let disconnected = false;
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (!disconnected && output.includes('"approval-request"')) {
        disconnected = true;
        child.stdout.destroy();
        child.stdin.write('{"op":"invalid"}\n');
      }
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    clearTimeout(watchdog);
    expect(disconnected).toBe(true);
    const calls = readFileSync(nativeLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.some((call) => call.signal === "SIGTERM")).toBe(true);
    expect(calls.filter((call) => call.id === 7 && call.result)).toEqual([]);
    expect(code).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public native approvals resume the exact thread and answer one live request before cleanup", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-native-approval-")));
  try {
    const { env, fingerprint, nativeLog } = nativeApprovalFixture(root);
    const child = spawn(
      bun,
      [
        cli,
        "run",
        "codex",
        "--native-approvals",
        "--json",
        "--resume",
        sessionId,
        "--cwd",
        root,
        "--native-settings-fingerprint",
        fingerprint,
        "--prompt",
        "EXACT_INPUT",
        "--questions",
        "none",
      ],
      { cwd: root, env, stdio: "pipe" },
    );
    const events: Record<string, unknown>[] = [];
    let pending = "";
    let stderr = "";
    let parseError: unknown;
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      pending += String(chunk);
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          events.push(event);
          if (event.kind === "approval-request") {
            const choice = event.choices.find((c: { scope: string }) => c.scope === "once");
            child.stdin.write(
              `${JSON.stringify({ v: 1, op: "approval", id: "107feafe-e82b-4df4-91ba-4f1aeb987508", requestId: event.requestId, choiceId: choice?.id })}\n`,
            );
          }
        } catch (cause) {
          parseError = cause;
          child.kill("SIGTERM");
        }
      }
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    clearTimeout(watchdog);
    expect(parseError).toBeUndefined();
    expect(code, stderr + JSON.stringify(events)).toBe(0);
    expect(events.filter((e) => e.kind === "approval-request")).toMatchObject([
      { v: 1, sessionId, turnId: "native-turn", category: "command" },
    ]);
    expect(events.some((e) => e.kind === "approval-disposition" && e.status === "sent")).toBe(true);
    expect(events.some((e) => e.kind === "message" && e.text === "FIXTURE_DONE")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    const calls = readFileSync(nativeLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0]).toEqual({ argv: ["app-server", "--listen", "stdio://"] });
    expect(calls.find((c) => c.method === "thread/resume")?.params).toMatchObject({
      threadId: sessionId,
      sandbox: "read-only",
    });
    expect(calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    expect(calls.find((c) => c.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "EXACT_INPUT" },
    ]);
    expect(calls.filter((c) => c.id === 7 && c.result)).toEqual([
      { id: 7, result: { decision: "accept" } },
    ]);
    expect(calls.at(-1)).toEqual({ closed: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function nativeApprovalFixture(root: string): {
  readonly env: Record<string, string>;
  readonly fingerprint: string;
  readonly nativeLog: string;
} {
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "09", "12");
  const bin = join(root, "bin");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(bin);
  // Synthetic source and native RPC peer. No fixture recording is handwritten.
  const records = [
    {
      type: "session_meta",
      payload: { id: sessionId, cwd: root, model_provider: "saved-provider" },
    },
    {
      type: "turn_context",
      payload: {
        approval_policy: "on-request",
        approvals_reviewer: "user",
        cwd: root,
        model: "saved-model",
        effort: "high",
        sandbox_policy: { type: "read-only" },
        permission_profile: {
          type: "managed",
          network: "restricted",
          file_system: {
            type: "restricted",
            entries: [{ path: { type: "special", value: { kind: "root" } }, access: "read" }],
          },
        },
      },
    },
  ];
  writeFileSync(
    join(sessions, `rollout-fixture-${sessionId}.jsonl`),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  const nativeLog = join(root, "native.ndjson");
  writeFileSync(
    join(bin, "codex"),
    `#!${bun}
import {appendFileSync} from "node:fs";
import {createInterface} from "node:readline";
const save = (value) => appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify(value) + "\\n");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
save({argv:process.argv.slice(2)});
setTimeout(()=>process.exit(9),6000).unref();
createInterface({input:process.stdin}).on("line", line => {
const message=JSON.parse(line); save(message);
if(message.method === "initialize") emit({id:message.id,result:{userAgent:"fixture"}});
if(message.method === "thread/resume") emit({id:message.id,result:{
  thread:{id:${JSON.stringify(sessionId)},sessionId:"807feafe-e82b-4df4-91ba-4f1aeb987508"},
  cwd:${JSON.stringify(root)},model:"saved-model",modelProvider:"saved-provider",reasoningEffort:"high",
  approvalPolicy:"on-request",approvalsReviewer:"user",activePermissionProfile:null,
  sandbox:{type:"readOnly",networkAccess:false}
}});
if(message.method === "turn/start") {
  emit({id:message.id,result:{turn:{id:"native-turn",status:"inProgress"}}});
  emit({id:7,method:"item/commandExecution/requestApproval",params:{
    threadId:${JSON.stringify(sessionId)},turnId:"native-turn",itemId:"command-1",startedAtMs:0,
    command:"echo fixture",cwd:${JSON.stringify(root)},reason:"Synthetic permission request",
    availableDecisions:["accept","decline","cancel"]
  }});
}
if(message.id === 7 && message.result) {
  emit({method:"serverRequest/resolved",params:{threadId:${JSON.stringify(sessionId)},requestId:7}});
  emit({method:"item/completed",params:{threadId:${JSON.stringify(sessionId)},turnId:"native-turn",item:{id:"answer",type:"agentMessage",text:"FIXTURE_DONE"}}});
  emit({method:"turn/completed",params:{threadId:${JSON.stringify(sessionId)},turn:{id:"native-turn",status:"completed",error:null}}});
}
}).on("close",()=>{save({closed:true});process.exit(0);});
`,
    { mode: 0o700 },
  );
  const env = {
    CODEX_HOME: codexHome,
    HCN_CONFIG_DIR: join(root, "hcn-config"),
    HOME: root,
    PATH: bin,
  };
  const inspected = spawnSync(
    bun,
    [cli, "inspect", "codex", "--native-settings", "--resume", sessionId, "--cwd", root, "--json"],
    { cwd: root, env, encoding: "utf8", timeout: 2000 },
  );
  expect(inspected.status).toBe(0);
  const fingerprint = JSON.parse(inspected.stdout).fingerprint;
  return { env, fingerprint, nativeLog };
}
