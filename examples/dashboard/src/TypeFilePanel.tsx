/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// TypeFilePanel
// Device type file: the device's current file, and pushing a new one with raftjs's DeviceTypeFileManager - uploaded
// under another name, checked by the device (what each entry would do, and where its on-device decoder comes from),
// then applied (the device restarts) and verified once it is back. See the RaftCore wiki: DeviceManager REST API,
// devman/typefile
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { useEffect, useRef, useState } from 'react';
import './styles.css';
import { DevManTypeFileCheck, DevManTypeFileEntry, DevManTypeFileStatus, DeviceTypeFileManager, TypeFilePushStage,
    TypeFileResponse, typeFileCrc } from '../../../src/main';
import ConnManager from './ConnManager';

const connManager = ConnManager.getInstance();

const STAGE_TEXT: Record<TypeFilePushStage, string> = {
    status: 'Reading the device\'s file', upload: 'Uploading', check: 'The device is checking the file',
    confirm: 'Checked', apply: 'Applying', restart: 'The device is restarting', verify: 'Checking the device loaded it', done: 'Done',
};

export default function TypeFilePanel() {
    const managerRef = useRef<DeviceTypeFileManager | null>(null);
    if (!managerRef.current)
        managerRef.current = new DeviceTypeFileManager(connManager.getConnector());
    const manager = managerRef.current;

    const [supported, setSupported] = useState<boolean | null>(null);
    const [status, setStatus] = useState<TypeFileResponse<DevManTypeFileStatus> | null>(null);
    const [fileName, setFileName] = useState('');
    const [fileText, setFileText] = useState<string | null>(null);
    const [fileInfo, setFileInfo] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState('');
    const [check, setCheck] = useState<TypeFileResponse<DevManTypeFileCheck> | null>(null);
    const [awaitingApply, setAwaitingApply] = useState(false);
    const [message, setMessage] = useState('');
    const [isError, setIsError] = useState(false);
    const confirmRef = useRef<((apply: boolean) => void) | null>(null);

    const refreshStatus = async () => {
        const resp = await manager.status();
        const ok = resp?.rslt === 'ok';
        setSupported(ok);
        if (ok)
            setStatus(resp);
    };

    useEffect(() => {
        void refreshStatus();
    }, []);

    const report = (text: string, error = false) => {
        setMessage(text);
        setIsError(error);
    };

    const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
        setCheck(null);
        report('');
        const file = e.target.files?.[0];
        if (!file) {
            setFileText(null);
            setFileName('');
            setFileInfo('');
            return;
        }
        const text = await file.text();
        setFileName(file.name);
        setFileText(text);
        // A quick look before sending - the device does the real check
        try {
            const { devTypes } = DeviceTypeFileManager.parseTypeFile(text);
            const keys = Array.from(devTypes.keys());
            setFileInfo(`${text.length} bytes, CRC ${typeFileCrc(text)}, ${keys.length} entr${keys.length === 1 ? 'y' : 'ies'}: ${keys.join(', ')}`);
        } catch (err) {
            setFileInfo(`${text.length} bytes - ${err instanceof Error ? err.message : err}, the device will reject it`);
        }
    };

    // Push: the device checks the file, and it is applied only when Apply is pressed (dryRun: only checked)
    const handlePush = async (dryRun: boolean) => {
        if (fileText === null)
            return;
        setBusy(true);
        setCheck(null);
        report('');
        const result = await manager.push(fileText, {
            dryRun,
            force: true,
            onProgress: (stage, detail) => setProgress(`${STAGE_TEXT[stage]}${detail ? ` (${detail})` : ''}...`),
            confirm: (checked) => new Promise<boolean>((resolve) => {
                setCheck(checked);
                setAwaitingApply(true);
                setProgress('');
                confirmRef.current = resolve;
            }),
        });
        setAwaitingApply(false);
        setProgress('');
        if (result.check)
            setCheck(result.check);
        const ok = result.outcome === 'applied' || result.outcome === 'dryRun' || result.outcome === 'notConfirmed';
        report(result.outcome === 'dryRun' ? 'Checked by the device - not applied (the uploaded file was removed)' : result.message, !ok);
        setBusy(false);
        if (result.outcome === 'applied')
            await refreshStatus();
    };

    const answer = (apply: boolean) => {
        if (!apply || window.confirm('Make this file the device type file and restart the device?')) {
            setAwaitingApply(false);
            confirmRef.current?.(apply);
            confirmRef.current = null;
        }
    };

    const handleDownload = async () => {
        const pulled = await manager.pull();
        if (!pulled) {
            report('The device type file could not be read', true);
            return;
        }
        const url = URL.createObjectURL(new Blob([pulled.text], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = pulled.path.slice(pulled.path.lastIndexOf('/') + 1) || 'devlib.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    if (!supported)
        return null;

    const entries: DevManTypeFileEntry[] = check?.entries ?? [];

    return (
        <div className="info-box type-file-panel">
            <h3>Device Type File</h3>
            <div className="type-file-status">
                {status?.present ? (
                    <>
                        <div>{status.file}{status.state ? ` - ${status.state}` : ''}{status.crc ? ` (crc ${status.crc})` : ''}
                            {' '}<button className="action-button" onClick={() => void handleDownload()} disabled={busy}>Download</button></div>
                        {status.restartRequired && <div className="type-file-warning">Changed on disk - a restart is needed to apply it</div>}
                        {status.firstError && <div className="type-file-warning">{status.firstError}</div>}
                    </>
                ) : (
                    <div>No device type file{status?.file ? ` (${status.file})` : ''}</div>
                )}
                {status?.maxFileBytes ? <div>Limit {status.maxFileBytes} bytes{status.raftCore ? `; RaftCore ${status.raftCore}` : ''}</div> : null}
            </div>
            <div className="type-file-controls">
                <input type="file" accept=".json,application/json" onChange={handleFileChosen} disabled={busy} />
                <button className="action-button" onClick={() => void handlePush(true)} disabled={busy || fileText === null}>
                    Check
                </button>
                <button className="action-button" onClick={() => void handlePush(false)} disabled={busy || fileText === null}>
                    Upload &amp; Check
                </button>
                {awaitingApply && (
                    <>
                        <button className="action-button" onClick={() => answer(true)} disabled={!check?.valid}>Apply (restart)</button>
                        <button className="action-button" onClick={() => answer(false)}>Cancel</button>
                    </>
                )}
            </div>
            {fileName && fileInfo && <div className="type-file-info">{fileName}: {fileInfo}</div>}
            {progress && <div className="type-file-info">{progress}</div>}
            {check?.rslt === 'ok' && (
                <div className="type-file-info">
                    {check.added ?? 0} added, {check.replaced ?? 0} replaced, {check.unchanged ?? 0} unchanged,{' '}
                    {check.disabled ?? 0} disabled, {check.rejected ?? 0} rejected, {check.warnings ?? 0} warnings
                </div>
            )}
            {entries.length > 0 && (
                <table className="type-file-entries">
                    <thead>
                        <tr><th>Type</th><th>Outcome</th><th>Decoder</th><th>Notes</th></tr>
                    </thead>
                    <tbody>
                        {entries.map((entry) => (
                            <tr key={entry.key} className={entry.outcome === 'rejected' ? 'type-file-rejected' : ''}>
                                <td>{entry.key}</td>
                                <td>{entry.outcome}</td>
                                <td>{entry.decoder ?? (entry.noDecoder ? 'none' : '')}</td>
                                <td>{[entry.error, entry.warnings].filter(Boolean).join('; ')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {message && <div className={isError ? 'type-file-warning' : 'type-file-info'}>{message}</div>}
        </div>
    );
}
