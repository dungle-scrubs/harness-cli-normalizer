import { readFileSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import type { NativeProcessOwner } from "./deps.js";

type OwnerProbe = (pid: number) => NativeProcessOwner | undefined;

function darwinProbe(): OwnerProbe {
  // Load only for terminal provenance on Darwin. Other operations and platforms
  // do not require a native addon to start a harness.
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const library = koffi.load("/usr/lib/libproc.dylib");
  const info = library.func(
    "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)",
  );
  const path = library.func("int proc_pidpath(int pid, void *buffer, uint32_t size)");
  return (pid) => {
    // Darwin sys/proc_info.h: proc_bsdinfo is 136 bytes, start sec/usec at 120/128.
    const buffer = Buffer.alloc(136);
    if (info(pid, 3, 0, buffer, buffer.length) !== buffer.length) return undefined;
    if (buffer.readUInt32LE(12) !== pid) return undefined;
    const startedAt = `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`;
    const bytes = Buffer.alloc(4096);
    if (path(pid, bytes, bytes.length) <= 0) return undefined;
    const end = bytes.indexOf(0);
    if (end <= 0) return undefined;
    const executable = bytes.subarray(0, end).toString("utf8");
    if (
      info(pid, 3, 0, buffer, buffer.length) !== buffer.length ||
      buffer.readUInt32LE(12) !== pid ||
      `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}` !== startedAt
    )
      return undefined;
    return { executable, pid, startedAt };
  };
}

function linuxOwner(pid: number): NativeProcessOwner | undefined {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const ticks = (): string | undefined => {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    return text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
  };
  const start = ticks();
  if (!/^[\da-f-]+$/i.test(bootId) || !start || !/^\d+$/.test(start)) return undefined;
  const executable = readlinkSync(`/proc/${pid}/exe`);
  if (ticks() !== start) return undefined;
  return { executable, pid, startedAt: `${bootId}:${start}` };
}

let darwin: OwnerProbe | undefined;

/** Fresh kernel identity. Failure means unknown, never confirmed process absence. */
export function readNativeProcessOwner(pid: number): NativeProcessOwner | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return undefined;
  try {
    if (process.platform === "linux") return linuxOwner(pid);
    if (process.platform === "darwin") {
      darwin ??= darwinProbe();
      return darwin(pid);
    }
  } catch {
    // Missing backend, unreadable process or PID reuse cannot establish identity.
  }
  return undefined;
}
