import React, { useState } from "react";
import { DeviceTypeRecordFile, DeviceTypeSourceRecordsWithFiles } from "../../../src/main";
import { useModel } from "./App";

async function readFiles(list: FileList | null): Promise<DeviceTypeRecordFile[]> {
    const files = Array.from(list ?? []);
    return Promise.all(files.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, text: await f.text() })));
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

function AddGitSource() {
    const m = useModel();
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [ref, setRef] = useState("");
    const [path, setPath] = useState("");
    const valid = NAME_RE.test(name) && !m.selection.sources[name] && url && ref;
    return (
        <div className="card">
            <h3>Add a git source</h3>
            <p className="muted">A public GitHub repo with a folder of record files (default <code>records</code>) or one record file, at a tag,
                branch or commit - as a <code>git</code> source in DeviceTypeSources.json.</p>
            <div className="row">
                <input type="text" placeholder="name, e.g. acme" value={name} onChange={(e) => setName(e.target.value)} size={10} />
                <input type="text" placeholder="https://github.com/owner/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} size={34} />
                <input type="text" placeholder="tag, branch or commit" value={ref} onChange={(e) => setRef(e.target.value)} size={14} />
                <input type="text" placeholder="path (records)" value={path} onChange={(e) => setPath(e.target.value)} size={12} />
                <button className="btn primary" disabled={!valid} onClick={() => { void m.addGitSource(name, url, ref, path); setName(""); setUrl(""); setRef(""); setPath(""); }}>Add</button>
            </div>
        </div>
    );
}

function AddLocalSource() {
    const m = useModel();
    const [name, setName] = useState("local");
    const [path, setPath] = useState("../../devtypes");
    const valid = NAME_RE.test(name) && !m.selection.sources[name];
    const add = async (list: FileList | null, asFolder: boolean) => {
        const files = await readFiles(list);
        if (files.length)
            await m.addLocalSource(name, path, asFolder ? files : files, asFolder || files.length > 1);
    };
    return (
        <div className="card">
            <h3>Add record files from this computer</h3>
            <p className="muted">Record files (<code>&lt;Key&gt;.json</code>) or a catalogue file - a <code>path</code> source. They are kept
                in this browser, and the export puts them at the path below (relative to <code>systypes/&lt;SysType&gt;/</code>).</p>
            <div className="row">
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} size={10} title="source name" />
                <input type="text" value={path} onChange={(e) => setPath(e.target.value)} size={16} title="path in the project" />
                <label className="btn">Files...<input type="file" multiple accept=".json" hidden disabled={!valid}
                    onChange={(e) => void add(e.target.files, false)} /></label>
                <label className="btn">Folder...<input type="file" hidden disabled={!valid}
                    {...{ webkitdirectory: "", directory: "" } as Record<string, string>} onChange={(e) => void add(e.target.files, true)} /></label>
                {!valid && <span className="muted">choose a new name</span>}
            </div>
        </div>
    );
}

function ImportProject() {
    const m = useModel();
    const [common, setCommon] = useState<File | undefined>();
    const [sysType, setSysType] = useState<File | undefined>();
    const [lock, setLock] = useState<File | undefined>();
    const doImport = async () => {
        const files = [];
        if (common)
            files.push({ name: "systypes/Common/DeviceTypeSources.json", text: await common.text() });
        if (sysType)
            files.push({ name: `systypes/${m.sysType}/DeviceTypeSources.json`, text: await sysType.text() });
        await m.importProject(files, lock ? await lock.text() : undefined);
    };
    return (
        <div className="card">
            <h3>Import a project's selection</h3>
            <p className="muted">Its <code>DeviceTypeSources.json</code> files (Common's and the SysType's) and lock: git sources are read at
                the locked commits, so the records are those the project's build uses. A path source's records are then picked here.</p>
            <div className="row">
                <label>Common <input type="file" accept=".json" onChange={(e) => setCommon(e.target.files?.[0])} /></label>
                <label>SysType <input type="file" accept=".json" onChange={(e) => setSysType(e.target.files?.[0])} /></label>
                <label>Lock <input type="file" accept=".lock,.json" onChange={(e) => setLock(e.target.files?.[0])} /></label>
                <button className="btn primary" disabled={!common && !sysType} onClick={() => void doImport()}>Import</button>
            </div>
        </div>
    );
}

export function SourcesPanel() {
    const m = useModel();
    return (
        <>
            <div className="card">
                <h3>Sources</h3>
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Name</th><th>Kind</th><th>What</th><th>Records</th><th /></tr></thead>
                        <tbody>
                            {Object.entries(m.selection.sources).map(([name, spec]) => {
                                const kind = m.sourceKind(name);
                                const loaded = m.sourceRecords.get(name) as DeviceTypeSourceRecordsWithFiles | undefined;
                                const error = m.sourceErrors.get(name);
                                return (
                                    <tr key={name}>
                                        <td className="mono">{name}</td>
                                        <td>{kind}</td>
                                        <td>
                                            {kind === "bundled" && <>RaftCore's records {m.catalogue ? `(${m.catalogue.label})` : ""}</>}
                                            {kind === "git" && <><span className="mono">{String(spec.git)}</span> at {String(spec.ref)}
                                                {loaded?.commit && <div className="muted mono">commit {loaded.commit.slice(0, 12)}</div>}</>}
                                            {kind === "path" && <span className="mono">{String(spec.path)}</span>}
                                            {error && <div className="bad">{error}</div>}
                                        </td>
                                        <td className="num">{loaded ? loaded.records.size : ""}</td>
                                        <td>
                                            <div className="row" style={{ margin: 0 }}>
                                                {kind === "git" && <button className="btn" onClick={() => void m.updateGitSource(name)}
                                                    title="Resolve the ref again (newer commits on a branch)">Update</button>}
                                                {kind === "path" && <label className="btn">Files...<input type="file" multiple hidden accept=".json"
                                                    onChange={(e) => void readFiles(e.target.files).then((f) => m.setLocalFiles(name, f, f.length > 1))} /></label>}
                                                <button className="btn" onClick={() => void m.removeSource(name)}>Remove</button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                {m.sourcesLoading && <p className="muted">Reading sources...</p>}
                {!Object.keys(m.selection.sources).some((n) => m.sourceKind(n) === "bundled") &&
                    <button className="btn" onClick={() => void m.addBundledSource()}>Add RaftCore's records</button>}
            </div>
            <AddGitSource />
            <AddLocalSource />
            <ImportProject />
        </>
    );
}
