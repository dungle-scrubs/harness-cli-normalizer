/**
 * The reflection producer (RFC-03 slice 11, issue #287): for every
 * invocation hcn starts, publish the start, the native session identity
 * when known, and the terminal outcome to the local reflection outbox.
 * hcn does not group invocations, choose review units, or own the queue;
 * delivery rides the intake's own `reflect-intake capture` command so the
 * durable-write semantics stay in the repo that owns the outbox schema.
 *
 * Activation is deployment-owned: the producer exists only when the
 * environment turns it on (REFLECT_INTAKE_CAPTURE=on with
 * REFLECT_INTAKE_AUTHORITY), which the deployment sets after the backup
 * and restore gate has passed. Every capture failure - missing binary,
 * refusal, timeout - is swallowed: reflection never fails or delays a
 * run. Envelopes carry no transcript text, and a killed run reports
 * `cause: killed` with no separate interruption field (the intake
 * computes the interruption fact from the cause).
 */
import { createHash, randomUUID } from "node:crypto";

/** A reference to another durable subject, the envelope's authorityRef. */
export interface ReflectRef {
  readonly id: string;
  readonly authority: string;
}

export interface ReflectConfig {
  /** This machine's installation authority; also the eventId prefix. */
  readonly authority: string;
  /** The reflect-intake CLI this producer spawns for delivery. */
  readonly bin: string;
  /** Explicit parent reference, passed through to every event's refs. */
  readonly workParent?: ReflectRef;
}

export const REFLECT_CAPTURE_ENV = "REFLECT_INTAKE_CAPTURE";
export const REFLECT_BIN_ENV = "REFLECT_INTAKE_BIN";
export const REFLECT_WORK_PARENT_ENV = "REFLECT_INTAKE_WORK_PARENT";

/** The machine's installation authority, the same variable the intake's
 * sender and capture command already use. */
export const REFLECT_HOST_AUTHORITY_ENV = "REFLECT_HOST_AUTHORITY";

type Env = Readonly<Record<string, string | undefined>>;

/** Capture is off until the deployment turns it on after the backup and
 * restore gate has passed; anything but `on` keeps the producer absent.
 * The authority is the machine's `REFLECT_HOST_AUTHORITY`, the same value
 * the intake's sender and capture command use. */
export const reflectConfigFromEnv = (env: Env): ReflectConfig | undefined => {
  if (env[REFLECT_CAPTURE_ENV] !== "on") return undefined;
  const authority = env[REFLECT_HOST_AUTHORITY_ENV];
  if (authority === undefined || authority === "") return undefined;
  const rawParent = env[REFLECT_WORK_PARENT_ENV];
  let workParent: ReflectRef | undefined;
  if (rawParent !== undefined && rawParent !== "") {
    try {
      const parsed: unknown = JSON.parse(rawParent);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { id?: unknown }).id === "string" &&
        (parsed as { id: string }).id !== "" &&
        typeof (parsed as { authority?: unknown }).authority === "string" &&
        (parsed as { authority: string }).authority !== ""
      ) {
        workParent = {
          id: (parsed as { id: string }).id,
          authority: (parsed as { authority: string }).authority,
        };
      }
    } catch {
      // A malformed parent reference is dropped, never guessed at.
    }
  }
  return {
    authority,
    bin: env[REFLECT_BIN_ENV] ?? "reflect-intake",
    ...(workParent !== undefined ? { workParent } : {}),
  };
};

export interface ReflectEvent {
  readonly eventId: string;
  /** The capture command's stdin body: envelope plus the own package. */
  readonly body: unknown;
  readonly invocationId: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Canonical JSON per the evidence-package contract: object keys sorted
 * recursively, no insignificant whitespace. The package digest is the
 * SHA-256 of this text, and the intake re-derives it on verify, so the
 * two implementations must agree exactly. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const REFS = (facts: ReflectFacts): { readonly workParent: ReflectRef } | undefined =>
  facts.workParent === undefined ? undefined : { workParent: facts.workParent };

interface ReflectFacts {
  readonly invocationId: string;
  readonly authority: string;
  readonly occurredAt: string;
  readonly harness: string;
  readonly workParent?: ReflectRef;
}

/** The own evidence package: one JSON member carrying the observation
 * facts. No transcript text ever enters a lifecycle package. */
const observationPackage = (
  facts: ReflectFacts,
  suffix: string,
  observation: Record<string, unknown>,
): {
  contents: Uint8Array;
  digest: string;
  manifest: unknown;
} => {
  const contents = new TextEncoder().encode(JSON.stringify(observation));
  const manifest = {
    evidenceRange: { from: 0, to: 0, unit: "turn" },
    members: [
      {
        bytes: contents.byteLength,
        kind: "message",
        mediaType: "application/json",
        recordId: `${facts.invocationId}:${suffix}`,
        sha256: sha256Hex(contents),
      },
    ],
    omitted: [],
    privacy: "local-only",
    refs: REFS(facts) ?? {},
    sourceAuthority: facts.authority,
    packageVersion: 1,
  };
  const canonical = canonicalJson(manifest);
  const digest = `sha256:${sha256Hex(new TextEncoder().encode(canonical))}`;
  return { contents, digest, manifest };
};

const baseEnvelope = (
  facts: ReflectFacts,
  suffix: string,
  kind: string,
  digest: string,
): Record<string, unknown> => ({
  eventId: `${facts.authority}:${facts.invocationId}:${suffix}`,
  evidence: { digest, ref: `${facts.authority}:hcn/${facts.invocationId}/${suffix}` },
  execution: { evidence: "hcn stream-turn argv render", mode: "headless" },
  invocationId: facts.invocationId,
  kind,
  occurredAt: facts.occurredAt,
  producerId: "hcn",
  privacy: "local-only",
  schemaVersion: 1,
  sourceAuthority: facts.authority,
  ...(facts.workParent === undefined ? {} : { refs: { workParent: facts.workParent } }),
});

export const startedEvent = (facts: ReflectFacts): ReflectEvent => {
  const observation = {
    harness: facts.harness,
    invocationId: facts.invocationId,
    kind: "invocation.started",
    occurredAt: facts.occurredAt,
  };
  const pkg = observationPackage(facts, "started", observation);
  return {
    body: {
      envelope: baseEnvelope(facts, "started", "invocation.started", pkg.digest),
      packages: [
        {
          contents: {
            [`${facts.invocationId}:started`]: new TextDecoder().decode(pkg.contents),
          },
          digest: pkg.digest,
          manifest: pkg.manifest,
        },
      ],
    },
    eventId: `${facts.authority}:${facts.invocationId}:started`,
    invocationId: facts.invocationId,
  };
};

export interface ReflectIdentity {
  readonly sessionId: string;
  readonly authority: "harness-minted" | "caller-assigned";
}

export const identityEvent = (facts: ReflectFacts, identity: ReflectIdentity): ReflectEvent => {
  const observation = {
    harness: facts.harness,
    identity,
    invocationId: facts.invocationId,
    kind: "identity.observed",
    occurredAt: facts.occurredAt,
  };
  const pkg = observationPackage(facts, "identity", observation);
  return {
    body: {
      envelope: {
        ...baseEnvelope(facts, "identity", "identity.observed", pkg.digest),
        identity: {
          authority: identity.authority,
          harnessAuthority: `${facts.harness}:${facts.authority}`,
          nativeSessionId: identity.sessionId,
        },
      },
      packages: [
        {
          contents: {
            [`${facts.invocationId}:identity`]: new TextDecoder().decode(pkg.contents),
          },
          digest: pkg.digest,
          manifest: pkg.manifest,
        },
      ],
    },
    eventId: `${facts.authority}:${facts.invocationId}:identity`,
    invocationId: facts.invocationId,
  };
};

export interface ReflectTerminal {
  readonly exitCode: number | null;
  readonly cause: string;
}

export const closedEvent = (facts: ReflectFacts, terminal: ReflectTerminal): ReflectEvent => {
  const observation = {
    harness: facts.harness,
    invocationId: facts.invocationId,
    kind: "process.closed",
    occurredAt: facts.occurredAt,
    terminal,
  };
  const pkg = observationPackage(facts, "closed", observation);
  return {
    body: {
      envelope: {
        ...baseEnvelope(facts, "closed", "process.closed", pkg.digest),
        terminal: { cause: terminal.cause, exitCode: terminal.exitCode },
      },
      packages: [
        {
          contents: {
            [`${facts.invocationId}:closed`]: new TextDecoder().decode(pkg.contents),
          },
          digest: pkg.digest,
          manifest: pkg.manifest,
        },
      ],
    },
    eventId: `${facts.authority}:${facts.invocationId}:closed`,
    invocationId: facts.invocationId,
  };
};

/** How the producer delivers: one bounded synchronous-local spawn of the
 * intake's capture command. Never throws; a false return is a swallowed
 * delivery failure. */
export type ReflectDelivery = (authority: string, bin: string, body: unknown) => Promise<boolean>;

export interface ReflectProducer {
  /** Mint the invocation id and capture invocation.started. */
  started(harness: string): void;
  /** Capture identity.observed for the invocation's first native identity. */
  identity(harness: string, identity: ReflectIdentity): void;
  /** Capture process.closed; awaited bounded. No-op when nothing started. */
  closed(harness: string, terminal: ReflectTerminal): Promise<void>;
}

export const reflectProducer = (
  config: ReflectConfig,
  deliver: ReflectDelivery,
  now: () => string = () => new Date().toISOString(),
): ReflectProducer => {
  let invocationId: string | null = null;
  const facts = (harness: string): ReflectFacts => ({
    authority: config.authority,
    harness,
    invocationId: invocationId ?? "",
    occurredAt: now(),
    ...(config.workParent !== undefined ? { workParent: config.workParent } : {}),
  });
  return {
    closed: async (harness, terminal) => {
      if (invocationId === null) return;
      const event = closedEvent(facts(harness), terminal);
      try {
        await deliver(config.authority, config.bin, event.body);
      } catch {
        // A reflection delivery failure never fails or delays the run.
      }
    },
    identity: (harness, identity) => {
      if (invocationId === null) return;
      deliver(config.authority, config.bin, identityEvent(facts(harness), identity).body).catch(
        () => {},
      );
    },
    started: (harness) => {
      invocationId = randomUUID();
      deliver(config.authority, config.bin, startedEvent(facts(harness)).body).catch(() => {});
    },
  };
};

/** The real producer from the process environment, or undefined when the
 * deployment has not enabled capture (the off state until the backup and
 * restore gate has passed). */
export const reflectProducerFromEnv = (
  env: Env,
  deliver: ReflectDelivery,
): ReflectProducer | undefined => {
  const config = reflectConfigFromEnv(env);
  return config === undefined
    ? undefined
    : reflectProducer(config, deliver, () => new Date().toISOString());
};
