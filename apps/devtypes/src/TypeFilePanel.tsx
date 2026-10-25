import React, { useState } from "react";
import { TYPE_FILE_MAX_BYTES_DEFAULT, TypeFileBuildEntry } from "../../../src/main";
import { useModel } from "./App";

const STAGE_TEXT: Record<string, string> = {
    status: "Reading the device's file", upload: "Uploading", check: "The device is checking the file", confirm: "Waiting for you",
    apply: "Applying", restart: "The device is restarting", verify: "Checking the device loaded it", done: "Done",
};

function decodingNote(entry: TypeFileBuildEntry, decode: { attrs?: boolean; code?: boolean } | undefined): string {
    if (!entry.noDecoder)
        return entry.kind === "override" ? "the compiled decoder" : "";
    if (entry.decoder === "none")
        return decode?.code ? "on the device (code interpreter)" : decode ? "in this app only - DataLogger, ROS and named values won't see it" :
            "on the device only with the code interpreter";
    return decode?.attrs === false ? "in this app only - the firmware has no runtime decoding" : "on the device, from its attributes";
}

function SourceRecords({ name }: { name: string }) {
    const m = useModel();
    const [filter, setFilter] = useState("");
    const loaded = m.sourceRecords.get(name);
    if (!loaded)
        return null;
    const all = `${name}:*`;
    const keys = Array.from(loaded.records.keys()).filter((k) => k.toLowerCase().includes(filter.toLowerCase()));
    return (
        <details className="card">
            <summary><b>{name}</b> <span className="muted">({loaded.records.size} records{m.includes(all) ? ", all in the type file" : ""})</span></summary>
            <div className="row">
                <label><input type="checkbox" checked={m.includes(all)} onChange={(e) => void m.toggleInclude(all, e.target.checked)} /> All of them ({all})</label>
                <input type="search" placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="row">
                {keys.map((k) => (
                    <label key={k} style={{ minWidth: 180 }}>
                        <input type="checkbox" checked={m.includes(`${name}:${k}`)} disabled={m.includes(all)}
                            onChange={(e) => void m.toggleInclude(`${name}:${k}`, e.target.checked)} /> <span className="mono">{k}</span>
                    </label>
                ))}
            </div>
        </details>
    );
}

export function TypeFilePanel() {
    const m = useModel();
    const b = m.build;
    const tf = m.selection.typeFile;
    const decode = m.device?.status?.decode;
    const connected = m.connState === "connected";
    const busy = m.pushState.stage !== undefined && !m.pushState.result;
    const pushResult = m.pushState.result;
    return (
        <>
            <div className="card">
                <h3>Selection</h3>
                {(tf.include ?? []).length === 0 && Object.keys(tf.policy ?? {}).length === 0 &&
                    <p className="muted">Nothing yet. Add records from the catalogue, the device's unidentified addresses or the sources below, and
                        disable compiled types on the Device tab.</p>}
                <div className="row">
                    {(tf.include ?? []).map((p) => (
                        <span key={p} className="tag mono">{p} <button className="link" onClick={() => void m.toggleInclude(p, false)} title="remove">×</button></span>
                    ))}
                    {Object.entries(tf.policy ?? {}).map(([k, p]) => (
                        <span key={k} className="tag mono">{k}: {p} <button className="link" onClick={() => void m.setPolicy(k, undefined)} title="remove">×</button></span>
                    ))}
                </div>
                {((tf.include ?? []).length > 0 || Object.keys(tf.policy ?? {}).length > 0) &&
                    <button className="btn" onClick={() => void m.clearSelection()}>Clear</button>}
            </div>
            {Object.keys(m.selection.sources).map((name) => <SourceRecords key={name} name={name} />)}

            <div className="card">
                <h3>The type file</h3>
                {b.offline && <div className="notice">No device connected: every record is shown as new. Connect to compare with the records the
                    device has compiled in (those identical to a compiled record are left out).</div>}
                {b.unknownCompiled.length > 0 && <div className="notice warn">The device's current type file replaces {b.unknownCompiled.join(", ")},
                    so their compiled records can't be read: they are kept in the file.</div>}
                {b.error && <div className="notice error">{b.error}</div>}
                {b.result && (
                    <>
                        {b.offline && b.result.bytes > TYPE_FILE_MAX_BYTES_DEFAULT &&
                            <div className="notice warn">{b.result.bytes} bytes is more than boards without PSRAM take by default
                                ({TYPE_FILE_MAX_BYTES_DEFAULT} bytes; {b.maxBytes} with PSRAM).</div>}
                        <p>{b.result.bytes} of {b.maxBytes} bytes{b.offline ? " (with PSRAM)" : ""} · CRC <span className="mono">{b.result.crc}</span>
                            {m.device?.pulled && m.device.pulled.crc === b.result.crc && <span className="ok"> · the device has this file</span>}</p>
                        <div className="table-wrap">
                            <table>
                                <thead><tr><th>Type</th><th>Source</th><th>What it does</th><th>Decoded</th><th>Notes</th></tr></thead>
                                <tbody>
                                    {b.result.entries.map((e) => (
                                        <tr key={e.key}>
                                            <td className="mono">{e.key}</td>
                                            <td className="mono">{b.selection?.origin.get(e.key) ?? ""}</td>
                                            <td>{e.kind === "new" ? "adds a type" : e.kind === "override" ? "replaces the compiled record" :
                                                e.kind === "unchanged" ? "the same as compiled - left out" : e.policy === "disabledClaim" ? "disables it (address kept)" : "disables it"}</td>
                                            <td>{e.kind === "new" || e.kind === "override" ? decodingNote(e, decode) : ""}</td>
                                            <td>{e.initCode === "runtime" ? "init code: needs the code interpreter" : e.initCode ? "init code: compiled one used without the interpreter" : ""}
                                                {b.codeProblems.has(e.key) && <div className="bad">Code outside the decode language - the device won't
                                                    run it (so no decoding on the device), and a build warns about it: {(b.codeProblems.get(e.key) as string[]).join("; ")}</div>}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
                <div className="row">
                    <button className="btn" disabled={!connected || !b.result || busy} onClick={() => void m.push(true)}
                        title="Upload it and have the device check it, without applying it">Check on the device</button>
                    <button className="btn primary" disabled={!connected || !b.result || busy} onClick={() => void m.push(false)}>Push to the device</button>
                    {!connected && <span className="muted">connect a device to push</span>}
                </div>
                {busy && <p>{STAGE_TEXT[m.pushState.stage as string] ?? m.pushState.stage}{m.pushState.detail ? ` (${m.pushState.detail})` : ""}...</p>}
                {pushResult && (
                    <div className={`notice ${["applied", "dryRun", "unchangedOnDevice"].includes(pushResult.outcome) ? "" : "error"}`}>
                        {pushResult.message}
                        {pushResult.outcome === "deviceFileChanged" && <> - read it again on the Device tab, or{" "}
                            <button className="link" onClick={() => { if (m.device) m.device.pulled = undefined; void m.push(false); }}>push anyway</button></>}
                    </div>
                )}
                {pushResult?.check?.entries && pushResult.outcome !== "applied" && (
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th>Type</th><th>The device's check</th><th>Notes</th></tr></thead>
                            <tbody>
                                {pushResult.check.entries.map((e) => (
                                    <tr key={e.key}><td className="mono">{e.key}</td><td className={e.outcome === "rejected" ? "bad" : ""}>{e.outcome}</td>
                                        <td>{[e.error, e.warnings].filter(Boolean).join("; ")}</td></tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </>
    );
}
