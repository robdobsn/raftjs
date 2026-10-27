import React, { useMemo, useState } from "react";
import { DevTypeJson, devTypeJsonGet, devTypeJsonToPlain, writeDevTypeJson } from "../../../src/main";
import { useModel } from "./App";

// The name of the selection's source of RaftCore's records
export function bundledSourceName(m: ReturnType<typeof useModel>): string | undefined {
    return Object.keys(m.selection.sources).find((n) => m.sourceKind(n) === "bundled");
}

export function RecordView({ record, keyName }: { record: DevTypeJson | undefined; keyName: string }) {
    if (record === undefined)
        return <p className="muted">Loading the record...</p>;
    const plain = devTypeJsonToPlain(record) as Record<string, any>;
    const info = plain.devInfoJson ?? {};
    const attrs: any[] = info.resp?.a ?? [];
    const actions: any[] = info.actions ?? [];
    return (
        <>
            {typeof plain._warning === "string" && plain._warning.trim() !== "" &&
                <div className="notice warn"><b>Warning:</b> {plain._warning}</div>}
            <dl className="kv">
                <dt>Key</dt><dd className="mono">{keyName}</dd>
                {info.name && <><dt>Name</dt><dd>{info.name}</dd></>}
                {info.manu && <><dt>Manufacturer</dt><dd>{info.manu}</dd></>}
                {info.desc && <><dt>Description</dt><dd>{info.desc}</dd></>}
                {plain.addresses && <><dt>Addresses</dt><dd className="mono">{plain.addresses}</dd></>}
                {plain.hwTypeId && <><dt>Hardware type ID</dt><dd className="mono">{plain.hwTypeId}</dd></>}
                {plain.pollInfo?.i !== undefined && <><dt>Poll interval</dt><dd>{plain.pollInfo.i / 1000} ms</dd></>}
                {info.resp?.c && <><dt>Decoding</dt><dd>custom decode code (decoded on the device only with the code interpreter)</dd></>}
                {plain.initCode && <><dt>Init code</dt><dd>yes (runs on the device only with the code interpreter, unless compiled in)</dd></>}
            </dl>
            {attrs.length > 0 && (
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Attribute</th><th>Type</th><th>Units</th><th>Range</th></tr></thead>
                        <tbody>
                            {attrs.map((a, i) => (
                                <tr key={i}>
                                    <td>{a.n}</td><td className="mono">{a.t}</td>
                                    <td dangerouslySetInnerHTML={{ __html: escapeUnits(a.u) }} />
                                    <td className="mono">{Array.isArray(a.r) ? a.r.join(" to ") : ""}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {actions.length > 0 && <p className="muted">Actions: {actions.map((a) => a.n).join(", ")}</p>}
            <details>
                <summary>The record</summary>
                <pre>{writeDevTypeJson(record, { indent: 2 })}</pre>
            </details>
        </>
    );
}

// Units are written with HTML entities (&deg;C): allow those and nothing else
function escapeUnits(u: unknown): string {
    if (typeof u !== "string")
        return "";
    return u.replace(/&(?!#?[a-zA-Z0-9]+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function CataloguePanel() {
    const m = useModel();
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<string | undefined>(undefined);
    const entries = m.catalogue?.entries() ?? [];
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q)
            return entries;
        return entries.filter((e) => {
            const s = e.summary;
            const clas = Array.isArray(s.clas) ? s.clas.join(" ") : (s.clas ?? "");
            const hay = [e.key, s.name, s.manu, s.type, clas, s.addresses, s.hwTypeId].join(" ").toLowerCase();
            // An address ("0x6a") also matches records whose range holds it
            if (/^0x[0-9a-f]{1,2}$/.test(q)) {
                const addr = parseInt(q, 16);
                if (m.recordsForAddress(addr).some((r) => r.key === e.key))
                    return true;
            }
            return hay.includes(q);
        });
    }, [query, entries, m]);
    const bundled = bundledSourceName(m);
    const records = bundled ? m.sourceRecords.get(bundled)?.records : undefined;
    const current = selected ?? filtered[0]?.key;
    const pattern = bundled && current ? `${bundled}:${current}` : undefined;
    const label = m.catalogue?.label;

    if (m.catalogueError)
        return <div className="notice error">{m.catalogueError}</div>;
    if (!m.catalogue)
        return <p className="muted">Loading the catalogue...</p>;
    return (
        <>
            <div className="row">
                <input type="search" placeholder="Search by name, manufacturer, class or address (0x6a)" value={query}
                    onChange={(e) => setQuery(e.target.value)} />
                <label className="muted">RaftCore{" "}
                    <select value={label} onChange={(e) => void m.openCatalogue(e.target.value)}>
                        {(m.index?.versions ?? []).map((v) => <option key={v.label} value={v.label}>{v.label}{v.count ? ` (${v.count})` : ""}</option>)}
                    </select>
                </label>
                {m.device?.status?.raftCore && <span className="muted">the device has RaftCore {m.device.status.raftCore}</span>}
            </div>
            <div className="split">
                <div className="list">
                    {filtered.map((e) => (
                        <div key={e.key} className={`item ${e.key === current ? "active" : ""}`} onClick={() => setSelected(e.key)}>
                            <div className="title">{e.summary.warning &&
                                <span className="tag warn" title={e.summary.warning} style={{ marginRight: 6 }}>⚠ warning</span>}
                                {e.summary.name ?? e.key}{bundled && m.includes(`${bundled}:${e.key}`) &&
                                <span className="tag" style={{ marginLeft: 8 }}>in the type file</span>}</div>
                            <div className="muted">{e.key}{e.summary.manu ? ` · ${e.summary.manu}` : ""}{e.summary.addresses ? ` · ${e.summary.addresses}` : ""}</div>
                        </div>
                    ))}
                    {filtered.length === 0 && <div className="item muted">No records match</div>}
                </div>
                <div>
                    {current && (
                        <div className="card">
                            <h3>{m.catalogueEntry(current)?.summary.name ?? current}</h3>
                            <div className="row">
                                {pattern && (
                                    <label>
                                        <input type="checkbox" checked={m.includes(pattern)} onChange={(e) => void m.toggleInclude(pattern, e.target.checked)} />
                                        {" "}In the type file
                                    </label>
                                )}
                                <a href={`https://github.com/robdobsn/RaftCore/blob/${label === "main" || !label ? "main" : label}/devtypes/records/${current}.json`}
                                    target="_blank" rel="noreferrer">On GitHub</a>
                            </div>
                            <RecordView record={records?.get(current)} keyName={current} />
                            {records?.get(current) !== undefined && devTypeJsonGet(records.get(current), "devInfoJson", "resp") === undefined &&
                                <p className="muted">This record has no data (nothing is polled).</p>}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
