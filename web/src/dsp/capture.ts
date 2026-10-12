/**
 * IQ capture to the browser's origin-private file system (OPFS): signed-int8 I/Q as `.c8` (the HackRF's native
 * hackrf_transfer format) plus a Mayhem-style `.txt` sidecar. Writes use a synchronous access handle, which
 * exists only inside workers — exactly where the IQ already is.
 */
import type { Emit, IqProcessor } from './core.js';

interface SyncHandle { write(b: BufferSource): number; flush(): void; close(): void; }
interface FileHandleWithSync extends FileSystemFileHandle { createSyncAccessHandle(): Promise<SyncHandle>; }

export class IqRecorder implements IqProcessor {
  private handle: SyncHandle | null = null;
  private name = '';
  private bytes = 0;
  private lastReport = 0;

  constructor(private readonly emit: Emit) {}
  reset(): void {}
  get recording(): boolean { return this.handle !== null; }

  private static async dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('captures', { create: true });
  }

  async start(freqHz: number, rate: number): Promise<void> {
    await this.stop();
    const dir = await IqRecorder.dir();
    const t = new Date();
    const ts = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}_${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
    const base = `${ts}_${(freqHz / 1e6).toFixed(3)}MHz_${Math.round(rate / 1000)}k`;
    const txt = await dir.getFileHandle(`${base}.txt`, { create: true });
    const w = await txt.createWritable();
    await w.write(`sample_rate=${rate}\ncenter_frequency=${freqHz}\nformat=c8 (signed int8 I,Q)\n`);
    await w.close();
    const fh = await dir.getFileHandle(`${base}.c8`, { create: true }) as FileHandleWithSync;
    this.handle = await fh.createSyncAccessHandle();
    this.name = `${base}.c8`;
    this.bytes = 0;
    this.emit({ type: 'capture', recording: true, name: this.name, bytes: 0 });
    this.emit({ type: 'log', line: `capture: recording ${this.name}` });
  }

  async stop(): Promise<void> {
    const h = this.handle;
    if (!h) return;
    this.handle = null;
    try { h.flush(); h.close(); } catch { /* ignore */ }
    this.emit({ type: 'capture', recording: false, name: this.name, bytes: this.bytes });
    this.emit({ type: 'log', line: `capture: stopped ${this.name} (${(this.bytes / 1e6).toFixed(1)} MB)` });
    await this.list();
  }

  onIq(iq: Int8Array): void {
    const h = this.handle;
    if (!h) return;
    try {
      h.write(iq);
      this.bytes += iq.length;
      const now = performance.now();
      if (now - this.lastReport > 500) { this.lastReport = now; this.emit({ type: 'capture', recording: true, name: this.name, bytes: this.bytes }); }
    } catch (e) {
      this.emit({ type: 'log', line: `capture write failed: ${(e as Error).message}` });
      this.handle = null;
      try { h.close(); } catch { /* ignore */ }
    }
  }

  async list(): Promise<void> {
    const dir = await IqRecorder.dir();
    const files: { name: string; size: number }[] = [];
    const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind === 'file' && name.endsWith('.c8')) files.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size });
    }
    files.sort((a, b) => b.name.localeCompare(a.name));
    this.emit({ type: 'captures', files });
  }

  async get(name: string): Promise<void> {
    const dir = await IqRecorder.dir();
    const f = await (await dir.getFileHandle(name)).getFile();
    let txt = '';
    try { txt = await (await (await dir.getFileHandle(name.replace(/\.c8$/, '.txt'))).getFile()).text(); } catch { /* optional */ }
    this.emit({ type: 'captureFile', name, file: f, sidecar: txt });
  }

  async remove(name: string): Promise<void> {
    const dir = await IqRecorder.dir();
    await dir.removeEntry(name).catch(() => undefined);
    await dir.removeEntry(name.replace(/\.c8$/, '.txt')).catch(() => undefined);
    await this.list();
  }
}
