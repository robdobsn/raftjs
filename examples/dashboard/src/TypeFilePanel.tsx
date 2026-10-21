/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// TypeFilePanel
// Device type file: the device's current file, and uploading a new one - uploaded under another name, checked by
// the device (what each entry would do, and where its on-device decoder comes from), then applied (the device
// restarts). See the RaftCore wiki: DeviceManager REST API, devman/typefile
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { useEffect, useState } from 'react';
import './styles.css';
import { DevManTypeFileCheck, DevManTypeFileEntry, DevManTypeFileStatus } from '../../../src/main';
import ConnManager from './ConnManager';

const connManager = ConnManager.getInstance();

// The name a new file is uploaded as (in the folder of the device's type file) before it is checked and applied
const UPLOAD_NAME = 'devlib.new.json';

type TypeFileResp<T> = T & { rslt?: string; error?: string };

function folderOf(path: string | undefined): string {
    if (!path)
        return '/local/';
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash + 1) : '/local/';
}

export default function TypeFilePanel() {
    const [supported, setSupported] = useState<boolean | null>(null);
    const [status, setStatus] = useState<TypeFileResp<DevManTypeFileStatus> | null>(null);
    const [fileName, setFileName] = useState('');
    const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
    const [fileInfo, setFileInfo] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState('');
    const [check, setCheck] = useState<TypeFileResp<DevManTypeFileCheck> | null>(null);
    const [message, setMessage] = useState('');
    const [isError, setIsError] = useState(false);

    const uploadPath = folderOf(status?.file) + UPLOAD_NAME;

    const refreshStatus = async () => {
        try {
            const resp = await connManager.getConnector().sendRICRESTMsg('devman/typefile', {}) as TypeFileResp<DevManTypeFileStatus>;
            const ok = resp?.rslt === 'ok';
            setSupported(ok);
            if (ok)
                setStatus(resp);
        } catch {
            setSupported(false);
        }
    };

    useEffect(() => {
        refreshStatus();
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
            setFileBytes(null);
            setFileName('');
            setFileInfo('');
            return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        setFileName(file.name);
        setFileBytes(bytes);
        // A quick look before sending - the device does the real check
        try {
            const json = JSON.parse(new TextDecoder().decode(bytes));
            const keys = json && typeof json.devTypes === 'object' ? Object.keys(json.devTypes) : [];
            if (!json || typeof json.devTypes !== 'object')
                setFileInfo(`${bytes.length} bytes - no "devTypes" object, the device will reject it`);
            else
                setFileInfo(`${bytes.length} bytes, ${keys.length} entr${keys.length === 1 ? 'y' : 'ies'}: ${keys.join(', ')}`);
        } catch {
            setFileInfo(`${bytes.length} bytes - not valid JSON, the device will reject it`);
        }
    };

    const handleUploadAndCheck = async () => {
        if (!fileBytes)
            return;
        setBusy(true);
        setCheck(null);
        report('');
        try {
            setProgress('Uploading...');
            const sent = await connManager.getConnector().sendFile(UPLOAD_NAME, fileBytes, (sentBytes, total) => {
                setProgress(`Uploading ${sentBytes} / ${total} bytes`);
            });
            setProgress('');
            if (!sent) {
                report('Upload failed', true);
                return;
            }
            const resp = await connManager.getConnector().sendRICRESTMsg(
                `devman/typefile/check?file=${encodeURIComponent(uploadPath)}&entries=1`, {}) as TypeFileResp<DevManTypeFileCheck>;
            setCheck(resp);
            if (resp?.rslt !== 'ok')
                report(`Check failed: ${resp?.error ?? 'no response'}`, true);
            else if (resp.valid)
                report(`Uploaded to ${uploadPath} and checked - nothing rejected. Apply to use it (the device restarts).`);
            else
                report(`Uploaded to ${uploadPath} - ${resp.rejected} entr${resp.rejected === 1 ? 'y' : 'ies'} rejected, so it can't be applied`, true);
        } catch (err) {
            setProgress('');
            report(`Upload failed: ${err}`, true);
        } finally {
            setBusy(false);
        }
    };

    const handleApply = async () => {
        if (!window.confirm(`Make ${uploadPath} the device type file and restart the device?`))
            return;
        setBusy(true);
        try {
            const resp = await connManager.getConnector().sendRICRESTMsg(
                `devman/typefile/apply?file=${encodeURIComponent(uploadPath)}`, {}) as TypeFileResp<DevManTypeFileCheck & { restarting?: boolean }>;
            if (resp?.rslt === 'ok') {
                report('Applied - the device is restarting. Reconnect when it is back.');
                setCheck(null);
            } else {
                report(`Not applied: ${resp?.error ?? 'no response'}${resp?.firstError ? ` - ${resp.firstError}` : ''}`, true);
            }
        } catch (err) {
            report(`Apply failed: ${err}`, true);
        } finally {
            setBusy(false);
        }
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
                        <div>{status.file}{status.state ? ` - ${status.state}` : ''}{status.crc ? ` (crc ${status.crc})` : ''}</div>
                        {status.restartRequired && <div className="type-file-warning">Changed on disk - a restart is needed to apply it</div>}
                        {status.firstError && <div className="type-file-warning">{status.firstError}</div>}
                    </>
                ) : (
                    <div>No device type file{status?.file ? ` (${status.file})` : ''}</div>
                )}
            </div>
            <div className="type-file-controls">
                <input type="file" accept=".json,application/json" onChange={handleFileChosen} disabled={busy} />
                <button className="action-button" onClick={handleUploadAndCheck} disabled={busy || !fileBytes}>
                    Upload &amp; Check
                </button>
                <button className="action-button" onClick={handleApply} disabled={busy || !check?.valid}>
                    Apply (restart)
                </button>
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
