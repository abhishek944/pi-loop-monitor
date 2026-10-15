import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_BYTES = 64 * 1024;

export interface MonitorOutputPage {
  text: string;
  start: number;
  end: number;
  total: number;
  path: string;
  error?: string;
}

/** Full command text lives on disk; callers only load one UTF-8-safe page. */
export class MonitorOutputLog {
  readonly path: string;
  private readonly directory: string;
  private readonly fd: number;
  private size = 0;
  private error: string | undefined;

  constructor() {
    this.directory = mkdtempSync(join(tmpdir(), "pi-monitor-"));
    this.path = join(this.directory, "output.log");
    try {
      this.fd = openSync(this.path, "wx+", 0o600);
    } catch (error) {
      rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }

  append(data: Buffer): void {
    if (this.error) return;
    try {
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(this.fd, data, offset, data.length - offset, this.size);
        if (written === 0) throw new Error("Output log write made no progress");
        offset += written;
        this.size += written;
      }
    } catch (error) {
      this.error = `Full output capture stopped: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Omit offset to read the tail. Explicit offsets are stable while output grows. */
  read(offset?: number): MonitorOutputPage {
    let start = Math.max(0, Math.min(this.size, Math.floor(offset ?? Math.max(0, this.size - PAGE_BYTES))));
    const buffer = Buffer.alloc(Math.min(PAGE_BYTES + 4, this.size - start));
    const length = readSync(this.fd, buffer, 0, buffer.length, start);
    let first = 0;
    // A page may start inside a UTF-8 character; that character belongs to the previous page.
    while (start > 0 && first < Math.min(3, length) && (buffer[first]! & 0xc0) === 0x80) first++;
    let end = Math.min(length, PAGE_BYTES);
    // Move a valid UTF-8 character to the next page, without stalling on invalid bytes.
    if (end < length) {
      let lead = end;
      while (lead > Math.max(first, end - 3) && (buffer[lead]! & 0xc0) === 0x80) lead--;
      const byte = buffer[lead]!;
      const expected = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
      if (expected > 1 && end - lead > 0 && end - lead < expected) end = lead;
    }
    start += first;
    return {
      text: buffer.subarray(first, end).toString("utf8"),
      start,
      end: start + end - first,
      total: this.size,
      path: this.path,
      error: this.error,
    };
  }

  dispose(): void {
    try { closeSync(this.fd); } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
