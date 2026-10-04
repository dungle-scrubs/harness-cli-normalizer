import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  encodeIdentityProbe,
  encodeSessionInput,
  resolveSessionInput,
} from "../../src/interpretation/session-input.js";
import { codexCli } from "../../src/knowledge/codex.js";

const schema = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/codex-0.160.0/${name}.schema.snapshot.json`, import.meta.url),
      "utf8",
    ),
  );

const hasNativeTopLevelKeys = (name: string, params: Record<string, unknown>) => {
  const native = schema(name);
  for (const required of native.required ?? []) expect(params).toHaveProperty(required);
  for (const key of Object.keys(params)) expect(native.properties).toHaveProperty(key);
};

test("HCN fresh, resume, start and steer payloads match native schema top-level keys", () => {
  const fresh = (encodeIdentityProbe(codexCli) ?? "")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(fresh[0].method).toBe("initialize");
  expect(fresh[1].method).toBe("thread/start");
  hasNativeTopLevelKeys("ThreadStartParams", fresh[1].params);
  const resume = (
    encodeIdentityProbe(codexCli, { isResume: true, sessionId: "synthetic-thread" }) ?? ""
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))[1];
  expect(resume.method).toBe("thread/resume");
  hasNativeTopLevelKeys("ThreadResumeParams", resume.params);
  for (const busy of [false, true]) {
    const send = JSON.parse(
      encodeSessionInput(resolveSessionInput(codexCli), "marker", {
        busy,
        id: "send",
        sessionId: "synthetic-thread",
        activeTurnId: "synthetic-turn",
      }),
    );
    expect(send.method).toBe(busy ? "turn/steer" : "turn/start");
    hasNativeTopLevelKeys(busy ? "TurnSteerParams" : "TurnStartParams", send.params);
    expect(send.params.input).toEqual([{ type: "text", text: "marker" }]);
    if (busy) expect(send.params.expectedTurnId).toBe("synthetic-turn");
  }
});
