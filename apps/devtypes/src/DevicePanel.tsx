import React from "react";
import { DeviceTypePolicyName } from "../../../src/main";
import { useModel } from "./App";
import { bundledSourceName } from "./CataloguePanel";
import { download, hex2 } from "./util";

export function DevicePanel() {
    const m = useModel();
    if (m.connState !== "connected")
        return (
            <div className="card">
                <h3>Connect to a device</h3>
                <p>Connect to a Raft device by Bluetooth or USB serial (Chrome or Edge) to see the devices it has found, the device
                    types it knows and its device type file, and to change that file.</p>
                {location.protocol === "https:" &&
                    <p className="muted">WiFi isn't offered on this page: a page served over https can't open a connection to a device on
                        your network. To use WiFi, run this app on your computer (it is in raftjs, apps/devtypes).</p>}
            </div>
        );
    const d = m.device;
    if (!d)
        return <p className="muted">Reading the device...</p>;
    const s = d.status;
    const bundled = bundledSourceName(m);
    const table = d.table ?? [];
    return (
        <>
            {d.error && <div className="notice error">{d.error}</div>}
            <div className="grid2">
                <div className="card">
                    <h3>{d.systemName ?? "Device"} {d.systemVersion}</h3>
                    <dl className="kv">
                        <dt>RaftCore</dt><dd>{s?.raftCore ?? <span className="muted">not reported (firmware before 2026-10-24)</span>}</dd>
                        <dt>On-device decoding</dt>
                        <dd>{s?.decode === undefined ? <span className="muted">not reported</span> :
                            s.decode.attrs ? (s.decode.code ? "attributes and custom code" : "attributes (not custom code)") : "none"}</dd>
                        <dt>Device types</dt><dd>{table.length} ({table.filter((t) => t.src === "base").length} compiled in)</dd>
                    </dl>
                    <div className="row">
                        <button className="btn" onClick={() => void m.refreshDevice()}>Refresh</button>
                        <button className="btn" onClick={() => void m.reidentify()}>Identify again</button>
                    </div>
                </div>
                <div className="card">
                    <h3>Device type file</h3>
                    {s?.rslt === "ok" ? (
                        <>
                            <dl className="kv">
                                <dt>File</dt><dd className="mono">{s.file || "none configured"}</dd>
                                <dt>State</dt><dd>{s.state}{s.crc && s.present ? <span className="muted"> (CRC {s.crc})</span> : null}</dd>
                                {s.present && <><dt>Entries</dt><dd>{s.added} added, {s.replaced} replaced, {s.disabled} disabled, {s.rejected} rejected</dd></>}
                                {s.firstError && <><dt>First error</dt><dd className="bad">{s.firstError}</dd></>}
                                <dt>Limits</dt><dd>{s.maxFileBytes} bytes; {s.records}/{s.maxRecords} extended records</dd>
                            </dl>
                            {s.restartRequired && <div className="notice warn">The file has changed since startup - a restart applies it</div>}
                            <div className="row">
                                <button className="btn" disabled={!s.present} onClick={() => void m.pull()}>Read the file</button>
                            </div>
                        </>
                    ) : <p className="muted">Not supported by this firmware.</p>}
                </div>
            </div>

            {d.pulled && (
                <div className="card">
                    <h3>The device's type file <span className="muted mono">{d.pulled.path}</span></h3>
                    <p>{d.pulled.text.length} bytes, CRC {d.pulled.crc}: {d.pulled.keys.join(", ") || "no entries"}</p>
                    <p className="muted">{d.pulled.sources ? "It says how it was made (_sources), so the selection can be loaded and changed." :
                        "It doesn't say how it was made (no _sources): its records can be loaded as a local source."}</p>
                    <div className="row">
                        <button className="btn primary" onClick={() => void m.usePulledFile()}>Start from this file</button>
                        <button className="btn" onClick={() => download("devlib.json", (d.pulled as { text: string }).text)}>Download it</button>
                    </div>
                </div>
            )}

            <div className="card">
                <h3>Devices found</h3>
                {d.devices.length === 0 && d.unidentified.length === 0 && <p className="muted">None.</p>}
                {d.devices.length > 0 && (
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th>Device</th><th>ID</th><th>Type</th></tr></thead>
                            <tbody>
                                {d.devices.map((dev) => (
                                    <tr key={dev.deviceid}><td>{dev.displayName}</td><td className="mono">{dev.deviceid}</td><td className="mono">{dev.key ?? ""}</td></tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {d.unidentified.map((u) => {
                    const candidates = m.recordsForAddress(u.addr);
                    return (
                        <div key={`${u.bus}-${u.addr}-${u.slot}`} className="notice warn">
                            <b>Not identified:</b> {u.bus} address {hex2(u.addr)}{u.slot ? ` (slot ${u.slot})` : ""} responds, but no device type it
                            knows matches.{" "}
                            {candidates.length > 0 ? <>Records for this address in the catalogue:{" "}
                                {candidates.map((c) => {
                                    const pattern = bundled ? `${bundled}:${c.key}` : undefined;
                                    const known = table.some((t) => t.key === c.key);
                                    return (
                                        <span key={c.key} style={{ marginRight: 10 }}>
                                            <b>{c.key}</b> ({c.summary.name}){known ? <span className="muted"> - the device has it</span> : pattern && (
                                                <> <button className="link" onClick={() => void m.toggleInclude(pattern, !m.includes(pattern))}>
                                                    {m.includes(pattern) ? "remove from the type file" : "add to the type file"}</button></>)}
                                        </span>
                                    );
                                })}</> : <span className="muted">The catalogue has no record for this address.</span>}
                        </div>
                    );
                })}
            </div>

            <div className="card">
                <h3>Device types the device knows</h3>
                <p className="muted">Compiled-in types can be disabled by the type file (so they aren't used to identify devices).</p>
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Type</th><th>From</th><th>Policy now</th><th>In the type file</th></tr></thead>
                        <tbody>
                            {table.map((t) => (
                                <tr key={t.dtIdx}>
                                    <td className="mono">{t.key}</td>
                                    <td>{t.src === "base" ? "compiled" : t.src === "override" ? "type file (replaces compiled)" : "type file"}</td>
                                    <td>{t.policy}{t.protected ? <span className="tag" style={{ marginLeft: 6 }}>protected</span> : null}</td>
                                    <td>{t.src === "base" && !t.protected ? (
                                        <select value={m.policyOf(t.key) ?? ""} onChange={(e) => void m.setPolicy(t.key, (e.target.value || undefined) as DeviceTypePolicyName | undefined)}>
                                            <option value="">enabled</option>
                                            <option value="disabled">disabled</option>
                                            <option value="disabledClaim">disabled, address kept</option>
                                        </select>
                                    ) : t.protected ? <span className="muted">a system device expects it</span> : null}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </>
    );
}
