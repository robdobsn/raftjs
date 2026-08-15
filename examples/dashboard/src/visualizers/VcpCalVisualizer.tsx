/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// VcpCalVisualizer
// Calibration form for the RoboticalVCP board (action vt: 'vcpcal'). The user enters an
// Excel-style straight-line fit (reading = k*true + c) per channel, measured against the
// board's CURRENTLY ACTIVE calibration; the form computes the new constants, previews
// them, and writes the 36-byte cal block + save command over I2C (WRITE_CAL 0x38 + the
// RSAO save command).
//
// The active constants cannot be read back over the dashboard transport (cmdraw reads
// are not returned), so they are seeded from the firmware's compiled-in defaults,
// remembered per-device in localStorage after each write, and manually editable.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { useEffect, useMemo, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceVisualizerProps } from './VisualizerRegistry';
import { DeviceTypeAction } from '../../../../src/RaftDeviceInfo';
import {
    VCP_CHANNEL_NAMES, VCP_DEFAULT_CAL, VCP_NUM_CHANNELS,
    VcpChannelCal, computeNewChannelCal, packCalBlock, bytesToHex, unpackCalBlock,
} from './vcpCalMath';

const connManager = ConnManager.getInstance();

const RSAO_SAVE_CMD_HEX = 'fe04fefe';

function storageKey(deviceKey: string): string {
    return `vcpcal_current_${deviceKey}`;
}

function loadCurrentCal(deviceKey: string): VcpChannelCal[] {
    try {
        const stored = localStorage.getItem(storageKey(deviceKey));
        if (stored) {
            const parsed = JSON.parse(stored) as VcpChannelCal[];
            if (Array.isArray(parsed) && parsed.length === VCP_NUM_CHANNELS) return parsed;
        }
    } catch { /* fall through to defaults */ }
    return VCP_DEFAULT_CAL.map(c => ({ ...c }));
}

const VcpCalVisualizer: React.FC<DeviceVisualizerProps> = ({ deviceKey, action }) => {
    const [fitK, setFitK] = useState<string[]>(Array(VCP_NUM_CHANNELS).fill('1'));
    const [fitC, setFitC] = useState<string[]>(Array(VCP_NUM_CHANNELS).fill('0'));
    const [currentCal, setCurrentCal] = useState<VcpChannelCal[]>(() => loadCurrentCal(deviceKey));
    const [showCurrent, setShowCurrent] = useState<boolean>(false);
    const [calSource, setCalSource] = useState<string>('assumed (defaults / last written)');
    const [status, setStatus] = useState<string>('');

    // Read the board's cal block via the CONFIG selector (0x12): 16+16+4 bytes
    const readFromBoard = async (): Promise<boolean> => {
        const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
        if (!deviceManager) return false;
        const parts: Uint8Array[] = [];
        for (const [off, len] of [[0x00, 16], [0x10, 16], [0x20, 4]] as const) {
            // CONFIG reads are idempotent, so retry a couple of times if a read
            // misses the firmware's short (20 ms) response window
            let part: Uint8Array | null = null;
            for (let attempt = 0; attempt < 3 && !part; attempt++) {
                part = await deviceManager.cmdRawWriteRead(deviceKey, `12${off.toString(16).padStart(2, '0')}`, len);
            }
            if (!part || part.length !== len) return false;
            parts.push(part);
        }
        const block = new Uint8Array(36);
        block.set(parts[0], 0); block.set(parts[1], 16); block.set(parts[2], 32);
        const unpacked = unpackCalBlock(block);
        if (!unpacked) return false;
        setCurrentCal(unpacked.cals);
        setCalSource(unpacked.calibrated ? 'read from board (calibrated)' : 'read from board (uncalibrated defaults)');
        return true;
    };

    // Try to fetch the real constants on mount; silently keep assumed values if
    // the firmware doesn't support cmdraw read-back
    useEffect(() => {
        readFromBoard();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deviceKey]);

    // Live preview of the computed constants (null row => invalid input)
    const newCal = useMemo(() => {
        return currentCal.map((cur, ch) => {
            const k = parseFloat(fitK[ch]);
            const c = parseFloat(fitC[ch]);
            if (isNaN(k) || isNaN(c)) return null;
            return computeNewChannelCal(cur, { k, c });
        });
    }, [fitK, fitC, currentCal]);

    const allValid = newCal.every(c => c !== null);

    const handleWrite = async () => {
        if (!allValid) return;
        const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
        if (!deviceManager) {
            setStatus('Not connected');
            return;
        }
        const cals = newCal as VcpChannelCal[];
        const writePrefix = action?.w || '3800';   // WRITE_CAL opcode + offset 0
        const blockHex = bytesToHex(packCalBlock(cals));
        // Synthetic write-only actions: sendAction with no 't' sends 'w' verbatim
        const writeAction: DeviceTypeAction = { n: 'vcpcal_write', w: writePrefix + blockHex };
        const saveAction: DeviceTypeAction = { n: 'vcpcal_save', w: RSAO_SAVE_CMD_HEX };
        setStatus('Writing...');
        const wrOk = await deviceManager.sendAction(deviceKey, writeAction, [0]);
        if (!wrOk) {
            setStatus('Cal block write failed');
            return;
        }
        const saveOk = await deviceManager.sendAction(deviceKey, saveAction, [0]);
        if (!saveOk) {
            setStatus('Save command failed');
            return;
        }
        // The written constants are now the board's active cal
        setCurrentCal(cals);
        setCalSource('last written from this browser');
        try { localStorage.setItem(storageKey(deviceKey), JSON.stringify(cals)); } catch { /* non-fatal */ }
        setFitK(Array(VCP_NUM_CHANNELS).fill('1'));
        setFitC(Array(VCP_NUM_CHANNELS).fill('0'));
        setStatus('Calibration written and saved. Re-measure: a new fit should now be ~y=x.');
    };

    const handleResetCurrent = () => {
        const defaults = VCP_DEFAULT_CAL.map(c => ({ ...c }));
        setCurrentCal(defaults);
        try { localStorage.removeItem(storageKey(deviceKey)); } catch { /* non-fatal */ }
    };

    const setCurrentField = (ch: number, field: 'zero' | 'num' | 'den', value: string) => {
        const v = parseInt(value, 10);
        if (isNaN(v)) return;
        setCurrentCal(prev => prev.map((c, i) => (i === ch ? { ...c, [field]: v } : c)));
    };

    return (
        <div className="vcp-cal-visualizer" style={{ maxWidth: 300, fontSize: '0.85em' }}>
            <div style={{ fontSize: '0.8em', marginBottom: 4, whiteSpace: 'normal' }}>
                Apply known test inputs and plot the board's readings (y) against the true
                values (x). Enter the Excel trendline y = kx + c for each channel (c in
                V or A). Leave k=1, c=0 to keep a channel unchanged.
            </div>
            <table style={{ fontSize: '0.9em', borderCollapse: 'collapse' }}>
                <thead>
                    <tr><th>Ch</th><th>k</th><th>c</th>
                        <th style={{ fontSize: '0.8em' }}>→ zero</th>
                        <th style={{ fontSize: '0.8em' }}>→ num/den</th></tr>
                </thead>
                <tbody>
                    {VCP_CHANNEL_NAMES.map((name, ch) => (
                        <tr key={name}>
                            <td>{name}</td>
                            <td>
                                <input type="number" step="any" style={{ width: '4em' }} value={fitK[ch]}
                                    onChange={e => setFitK(prev => prev.map((v, i) => (i === ch ? e.target.value : v)))} />
                            </td>
                            <td>
                                <input type="number" step="any" style={{ width: '4em' }} value={fitC[ch]}
                                    onChange={e => setFitC(prev => prev.map((v, i) => (i === ch ? e.target.value : v)))} />
                            </td>
                            <td style={{ fontSize: '0.8em' }}>{newCal[ch] ? newCal[ch]!.zero : '—'}</td>
                            <td style={{ fontSize: '0.8em' }}>{newCal[ch] ? `${newCal[ch]!.num}/${newCal[ch]!.den}` : '—'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <div style={{ marginTop: 4 }}>
                <button onClick={handleWrite} disabled={!allValid}>Write + Save</button>
                <button style={{ marginLeft: 8 }} onClick={() => setShowCurrent(s => !s)}>
                    {showCurrent ? 'Hide' : 'Edit'} constants directly
                </button>
            </div>
            {showCurrent && (
                <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: '0.75em', whiteSpace: 'normal' }}>
                        On-board constants — source: {calSource}. Use Read to fetch from the
                        board (needs firmware with cmdraw read-back); edit if needed.
                    </div>
                    <table style={{ fontSize: '0.85em' }}>
                        <thead>
                            <tr><th>Ch</th><th>zero</th><th>num</th><th>den</th></tr>
                        </thead>
                        <tbody>
                            {VCP_CHANNEL_NAMES.map((name, ch) => (
                                <tr key={name}>
                                    <td>{name}</td>
                                    <td><input type="number" style={{ width: '4em' }} value={currentCal[ch].zero}
                                        onChange={e => setCurrentField(ch, 'zero', e.target.value)} /></td>
                                    <td><input type="number" style={{ width: '4em' }} value={currentCal[ch].num}
                                        onChange={e => setCurrentField(ch, 'num', e.target.value)} /></td>
                                    <td><input type="number" style={{ width: '4em' }} value={currentCal[ch].den}
                                        onChange={e => setCurrentField(ch, 'den', e.target.value)} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <button onClick={handleResetCurrent}>Reset to firmware defaults</button>
                    <button style={{ marginLeft: 8 }} onClick={async () => {
                        setStatus((await readFromBoard()) ? 'Constants read from board.' : 'Read failed (older firmware without cmdraw read-back?)');
                    }}>Read from board</button>
                </div>
            )}
            {status && <div style={{ marginTop: 4, fontSize: '0.8em', whiteSpace: 'normal' }}>{status}</div>}
        </div>
    );
};

export default VcpCalVisualizer;
