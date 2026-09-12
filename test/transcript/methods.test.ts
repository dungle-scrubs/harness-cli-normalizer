import { expect, test } from "vitest";
import { chooseTranscriptMethod } from "../../src/interpretation/transcript/methods.js";
import { PI_TRANSCRIPT, PI_TRANSCRIPT_METHOD } from "../../src/knowledge/transcript/pi.js";

test("method selection rejects unavailable coverage even when the caller accepts its name", () => {
  const method = {
    ...PI_TRANSCRIPT_METHOD,
    capabilities: {
      ...PI_TRANSCRIPT_METHOD.capabilities,
      history: { ...PI_TRANSCRIPT_METHOD.capabilities.history, status: "unavailable" as const },
    },
  };
  const selected = chooseTranscriptMethod(
    { ...PI_TRANSCRIPT, methods: [method] },
    {
      acceptedLimits: ["history"],
      selector: "file",
      incremental: false,
      paging: false,
    },
  );
  expect(selected.method).toBeNull();
  expect(selected.failure?.issue).toBe("transcript-divergence");
});

test.each(["unknown", "unavailable", "limited"] as const)(
  "passivity %s cannot be waived",
  (status) => {
    const method = {
      ...PI_TRANSCRIPT_METHOD,
      passivity: { ...PI_TRANSCRIPT_METHOD.passivity, status },
    };
    expect(
      chooseTranscriptMethod(
        { ...PI_TRANSCRIPT, methods: [method] },
        {
          acceptedLimits: ["history", "branches", "original-records", "embedded-content"],
          selector: "file",
          incremental: false,
          paging: false,
        },
      ).failure?.issue,
    ).toBe("passive-read-unverified");
  },
);

test("full retained history wins over an accepted reduced projection", () => {
  const reduced = {
    ...PI_TRANSCRIPT_METHOD,
    id: "synthetic-reduced",
    preference: 0,
    capabilities: {
      ...PI_TRANSCRIPT_METHOD.capabilities,
      history: { ...PI_TRANSCRIPT_METHOD.capabilities.history, status: "limited" as const },
    },
  };
  const full = { ...PI_TRANSCRIPT_METHOD, preference: 1 };
  const request = {
    acceptedLimits: ["history" as const],
    selector: "file" as const,
    incremental: false,
    paging: false,
  };
  expect(
    chooseTranscriptMethod({ ...PI_TRANSCRIPT, methods: [reduced, full] }, request).method?.id,
  ).toBe(full.id);
  expect(chooseTranscriptMethod({ ...PI_TRANSCRIPT, methods: [reduced] }, request).method?.id).toBe(
    reduced.id,
  );
});

test("a verified reduced method offers its exact opt-in hint on refusal", () => {
  const method = {
    ...PI_TRANSCRIPT_METHOD,
    capabilities: {
      ...PI_TRANSCRIPT_METHOD.capabilities,
      history: { ...PI_TRANSCRIPT_METHOD.capabilities.history, status: "limited" as const },
    },
  };
  const result = chooseTranscriptMethod(
    { ...PI_TRANSCRIPT, methods: [method] },
    {
      acceptedLimits: [],
      selector: "file",
      incremental: false,
      paging: false,
    },
  );
  expect(result.failure?.hint?.requiredAcceptedLimits).toEqual(["history"]);
  expect(result.failure?.hint?.methodId).toBe(method.id);
});
