export class IqRecorder {
    constructor(emit) {
        this.emit = emit;
        this.handle = null;
        this.name = '';
        this.bytes = 0;
        this.lastReport = 0;
    }
    reset() { }
    get recording() { return this.handle !== null; }
    static async dir() {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle('captures', { create: true });
    }
    async start(freqHz, rate) {
        await this.stop();
        const dir = await IqRecorder.dir();
        const t = new Date();
        const ts = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}_${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
        const base = `${ts}_${(freqHz / 1e6).toFixed(3)}MHz_${Math.round(rate / 1000)}k`;
        const txt = await dir.getFileHandle(`${base}.txt`, { create: true });
        const w = await txt.createWritable();
        await w.write(`sample_rate=${rate}\ncenter_frequency=${freqHz}\nformat=c8 (signed int8 I,Q)\n`);
        await w.close();
        const fh = await dir.getFileHandle(`${base}.c8`, { create: true });
        this.handle = await fh.createSyncAccessHandle();
        this.name = `${base}.c8`;
        this.bytes = 0;
        this.emit({ type: 'capture', recording: true, name: this.name, bytes: 0 });
        this.emit({ type: 'log', line: `capture: recording ${this.name}` });
    }
    async stop() {
        const h = this.handle;
        if (!h)
            return;
        this.handle = null;
        try {
            h.flush();
            h.close();
        }
        catch { }
        this.emit({ type: 'capture', recording: false, name: this.name, bytes: this.bytes });
        this.emit({ type: 'log', line: `capture: stopped ${this.name} (${(this.bytes / 1e6).toFixed(1)} MB)` });
        await this.list();
    }
    onIq(iq) {
        const h = this.handle;
        if (!h)
            return;
        try {
            h.write(iq);
            this.bytes += iq.length;
            const now = performance.now();
            if (now - this.lastReport > 500) {
                this.lastReport = now;
                this.emit({ type: 'capture', recording: true, name: this.name, bytes: this.bytes });
            }
        }
        catch (e) {
            this.emit({ type: 'log', line: `capture write failed: ${e.message}` });
            this.handle = null;
            try {
                h.close();
            }
            catch { }
        }
    }
    async list() {
        const dir = await IqRecorder.dir();
        const files = [];
        const entries = dir.entries();
        for await (const [name, handle] of entries) {
            if (handle.kind === 'file' && name.endsWith('.c8'))
                files.push({ name, size: (await handle.getFile()).size });
        }
        files.sort((a, b) => b.name.localeCompare(a.name));
        this.emit({ type: 'captures', files });
    }
    async get(name) {
        const dir = await IqRecorder.dir();
        const f = await (await dir.getFileHandle(name)).getFile();
        let txt = '';
        try {
            txt = await (await (await dir.getFileHandle(name.replace(/\.c8$/, '.txt'))).getFile()).text();
        }
        catch { }
        this.emit({ type: 'captureFile', name, file: f, sidecar: txt });
    }
    async remove(name) {
        const dir = await IqRecorder.dir();
        await dir.removeEntry(name).catch(() => undefined);
        await dir.removeEntry(name.replace(/\.c8$/, '.txt')).catch(() => undefined);
        await this.list();
    }
}
