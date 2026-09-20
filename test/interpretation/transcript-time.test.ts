/**
 * The native start times reach a row in one shape. The interpretation layer
 * cannot construct a `Date`, so the conversion is arithmetic and is checked
 * here against the runtime's own `Date`, which the test is free to use.
 */
import { expect, test } from "vitest";
import {
  utcTime,
  utcTimeFromEpochMicros,
  utcTimeFromEpochMillis,
} from "../../src/interpretation/transcript/time.js";

test("an ISO UTC marker keeps its instant and gains millisecond precision", () => {
  expect(utcTime("2026-09-20T13:00:00.000Z")).toBe("2026-09-20T13:00:00.000Z");
  // Antigravity writes second precision.
  expect(utcTime("2026-09-19T00:00:00Z")).toBe("2026-09-19T00:00:00.000Z");
  // A sub-millisecond tail is dropped, never rounded up past the native time.
  expect(utcTime("2026-09-20T13:00:00.999999Z")).toBe("2026-09-20T13:00:00.999Z");
  expect(utcTime("2026-09-20T13:00:00.5Z")).toBe("2026-09-20T13:00:00.500Z");
  expect(utcTime("2026-09-20 13:00:00Z")).toBe("2026-09-20T13:00:00.000Z");
});

test("a marker that is not UTC, or not a time, reports nothing", () => {
  // An offset is not read as UTC: reporting nothing beats reporting a lie.
  expect(utcTime("2026-09-20T13:00:00+02:00")).toBeNull();
  expect(utcTime("2026-09-20T13:00:00")).toBeNull();
  expect(utcTime("2026-09-20")).toBeNull();
  expect(utcTime("")).toBeNull();
  expect(utcTime("last Tuesday")).toBeNull();
});

const INSTANTS = [
  0,
  1,
  -1,
  86399999,
  86400000,
  951782400000, // 2000-02-29, a leap day in a century that is a leap year
  1709164800000, // 2024-02-29
  4107542400000, // 2100-03-01, the century that is not
  1789643942579, // a real cursor createdAtMs
  -2208988800000, // 1900-01-01, before the epoch
  253402300799999, // 9999-12-31T23:59:59.999Z, the last four-digit year
  -62135596800000, // 0001-01-01T00:00:00.000Z, the first
];

test("epoch milliseconds convert exactly, matching the runtime's own Date", () => {
  for (const millis of INSTANTS)
    expect(utcTimeFromEpochMillis(millis), String(millis)).toBe(new Date(millis).toISOString());
});

test("epoch microseconds drop the sub-millisecond digits rather than rounding", () => {
  // Muse counts in microseconds; 16 digits on the real store.
  expect(utcTimeFromEpochMicros(1789643942579_000)).toBe(new Date(1789643942579).toISOString());
  expect(utcTimeFromEpochMicros(1789643942579_999)).toBe(new Date(1789643942579).toISOString());
  expect(utcTimeFromEpochMicros(0)).toBe("1970-01-01T00:00:00.000Z");
});

test("a value outside a four-digit year reports nothing", () => {
  // ISO 8601 needs its expanded `+275760-09-13` form past year 9999, which no
  // native store writes; a row reports nothing rather than that.
  for (const millis of [
    253402300800000, // 10000-01-01
    -62135596800001, // one millisecond before 0001-01-01
    8.64e15,
    -8.64e15,
    8.64e15 + 1,
    Number.NaN,
    Infinity,
    -Infinity,
  ])
    expect(utcTimeFromEpochMillis(millis), String(millis)).toBeNull();
  expect(utcTimeFromEpochMicros(Number.NaN)).toBeNull();
  expect(utcTimeFromEpochMicros(9e18)).toBeNull();
});
