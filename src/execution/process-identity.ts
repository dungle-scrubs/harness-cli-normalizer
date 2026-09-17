import { readFileSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import type { NativeProcessOwner } from "./deps.js";

type OwnerProbe = (pid: number) => NativeProcessOwner | undefined;

type FfiCall = (...args: (number | bigint | Uint8Array)[]) => number;

interface BunFfi {
  dlopen(
    path: string,
    definition: Record<string, { readonly args: readonly string[]; readonly returns: string }>,
  ): { readonly symbols: Record<string, FfiCall | undefined> };
}

/** Bun's own FFI carries no napi finalizers, so it cannot hit the
 * napi_reference_unref GC panic that koffi triggers in Bun under load. */
function bunDarwinProbe(): OwnerProbe | undefined {
  if ((globalThis as { readonly Bun?: unknown }).Bun === undefined) return undefined;
  try {
    const ffi = createRequire(import.meta.url)("bun:ffi") as BunFfi;
    const { symbols } = ffi.dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
      proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
    });
    const info = symbols.proc_pidinfo;
    const path = symbols.proc_pidpath;
    if (typeof info !== "function" || typeof path !== "function") return () => undefined;
    return (pid) => {
      // Darwin sys/proc_info.h: proc_bsdinfo is 136 bytes, start sec/usec at 120/128.
      const buffer = new Uint8Array(136);
      const view = new DataView(buffer.buffer);
      if (info(pid, 3, 0, buffer, buffer.length) !== buffer.length) return undefined;
      if (view.getUint32(12, true) !== pid) return undefined;
      const startedAt = `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`;
      const bytes = new Uint8Array(4096);
      if (path(pid, bytes, bytes.length) <= 0) return undefined;
      const end = bytes.indexOf(0);
      if (end <= 0) return undefined;
      const executable = new TextDecoder().decode(bytes.subarray(0, end));
      if (
        info(pid, 3, 0, buffer, buffer.length) !== buffer.length ||
        view.getUint32(12, true) !== pid ||
        `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}` !== startedAt
      )
        return undefined;
      return { executable, pid, startedAt };
    };
  } catch {
    // A broken Bun FFI backend fails closed; loading koffi here would crash.
    return () => undefined;
  }
}

function koffiDarwinProbe(): OwnerProbe {
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

function darwinProbe(): OwnerProbe {
  // Under Bun, koffi's napi finalizers panic (napi_reference_unref) in Bun's
  // GC under load, killing the CLI mid-protocol. Bun's own FFI calls the same
  // libproc entry points. Node keeps the koffi backend.
  return bunDarwinProbe() ?? koffiDarwinProbe();
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
