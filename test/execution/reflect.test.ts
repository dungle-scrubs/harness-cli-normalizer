/**
 * The reflection producer (RFC-03 slice 11, issue #287): invocation mint,
 * started/identity/closed envelopes, deployment-owned activation, and the
 * never-fail delivery contract. The package members and envelope shapes
 * mirror the intake's observation-envelope and evidence-package schemas.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  closedEvent,
  identityEvent,
  type ReflectConfig,
  type ReflectDelivery,
  reflectConfigFromEnv,
  reflectProducer,
  startedEvent,
} from "../../src/execution/reflect.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const FACTS = {
  authority: "pro",
  harness: "claude",
  invocationId: "0f0e0d0c-1111-4222-8333-444455556666",
  occurredAt: "2026-09-28T02:00:00.000Z",
};

const decodeMember = (body: unknown): Record<string, unknown> => {
  const packages = (body as { packages: { contents: Record<string, string> }[] }).packages;
  return JSON.parse(
    Buffer.from(Object.values(packages[0]?.contents ?? {})[0] ?? "", "base64").toString("utf8"),
  );
};

describe("activation is deployment-owned", () => {
  test("absent unless explicitly turned on with an authority", () => {
    expect(reflectConfigFromEnv({})).toBeUndefined();
    expect(reflectConfigFromEnv({ REFLECT_INTAKE_CAPTURE: "1" })).toBeUndefined();
    expect(reflectConfigFromEnv({ REFLECT_INTAKE_CAPTURE: "on" })).toBeUndefined();
    expect(
      reflectConfigFromEnv({ REFLECT_INTAKE_CAPTURE: "on", REFLECT_HOST_AUTHORITY: "pro" }),
    ).toMatchObject({ authority: "pro", bin: "reflect-intake" });
  });

  test("bin override and workParent passthrough", () => {
    const config = reflectConfigFromEnv({
      REFLECT_INTAKE_CAPTURE: "on",
      REFLECT_HOST_AUTHORITY: "pro",
      REFLECT_INTAKE_BIN: "/usr/local/bin/reflect-intake",
      REFLECT_INTAKE_WORK_PARENT: '{"authority":"reflect-intake:job","id":"job-9"}',
    });
    expect(config).toEqual({
      authority: "pro",
      bin: "/usr/local/bin/reflect-intake",
      workParent: { authority: "reflect-intake:job", id: "job-9" },
    });
  });

  test("a malformed parent reference is dropped, never guessed at", () => {
    for (const raw of ["not json", "[]", '{"id":""}', '{"id":"j"}', '{"authority":"a"}']) {
      const config = reflectConfigFromEnv({
        REFLECT_INTAKE_CAPTURE: "on",
        REFLECT_HOST_AUTHORITY: "pro",
        REFLECT_INTAKE_WORK_PARENT: raw,
      });
      expect(config).toEqual({ authority: "pro", bin: "reflect-intake" });
    }
  });
});

describe("envelope and package shapes", () => {
  test("started: no refs, no identity, no terminal, headless execution", () => {
    const event = startedEvent({ ...FACTS });
    expect(event.eventId).toBe(`pro:${FACTS.invocationId}:started`);
    const envelope = (event.body as { envelope: Record<string, unknown> }).envelope;
    expect(envelope).toMatchObject({
      invocationId: FACTS.invocationId,
      kind: "invocation.started",
      producerId: "hcn",
      schemaVersion: 1,
      sourceAuthority: "pro",
      execution: { evidence: "hcn stream-turn argv render", mode: "headless" },
      privacy: "local-only",
    });
    expect(envelope.refs).toBeUndefined();
    expect(envelope.identity).toBeUndefined();
    expect(envelope.terminal).toBeUndefined();
    expect(JSON.stringify(envelope)).not.toContain("transcript");
  });

  test("the evidence package digest is the sha256 of the canonical manifest", () => {
    const event = startedEvent({ ...FACTS });
    const body = event.body as {
      packages: { contents: Record<string, string>; digest: string; manifest: unknown }[];
    };
    const [pkg] = body.packages;
    const canonical = JSON.stringify(pkg?.manifest, Object.keys(pkg?.manifest ?? {}).sort());
    // Recompute with recursive sorting, the contract's canonical form.
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, sortKeys(v)]),
        );
      }
      return value;
    };
    const digest = `sha256:${createHash("sha256")
      .update(JSON.stringify(sortKeys(pkg?.manifest)))
      .digest("hex")}`;
    expect(pkg?.digest).toBe(digest);
    expect(canonical.length).toBeGreaterThan(0);
    const envelope = (event.body as { envelope: { evidence: { digest: string } } }).envelope;
    expect(envelope.evidence.digest).toBe(pkg?.digest);
    const manifest = (pkg?.manifest ?? { members: [] }) as {
      members: { sha256: string; bytes: number }[];
    };
    const member = manifest.members[0];
    const firstContent = Object.values(pkg?.contents ?? {})[0] ?? "";
    const bytes = Buffer.from(firstContent, "utf8");
    expect(member?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(member?.bytes).toBe(bytes.byteLength);
  });

  test("identity: harness-minted and caller-assigned carry through", () => {
    for (const authority of ["harness-minted", "caller-assigned"] as const) {
      const event = identityEvent({ ...FACTS }, { authority, sessionId: "sess-1" });
      const envelope = (event.body as { envelope: Record<string, unknown> }).envelope;
      expect(envelope.kind).toBe("identity.observed");
      expect(envelope.identity).toEqual({
        authority,
        harnessAuthority: "claude:pro",
        nativeSessionId: "sess-1",
      });
    }
  });

  test("closed: the terminal carries hcn's own cause, killed without an interrupted field", () => {
    for (const cause of [
      "clean",
      "limit",
      "crash",
      "stall",
      "killed",
      "failed",
      "awaiting-input",
    ]) {
      const event = closedEvent({ ...FACTS }, { cause, exitCode: cause === "killed" ? null : 0 });
      const envelope = (event.body as { envelope: Record<string, unknown> }).envelope;
      expect(envelope.kind).toBe("process.closed");
      expect(envelope.terminal).toEqual({ cause, exitCode: cause === "killed" ? null : 0 });
      expect(JSON.stringify(envelope)).not.toContain("interrupted");
    }
  });

  test("workParent rides every event's refs", () => {
    const facts = { ...FACTS, workParent: { authority: "reflect-intake:job", id: "job-9" } };
    for (const event of [
      startedEvent({ ...facts }),
      identityEvent({ ...facts }, { authority: "harness-minted", sessionId: "s" }),
      closedEvent({ ...facts }, { cause: "clean", exitCode: 0 }),
    ]) {
      const envelope = (event.body as { envelope: { refs?: unknown } }).envelope;
      expect(envelope.refs).toEqual({
        workParent: { authority: "reflect-intake:job", id: "job-9" },
      });
    }
  });
});

describe("the producer lifecycle", () => {
  test("started mints once; identity and closed ride the same invocation id", async () => {
    const deliveries: unknown[] = [];
    const delivery: ReflectDelivery = async (authority, bin, body) => {
      deliveries.push({ authority, bin, envelope: (body as { envelope: unknown }).envelope });
      return true;
    };
    const producer = reflectProducer({ authority: "pro", bin: "reflect-intake" }, delivery);
    producer.started("claude");
    producer.identity("claude", { authority: "harness-minted", sessionId: "sess-1" });
    await producer.closed("claude", { cause: "clean", exitCode: 0 });
    expect(deliveries).toHaveLength(3);
    const ids = deliveries.map(
      (d) => (d as { envelope: { invocationId: string } }).envelope.invocationId,
    );
    expect(new Set(ids).size).toBe(1);
    const [started, identity, closed] = deliveries.map(
      (d) => (d as { envelope: { kind: string } }).envelope.kind,
    );
    expect([started, identity, closed]).toEqual([
      "invocation.started",
      "identity.observed",
      "process.closed",
    ]);
  });

  test("closed without a started invocation is a no-op, and delivery failure never throws", async () => {
    const deliveries: unknown[] = [];
    const failing: ReflectDelivery = async (authority, _bin, body) => {
      deliveries.push(body);
      throw new Error("delivery exploded");
    };
    const producer = reflectProducer({ authority: "pro", bin: "reflect-intake" }, failing);
    await expect(
      producer.closed("claude", { cause: "clean", exitCode: 0 }),
    ).resolves.toBeUndefined();
    expect(deliveries).toHaveLength(0);
    producer.started("claude");
    expect(() =>
      producer.identity("claude", { authority: "harness-minted", sessionId: "s" }),
    ).not.toThrow();
    await expect(
      producer.closed("claude", { cause: "clean", exitCode: 0 }),
    ).resolves.toBeUndefined();
  });
});

describe("streamTurn wires the producer", () => {
  const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
  const result = JSON.stringify({ type: "result", subtype: "success" });

  const collect = async (events: AsyncIterable<unknown>): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const e of events) out.push(e);
    return out;
  };

  test("started, first identity, and closed with hcn's own cause", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const clock = new FakeClock();
    const calls: { kind: string; sessionId?: string; cause?: string }[] = [];
    const reflect = {
      closed: async (_harness: string, terminal: { cause: string }): Promise<void> => {
        calls.push({ cause: terminal.cause, kind: "closed" });
      },
      identity: (_harness: string, identity: { sessionId: string }): void => {
        calls.push({ kind: "identity", sessionId: identity.sessionId });
      },
      started: (_harness: string): void => {
        calls.push({ kind: "started" });
      },
    };
    const turn = streamTurn(
      claudeCode,
      { prompt: "task" },
      { clock, reflect, signal: fakeSignal().signal, spawn: spawner.spawn },
    );
    proc.emitLine(init);
    proc.emitLine(result);
    proc.exit(0);
    await collect(turn);
    expect(calls).toEqual([
      { kind: "started" },
      { kind: "identity", sessionId: sid },
      { cause: "clean", kind: "closed" },
    ]);
  });

  test("no producer in deps: the turn runs without one", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const turn = streamTurn(
      claudeCode,
      { prompt: "task" },
      { clock: new FakeClock(), signal: fakeSignal().signal, spawn: spawner.spawn },
    );
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.some((e) => (e as { kind: string }).kind === "done")).toBe(true);
  });
});
