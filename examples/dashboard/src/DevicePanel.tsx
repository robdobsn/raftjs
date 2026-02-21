import React, { useEffect, useRef, useState } from 'react';
import './styles.css';
import { DeviceState } from '../../../src/RaftDeviceStates';
import DeviceAttrsForm from './DeviceAttrsForm';
import DeviceActionsForm from './DeviceActionsForm';
import DeviceLineChart from './DeviceLineChart';
import DeviceStatsPanel from './DeviceStatsPanel';
import ConnManager from './ConnManager';
import SettingsManager from './SettingsManager';

const connManager = ConnManager.getInstance();

export interface DevicePanelProps {
    deviceKey: string;
    lastUpdated: number;
}

const DevicePanel = ({ deviceKey, lastUpdated }: DevicePanelProps) => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);

    // Gray out the device panel if the device is offline
    const offlineClass = deviceState?.isOnline ? '' : 'offline';

    const [timedChartUpdate, setTimedChartUpdate] = useState<number>(0);
    const [menuOpen, setMenuOpen] = useState<boolean>(false);
    const [showPollRateDialog, setShowPollRateDialog] = useState<boolean>(false);
    const [pollRateInput, setPollRateInput] = useState<string>('');
    const [pollRateStatus, setPollRateStatus] = useState<string>('');
    const [showStats, setShowStats] = useState<boolean>(false);
    const menuRef = useRef<HTMLDivElement>(null);

    const settingsManager = SettingsManager.getInstance();
    const [showCharts, setShowCharts] = useState(
       settingsManager.getSetting('showCharts')
    );
    
    useEffect(() => {
        const startTime = Date.now();
        const updateChart = () => {
            setTimedChartUpdate(Date.now());
        };
        const updateTimer = setInterval(updateChart, 500);
        return () => clearInterval(updateTimer);
    }, []);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const handleCopyToClipboard = () => {
        if (!deviceState) {
            return;
        }
        const headers = ["Time (s)"];
        const rows: string[][] = [];
    
        const timestampsUs = deviceState.deviceTimeline.timestampsUs;
        const attributes = deviceState.deviceAttributes;
    
        // Collect headers and initialize rows with timestamps
        Object.keys(attributes).forEach(attrName => {
            headers.push(attrName);
        });
    
        timestampsUs.forEach((timestampUs, index) => {
            const row: string[] = [(timestampUs / 1000000.0).toString()];
            Object.keys(attributes).forEach(attrName => {
                const values = attributes[attrName].values;
                row.push(values[index]?.toString() || "");
            });
            rows.push(row);
        });
    
        // Create a tab-separated string
        const csvContent = [headers.join("\t"), ...rows.map(row => row.join("\t"))].join("\n");
    
        // Try using navigator.clipboard.writeText, with a fallback to document.execCommand
        if (navigator.clipboard) {
            navigator.clipboard.writeText(csvContent).then(() => {
                console.log("Device values copied to clipboard");
            }).catch(err => {
                console.warn('Failed to copy: ', err);
                fallbackCopyTextToClipboard(csvContent);
            });
        } else {
            fallbackCopyTextToClipboard(csvContent);
        }
        setMenuOpen(false);
    };
    
    const handleSetPollRateClick = () => {
        setMenuOpen(false);
        setPollRateInput('');
        setPollRateStatus('');
        setShowPollRateDialog(true);
    };

    const handlePollRateSubmit = () => {
        const rateHz = parseFloat(pollRateInput);
        if (isNaN(rateHz) || rateHz <= 0) {
            setPollRateStatus('Invalid rate — enter a positive number');
            return;
        }
        const intervalUs = Math.round(1000000 / rateHz);
        const busName = deviceState?.busName ?? '0';
        const addr = deviceState?.deviceAddress ?? '0';
        const cmd = `devman/devconfig?bus=${busName}&addr=${addr}&intervalUs=${intervalUs}`;
        setPollRateStatus('Sending...');
        connManager.getConnector().sendRICRESTMsg(cmd, {}).then((response: object) => {
            console.log(`Poll rate set: ${rateHz} Hz (${intervalUs} us)`, response);
            setPollRateStatus(`Set to ${rateHz} Hz (${intervalUs} µs)`);
            setTimeout(() => setShowPollRateDialog(false), 1500);
        }).catch((error: unknown) => {
            console.warn('Error setting poll rate', error);
            setPollRateStatus('Error setting poll rate');
        });
    };

    const fallbackCopyTextToClipboard = (text: string) => {
        const textArea = document.createElement("textarea");
        textArea.value = text;
    
        // Avoid scrolling to bottom
        textArea.style.top = "0";
        textArea.style.left = "0";
        textArea.style.position = "fixed";
    
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
    
        try {
            document.execCommand("copy");
            // alert("Device values copied to clipboard!");
        } catch (err) {
            console.warn('Fallback: Oops, unable to copy', err);
            alert("Failed to copy device values to clipboard");
        }
    
        document.body.removeChild(textArea);
    };

    let headerText = `Device ${deviceState?.deviceTypeInfo?.name}`;
    let bracketsAdded = false;
    if ((deviceState?.busName !== undefined) && (deviceState?.busName !== "") && (deviceState?.busName !== "0")) {
        headerText += ` (Bus ${deviceState?.busName}`;
        bracketsAdded = true;
    }
    if ((deviceState?.deviceAddress !== undefined) && (deviceState?.deviceAddress !== "") && (deviceState?.deviceAddress !== "0")) {
        // See if we can identify I2C addresses - should start with two bytes of 0s and then have a byte which is slot and a byte which is address
        const addrInt = parseInt(deviceState?.deviceAddress, 16);
        if (addrInt < 65536) {
            const slot = addrInt >> 8;
            if (slot === 0)
                headerText += ` Main Bus`;
            else
                headerText += ` Slot ${slot}`;
            const address = ("00" + (addrInt & 0xFF).toString(16)).slice(-2);
            headerText += ` Addr 0x${address}`;
        } else {
            headerText += ` Addr ${deviceState?.deviceAddress}`;
        }
    }
    if (bracketsAdded) {
        headerText += `)`;
    }
    if (!deviceState?.isOnline) {
        headerText += " (Offline)";
    }

    return (
        <div className={`device-panel ${offlineClass}`}>
            <div className="device-block-heading">
                <div className="device-block-heading-text">{headerText}</div>
                <div className="menu-icon always-enabled" onClick={() => setMenuOpen(!menuOpen)}>☰</div>
                {menuOpen && (
                    <div className="dropdown-menu" ref={menuRef}>
                        <div className="menu-item always-enabled" onClick={handleCopyToClipboard}>Copy Values to Clipboard</div>
                        <div className="menu-item always-enabled" onClick={handleSetPollRateClick}>Set Poll Rate</div>
                        <div className="menu-item always-enabled menu-item-toggle">
                            <label className="menu-toggle">
                                <input
                                    type="checkbox"
                                    checked={showStats}
                                    onChange={(e) => setShowStats(e.target.checked)}
                                />
                                <span>Show Stats</span>
                            </label>
                        </div>
                    </div>
                )}
            </div>
            {showPollRateDialog && (
                <div className="poll-rate-dialog-overlay" onClick={() => setShowPollRateDialog(false)}>
                    <div className="poll-rate-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="poll-rate-dialog-title">Set Poll Rate</div>
                        <div className="poll-rate-dialog-row">
                            <input
                                className="poll-rate-input"
                                type="number"
                                min="0.001"
                                step="any"
                                placeholder="Rate (Hz)"
                                value={pollRateInput}
                                onChange={(e) => setPollRateInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handlePollRateSubmit(); if (e.key === 'Escape') setShowPollRateDialog(false); }}
                                autoFocus
                            />
                            <span className="poll-rate-unit">Hz</span>
                        </div>
                        {pollRateInput && !isNaN(parseFloat(pollRateInput)) && parseFloat(pollRateInput) > 0 && (
                            <div className="poll-rate-preview">{Math.round(1000000 / parseFloat(pollRateInput))} µs interval</div>
                        )}
                        {pollRateStatus && <div className="poll-rate-status">{pollRateStatus}</div>}
                        <div className="poll-rate-dialog-buttons">
                            <button className="poll-rate-btn poll-rate-btn-set" onClick={handlePollRateSubmit}>Set</button>
                            <button className="poll-rate-btn poll-rate-btn-cancel" onClick={() => setShowPollRateDialog(false)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}
            <div className={`device-block-data`}>
                <div className="device-attrs-and-actions">
                    <DeviceAttrsForm deviceKey={deviceKey} lastUpdated={lastUpdated} />
                    <DeviceActionsForm deviceKey={deviceKey} />
                </div>
                {showStats && (
                    <DeviceStatsPanel deviceKey={deviceKey} lastUpdated={timedChartUpdate} />
                )}
                {showCharts &&
                    <DeviceLineChart deviceKey={deviceKey} lastUpdated={timedChartUpdate} />
                }
            </div>
        </div>
    );
};

export default DevicePanel;
