import React, { useEffect, useRef, useState } from 'react';
import './styles.css';
import { DeviceState, DeviceOnlineState } from '../../../src/RaftDeviceStates';
import DeviceAttrsForm from './DeviceAttrsForm';
import DeviceActionsForm from './DeviceActionsForm';
import DeviceLineChart from './DeviceLineChart';
import DeviceStatsPanel from './DeviceStatsPanel';
import ConnManager from './ConnManager';
import SettingsManager from './SettingsManager';
import { VisualizerRegistry } from './visualizers';
import { computeTimelineChartGroups } from './chartGrouping';
import { getLeftWidthPx, setLeftWidthPx, subscribeLeftWidth, defaultLeftWidthPx, clampLeftWidthPx } from './panelSplit';

const connManager = ConnManager.getInstance();

export interface DevicePanelProps {
    deviceKey: string;
    lastUpdated: number;
}

const DevicePanel = ({ deviceKey, lastUpdated }: DevicePanelProps) => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);

    // Gray out the device panel if the device is offline
    const offlineClass = deviceState?.onlineState === DeviceOnlineState.Online ? '' : 'offline';

    const [timedChartUpdate, setTimedChartUpdate] = useState<number>(0);
    const [menuOpen, setMenuOpen] = useState<boolean>(false);
    const [showPollRateDialog, setShowPollRateDialog] = useState<boolean>(false);
    const [pollRateInput, setPollRateInput] = useState<string>('');
    const [pollRateStatus, setPollRateStatus] = useState<string>('');
    const [showStats, setShowStats] = useState<boolean>(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Left column width (shared by all device panels - see panelSplit), so the charts don't move as values change
    const blockDataRef = useRef<HTMLDivElement>(null);
    const [leftWidthPx, setLeftWidthState] = useState<number | null>(getLeftWidthPx());
    const splitDragRef = useRef<{ startX: number; startWidthPx: number } | null>(null);
    useEffect(() => subscribeLeftWidth(setLeftWidthState), []);

    const settingsManager = SettingsManager.getInstance();
    const [showCharts, setShowCharts] = useState(
       settingsManager.getSetting('showCharts')
    );

    // First panel shown with charts sets the width: a third of the panel
    useEffect(() => {
        if (showCharts && (getLeftWidthPx() === null) && blockDataRef.current) {
            setLeftWidthPx(defaultLeftWidthPx(blockDataRef.current.clientWidth));
        }
    }, [showCharts]);
    const panelWidthPx = () => blockDataRef.current?.clientWidth ?? window.innerWidth;
    const handleSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        splitDragRef.current = { startX: e.clientX, startWidthPx: leftWidthPx ?? defaultLeftWidthPx(panelWidthPx()) };
    };
    const handleSplitPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = splitDragRef.current;
        if (!drag) return;
        setLeftWidthPx(clampLeftWidthPx(drag.startWidthPx + e.clientX - drag.startX, panelWidthPx()));
    };
    const handleSplitPointerUp = () => {
        splitDragRef.current = null;
    };

    // Combine the timeline charts into one, rather than splitting them by units - remembered per device type
    const chartTypeKey = deviceState?.deviceTypeInfo?.type ?? deviceState?.deviceTypeInfo?.name ?? deviceKey;
    const [combineCharts, setCombineCharts] = useState<boolean>(
        settingsManager.getSetting('combinedChartTypes').includes(chartTypeKey)
    );
    useEffect(() => {
        setCombineCharts(settingsManager.getSetting('combinedChartTypes').includes(chartTypeKey));
    }, [chartTypeKey]);
    const handleCombineChartsChange = (combine: boolean) => {
        const types = settingsManager.getSetting('combinedChartTypes').filter((t) => t !== chartTypeKey);
        settingsManager.setSetting('combinedChartTypes', combine ? [...types, chartTypeKey] : types);
        setCombineCharts(combine);
    };
    // The option is only offered when the charts would otherwise be split
    const chartsWouldSplit = deviceState ? computeTimelineChartGroups(deviceState).length > 1 : false;
    
    useEffect(() => {
        const updateChart = () => {
            setTimedChartUpdate(Date.now());
        };
        // Stagger the start with a random phase so that multiple device panels do not all refresh
        // their charts on the same 500ms boundary (which produces large synchronized render bursts
        // that show up as long scheduler tasks). Each panel keeps a 500ms period but a different phase.
        const initialDelayMs = Math.random() * 500;
        let updateTimer: ReturnType<typeof setInterval> | null = null;
        const startTimer = setTimeout(() => {
            updateChart();
            updateTimer = setInterval(updateChart, 500);
        }, initialDelayMs);
        return () => {
            clearTimeout(startTimer);
            if (updateTimer) clearInterval(updateTimer);
        };
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

    const deviceName = deviceState?.displayName ?? deviceState?.deviceTypeInfo?.name ?? "";
    let headerText = `Device ${deviceName}`;
    // Add the device type (e.g. SCD30 or STCC4) so devices with the same type display name can be told apart
    const deviceType = deviceState?.deviceTypeInfo?.type;
    if (deviceType && !deviceName.includes(deviceType)) {
        headerText += ` ${deviceType}`;
    }
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
    if (deviceState?.deviceTypeInfo?.role?.toLowerCase() === "system") {
        headerText += " System";
    }
    if (deviceState?.onlineState !== DeviceOnlineState.Online) {
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
                        {(chartsWouldSplit || combineCharts) && (
                            <div className="menu-item always-enabled menu-item-toggle">
                                <label className="menu-toggle">
                                    <input
                                        type="checkbox"
                                        checked={combineCharts}
                                        onChange={(e) => handleCombineChartsChange(e.target.checked)}
                                    />
                                    <span>Combine Charts</span>
                                </label>
                            </div>
                        )}
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
            <div className={`device-block-data`} ref={blockDataRef}>
                <div className="device-attrs-and-actions"
                     style={(showCharts && leftWidthPx !== null)
                        ? { flex: `0 0 ${Math.min(leftWidthPx, Math.max(0, panelWidthPx() - 60))}px`, minWidth: 0 }
                        : undefined}>
                    <DeviceAttrsForm deviceKey={deviceKey} lastUpdated={lastUpdated} />
                    <DeviceActionsForm deviceKey={deviceKey} />
                </div>
                {showCharts && (
                    <div className="device-panel-splitter"
                         title="Drag to change the width (double-click: back to a third)"
                         onPointerDown={handleSplitPointerDown}
                         onPointerMove={handleSplitPointerMove}
                         onPointerUp={handleSplitPointerUp}
                         onPointerCancel={handleSplitPointerUp}
                         onDoubleClick={() => setLeftWidthPx(defaultLeftWidthPx(panelWidthPx()))} />
                )}
                {showStats && (
                    <DeviceStatsPanel deviceKey={deviceKey} lastUpdated={timedChartUpdate} />
                )}
                {showCharts && (
                    <div className="device-charts-panel">
                        {(deviceState ? VisualizerRegistry.selectForDevice(deviceState, 'charts') : []).map((pv) => {
                            const Viz = pv.entry.component;
                            return <Viz key={pv.key} deviceKey={deviceKey} attribute={pv.attribute} action={pv.action} lastUpdated={timedChartUpdate} />;
                        })}
                        {(deviceState ? computeTimelineChartGroups(deviceState, combineCharts) : []).map((group) => (
                            <DeviceLineChart key={group.id} deviceKey={deviceKey} lastUpdated={timedChartUpdate} attrNames={group.attrNames} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default DevicePanel;
