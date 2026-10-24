import React, { useEffect, useState } from "react";
import { useModel } from "./App";
import { download } from "./util";

export function ExportPanel() {
    const m = useModel();
    const [asBuiltin, setAsBuiltin] = useState(false);
    const [lock, setLock] = useState<string | undefined>();
    useEffect(() => {
        void m.lockText().then(setLock).catch(() => setLock(undefined));
    }, [m.version]);
    const sourcesText = m.sourcesFileText(asBuiltin);
    const sysDir = `systypes/${m.sysType}`;
    return (
        <>
            <div className="card">
                <h3>Put this setup into a project</h3>
                <p>The download is laid out as a Raft project: unpack it into the project folder. <code>DeviceTypeSources.json</code> selects the
                    records (and its lock pins git sources to their commits); local record files go where its path sources say.</p>
                <div className="row">
                    <label>SysType <input type="text" value={m.sysType} onChange={(e) => m.setSysType(e.target.value)} size={14} /></label>
                    <label><input type="checkbox" checked={asBuiltin} onChange={(e) => setAsBuiltin(e.target.checked)} /> Compile them into the firmware
                        (<code>builtin</code>) instead of a type file (<code>typeFile</code>)</label>
                </div>
                <div className="row">
                    <button className="btn primary" onClick={() => void m.exportZip(asBuiltin).then((zip) => download(`devtypes-${m.sysType}.zip`, zip, "application/zip"))}>
                        Download all (zip)</button>
                    <button className="btn" onClick={() => download("DeviceTypeSources.json", sourcesText)}>DeviceTypeSources.json</button>
                    <button className="btn" disabled={!lock} onClick={() => lock && download("DeviceTypeSources.lock", lock)}>DeviceTypeSources.lock</button>
                    <button className="btn" disabled={!m.build.result} onClick={() => m.build.result && download("devlib.json", m.build.result.text)}>devlib.json</button>
                </div>
                {!asBuiltin && <p className="muted">With <code>"fsImage": true</code> in its typeFile section, a build puts the type file in the
                    file system image, so flashing the board installs it.</p>}
            </div>
            <div className="card">
                <h3>{sysDir}/DeviceTypeSources.json</h3>
                <pre>{sourcesText}</pre>
                {lock && <><h3>{sysDir}/DeviceTypeSources.lock</h3><pre>{lock}</pre></>}
            </div>
        </>
    );
}
