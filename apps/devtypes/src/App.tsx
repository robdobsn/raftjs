import React, { useEffect, useState, useSyncExternalStore } from "react";
import { DevTypesModel } from "./model";
import { CataloguePanel } from "./CataloguePanel";
import { DevicePanel } from "./DevicePanel";
import { SourcesPanel } from "./SourcesPanel";
import { TypeFilePanel } from "./TypeFilePanel";
import { ExportPanel } from "./ExportPanel";

export const model = new DevTypesModel();
(window as unknown as { devtypesModel: DevTypesModel }).devtypesModel = model;     // for scripted tests

// Re-render when the model changes
export function useModel(): DevTypesModel {
    useSyncExternalStore((cb) => model.subscribe(cb), () => model.version);
    return model;
}

const TABS = ["Catalogue", "Device", "Sources", "Type file", "Export"] as const;
type Tab = typeof TABS[number];

function ConnectBar() {
    const m = useModel();
    const [host, setHost] = useState("");
    const secure = window.isSecureContext;
    const hasBle = "bluetooth" in navigator;
    const hasSerial = "serial" in navigator;
    // ws:// from an https page is blocked (mixed content), so WiFi is offered only on http pages and localhost
    const wsAllowed = location.protocol === "http:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (m.connState === "connected")
        return (
            <div className="conn">
                <span className="ok">Connected ({m.connMethod === "WebBLE" ? "Bluetooth" : m.connMethod === "WebSerial" ? "serial" : "WiFi"})</span>
                <button className="btn" onClick={() => void m.disconnect()}>Disconnect</button>
            </div>
        );
    return (
        <div className="conn">
            {m.connState === "connecting" && <span className="muted">Connecting...</span>}
            <button className="btn" disabled={!secure || !hasBle || m.connState === "connecting"} onClick={() => void m.connect("WebBLE")}
                title={hasBle ? "Connect by Bluetooth" : "This browser has no Web Bluetooth (use Chrome or Edge)"}>Bluetooth</button>
            <button className="btn" disabled={!secure || !hasSerial || m.connState === "connecting"} onClick={() => void m.connect("WebSerial")}
                title={hasSerial ? "Connect by USB serial" : "This browser has no Web Serial (use Chrome or Edge on a computer)"}>Serial</button>
            {wsAllowed && (
                <>
                    <input type="text" placeholder="device IP or name" value={host} onChange={(e) => setHost(e.target.value)} size={16} />
                    <button className="btn" disabled={!host || m.connState === "connecting"} onClick={() => void m.connect("WebSocket", host)}>WiFi</button>
                </>
            )}
        </div>
    );
}

function PushConfirm() {
    const m = useModel();
    const check = m.pushState.check;
    if (!m.pushState.awaitingConfirm || !check)
        return null;
    return (
        <div className="modal">
            <div className="card">
                <h3>Apply this type file?</h3>
                <p>The device checked the file: {check.added ?? 0} added, {check.replaced ?? 0} replaced, {check.unchanged ?? 0} unchanged,{" "}
                    {check.disabled ?? 0} disabled, {check.rejected ?? 0} rejected. Applying it restarts the device.</p>
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Type</th><th>Outcome</th><th>Decoder</th><th>Notes</th></tr></thead>
                        <tbody>
                            {(check.entries ?? []).map((e) => (
                                <tr key={e.key}>
                                    <td>{e.key}</td><td>{e.outcome}</td><td>{e.decoder ?? (e.noDecoder ? "none" : "")}</td>
                                    <td>{[e.error, e.warnings].filter(Boolean).join("; ")}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <div className="row">
                    <button className="btn primary" onClick={() => m.confirmPush(true)}>Apply and restart</button>
                    <button className="btn" onClick={() => m.confirmPush(false)}>Cancel</button>
                </div>
            </div>
        </div>
    );
}

export default function App() {
    const m = useModel();
    const [tab, setTab] = useState<Tab>("Catalogue");
    useEffect(() => {
        void model.start();
    }, []);
    useEffect(() => {
        if (m.connState === "connected")
            setTab((t) => (t === "Catalogue" ? "Device" : t));
    }, [m.connState]);
    return (
        <>
            <header>
                <h1>Raft Device Types</h1>
                <ConnectBar />
            </header>
            <nav>
                {TABS.map((t) => (
                    <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
                ))}
            </nav>
            <main>
                {m.connError && <div className="notice error">Not connected: {m.connError}</div>}
                {m.message && <div className={`notice ${m.message.error ? "error" : ""}`}>{m.message.text}{" "}
                    <button className="link" onClick={() => m.dismissMessage()}>dismiss</button></div>}
                {tab === "Catalogue" && <CataloguePanel />}
                {tab === "Device" && <DevicePanel />}
                {tab === "Sources" && <SourcesPanel />}
                {tab === "Type file" && <TypeFilePanel />}
                {tab === "Export" && <ExportPanel />}
            </main>
            <PushConfirm />
        </>
    );
}
