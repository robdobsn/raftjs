import React, { useEffect, useRef, useState } from "react";
import { ESPLoader, Transport } from "esptool-js";
import type { FlashFreqValues, FlashModeValues, FlashSizeValues } from "esptool-js";
import { FlashBuild, FlashMode, PickedFile, buildFromFolder, buildFromManifest, chipFamilyName, hex, imagesForMode,
    isFileSystemPartition, partitionSubtypeName, PARTITION_TYPE_NAMES } from "./flashImage";
import { md5Hex } from "./md5";

const ROLE_TEXT: Record<string, string> = { bootloader: "Bootloader", partitionTable: "Partition table", app: "App",
    fs: "File system image", other: "Other" };
const BAUD_RATES = [115200, 460800, 921600, 1500000, 2000000];

// Files picked from a folder (or one by one): flasher_args.json first, then only the files it names (a build folder
// holds thousands of others)
async function readPicked(list: FileList): Promise<PickedFile[]> {
    const files = Array.from(list);
    const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const argsFiles = files.filter((f) => rel(f).endsWith("flasher_args.json")).sort((a, b) => rel(a).length - rel(b).length);
    if (argsFiles.length === 0)
        return [];
    const argsFile = argsFiles[0];
    const argsText = await argsFile.text();
    const wanted = new Set<string>();
    try {
        const args = JSON.parse(argsText) as { flash_files?: Record<string, string> };
        Object.values(args.flash_files ?? {}).forEach((p) => wanted.add(p.replace(/\\/g, "/")));
    } catch {
        // buildFromFolder reports it
    }
    const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    const wantedNames = new Set(Array.from(wanted).map(base));
    const out: PickedFile[] = [{ path: rel(argsFile), data: new TextEncoder().encode(argsText) }];
    for (const f of files) {
        const p = rel(f).replace(/\\/g, "/");
        if (f === argsFile || !(Array.from(wanted).some((w) => p.endsWith("/" + w) || p === w) || wantedNames.has(base(p))))
            continue;
        out.push({ path: p, data: new Uint8Array(await f.arrayBuffer()) });
    }
    return out;
}

function sizeText(n: number): string {
    return n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`;
}

function BuildView({ build, mode }: { build: FlashBuild; mode: FlashMode }) {
    const writing = new Set(imagesForMode(build, mode));
    return (
        <>
            <dl className="kv">
                <dt>Build</dt><dd>{build.name}{build.chip ? ` for ${chipFamilyName(build.chip)}` : ""}</dd>
                {build.app && <><dt>App</dt><dd>{build.app.projectName} <span className="mono">{build.app.version}</span>
                    <span className="muted"> - built {build.app.date} {build.app.time}, ESP-IDF {build.app.idfVersion}</span></dd></>}
                {build.settings.flashSize && <><dt>Flash</dt><dd>{build.settings.flashSize}, {build.settings.flashMode}, {build.settings.flashFreq}</dd></>}
            </dl>
            <div className="table-wrap">
                <table>
                    <thead><tr><th>Image</th><th>File</th><th className="num">Offset</th><th className="num">Size</th><th>Partition</th><th /></tr></thead>
                    <tbody>
                        {build.images.map((img) => (
                            <tr key={img.offset} className={writing.has(img) ? "" : "skipped"}>
                                <td>{ROLE_TEXT[img.role]}</td>
                                <td className="mono">{img.path}</td>
                                <td className="num mono">{hex(img.offset)}</td>
                                <td className="num">{sizeText(img.data.length)}</td>
                                <td>{img.partition ? `${img.partition.name} (${sizeText(img.partition.size)})` : ""}</td>
                                <td className="muted">{writing.has(img) ? "" : "not written"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {build.partitions.length > 0 && (
                <details>
                    <summary>Partition table</summary>
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th>Name</th><th>Type</th><th>Subtype</th><th className="num">Offset</th><th className="num">Size</th></tr></thead>
                            <tbody>
                                {build.partitions.map((p) => (
                                    <tr key={p.name}>
                                        <td>{p.name}</td><td>{PARTITION_TYPE_NAMES[p.type] ?? p.type}</td>
                                        <td>{partitionSubtypeName(p)}{isFileSystemPartition(p) ? " (file system)" : ""}</td>
                                        <td className="num mono">{hex(p.offset)}</td><td className="num">{sizeText(p.size)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </details>
            )}
            {build.problems.map((p) => <div key={p} className="notice error">{p}</div>)}
        </>
    );
}

export default function App() {
    const [build, setBuild] = useState<FlashBuild | undefined>();
    const [loadError, setLoadError] = useState<string | undefined>();
    const [manifestUrl, setManifestUrl] = useState(new URLSearchParams(location.search).get("manifest") ?? "");
    const [mode, setMode] = useState<FlashMode>("all");
    const [eraseAll, setEraseAll] = useState(false);
    const [baud, setBaud] = useState(921600);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<{ label: string; fraction: number } | undefined>();
    const [log, setLog] = useState("");
    const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>();
    const logRef = useRef<HTMLPreElement>(null);
    const hasSerial = "serial" in navigator;

    useEffect(() => {
        if (manifestUrl)
            void loadManifest();
    }, []);
    useEffect(() => {
        if (logRef.current)
            logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [log]);

    const appendLog = (text: string) => setLog((l) => l + text);

    const loadFiles = async (list: FileList | null) => {
        setResult(undefined);
        if (!list || list.length === 0)
            return;
        try {
            const files = await readPicked(list);
            setBuild(buildFromFolder(files));
            setLoadError(undefined);
        } catch (err) {
            setBuild(undefined);
            setLoadError(err instanceof Error ? err.message : String(err));
        }
    };

    async function loadManifest() {
        setResult(undefined);
        try {
            setBuild(await buildFromManifest(manifestUrl, undefined));
            setLoadError(undefined);
        } catch (err) {
            setBuild(undefined);
            setLoadError(err instanceof Error ? err.message : String(err));
        }
    }

    const flash = async () => {
        if (!build)
            return;
        const images = imagesForMode(build, mode);
        if (images.length === 0)
            return;
        setBusy(true);
        setResult(undefined);
        setLog("");
        let transport: Transport | undefined;
        try {
            const port = await navigator.serial.requestPort();
            transport = new Transport(port, false);
            const loader = new ESPLoader({
                transport, baudrate: baud, debugLogging: false,
                terminal: { clean: () => setLog(""), writeLine: (d: string) => appendLog(d + "\n"), write: (d: string) => appendLog(d) },
            });
            setProgress({ label: "Connecting", fraction: 0 });
            const chipDesc = await loader.main();
            appendLog(`Connected: ${chipDesc}\n`);
            // The build must be for this chip
            if (build.chip && chipFamilyName(loader.chip.CHIP_NAME) !== chipFamilyName(build.chip))
                throw new Error(`This build is for ${chipFamilyName(build.chip)} but the board is ${loader.chip.CHIP_NAME} - nothing was written`);
            if (eraseAll) {
                setProgress({ label: "Erasing the flash", fraction: 0 });
                await loader.eraseFlash();
            }
            const total = images.reduce((n, i) => n + i.data.length, 0);
            const done: number[] = images.map(() => 0);
            await loader.writeFlash({
                fileArray: images.map((i) => ({ data: i.data, address: i.offset })),
                flashMode: (build.settings.flashMode ?? "keep") as FlashModeValues,
                flashFreq: (build.settings.flashFreq ?? "keep") as FlashFreqValues,
                flashSize: (build.settings.flashSize ?? "keep") as FlashSizeValues,
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, fileTotal) => {
                    done[fileIndex] = images[fileIndex].data.length * (fileTotal ? written / fileTotal : 1);
                    setProgress({ label: `Writing ${ROLE_TEXT[images[fileIndex].role].toLowerCase()} (${images[fileIndex].path})`,
                        fraction: done.reduce((a, b) => a + b, 0) / total });
                },
                calculateMD5Hash: md5Hex,
            });
            setProgress({ label: "Restarting the board", fraction: 1 });
            await loader.after("hard_reset");
            setResult({ ok: true, text: `Flashed ${images.length} image${images.length === 1 ? "" : "s"} (${sizeText(total)}), each checked, and the board was restarted.` });
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            setResult({ ok: false, text: text.includes("No port selected") ? "No port was chosen" : text });
        } finally {
            try {
                await transport?.disconnect();
            } catch {
                // already closed
            }
            setProgress(undefined);
            setBusy(false);
        }
    };

    const writesFs = build ? imagesForMode(build, mode).some((i) => i.role === "fs") : false;
    return (
        <>
            <header>
                <h1>Raft Flasher</h1>
                <nav className="links"><a href="../devtypes/app/">Device Types</a> <a href="../">RaftCore</a></nav>
            </header>
            <main>
                <p className="lede">Flash a Raft app to an ESP32 over USB: the bootloader, partition table, app and file system image of a
                    build, written where <code>raft flash</code> writes them. Chrome or Edge on a computer.</p>
                {!hasSerial && <div className="notice error">This browser has no Web Serial - use Chrome or Edge on a computer.</div>}

                <div className="card">
                    <h3>1. The build</h3>
                    <div className="row">
                        <label className="btn">Build folder...<input type="file" hidden disabled={busy}
                            {...{ webkitdirectory: "", directory: "" } as Record<string, string>} onChange={(e) => void loadFiles(e.target.files)} /></label>
                        <label className="btn">Files...<input type="file" hidden multiple disabled={busy} accept=".json,.bin"
                            onChange={(e) => void loadFiles(e.target.files)} /></label>
                        <span className="muted">the project's <code>build/&lt;SysType&gt;</code> folder, or its <code>flasher_args.json</code> and <code>.bin</code> files</span>
                    </div>
                    <div className="row">
                        <input type="text" placeholder="or the URL of a manifest (ESP Web Tools format)" value={manifestUrl}
                            onChange={(e) => setManifestUrl(e.target.value)} size={50} />
                        <button className="btn" disabled={!manifestUrl || busy} onClick={() => void loadManifest()}>Load</button>
                    </div>
                    {loadError && <div className="notice error">{loadError}</div>}
                    {build && <BuildView build={build} mode={mode} />}
                </div>

                <div className="card">
                    <h3>2. Flash it</h3>
                    <div className="row">
                        <label><input type="radio" checked={mode === "all"} onChange={() => setMode("all")} /> Everything</label>
                        <label><input type="radio" checked={mode === "firmware"} onChange={() => setMode("firmware")} /> Firmware only - keep the file system</label>
                        <label><input type="radio" checked={mode === "fs"} onChange={() => setMode("fs")}
                            disabled={!!build && !build.images.some((i) => i.role === "fs")} /> File system only</label>
                    </div>
                    <div className="row">
                        <label><input type="checkbox" checked={eraseAll} onChange={(e) => setEraseAll(e.target.checked)} /> Erase the whole flash first</label>
                        <label>Speed <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
                            {BAUD_RATES.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>
                    </div>
                    {writesFs && <div className="notice warn">Writing the file system image replaces the files on the device - among them its
                        device type file (<code>/local/devlib.json</code>) and saved device settings (<code>/local/devsettings.json</code>) - with
                        the build's. Choose "Firmware only" to keep them.</div>}
                    {eraseAll && <div className="notice warn">Erasing also clears settings kept in NVS, such as WiFi credentials.</div>}
                    <div className="row">
                        <button className="btn primary" disabled={!hasSerial || !build || busy || build.problems.length > 0 || imagesForMode(build, mode).length === 0}
                            onClick={() => void flash()}>Connect and flash</button>
                        <span className="muted">Choose the board's serial port. If it doesn't connect, hold BOOT while pressing RESET, then try again.</span>
                    </div>
                    {progress && (
                        <div className="progress">
                            <div className="bar"><div style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
                            <span>{progress.label} - {Math.round(progress.fraction * 100)}%</span>
                        </div>
                    )}
                    {result && <div className={`notice ${result.ok ? "" : "error"}`}>{result.text}
                        {result.ok && <> <a href="../devtypes/app/">Open Device Types</a> to see the device.</>}</div>}
                    {log && <details open={!result?.ok}><summary>Log</summary><pre ref={logRef}>{log}</pre></details>}
                </div>
            </main>
        </>
    );
}
