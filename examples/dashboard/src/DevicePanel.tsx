import React, { useEffect, useRef, useState } from 'react';
import './styles.css';
import { DeviceState } from '../../../src/RaftDeviceStates';
import DeviceAttrsForm from './DeviceAttrsForm';
import DeviceActionsForm from './DeviceActionsForm';
import DeviceLineChart from './DeviceLineChart';
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
    if ((deviceState?.deviceAddress !== undefined) && (deviceState?.deviceAddress !== "") && (deviceState?.deviceAddress !== "0")) {
        // See if we can identify I2C addresses - should start with two bytes of 0s and then have a byte which is slot and a byte which is address
        const addrInt = parseInt(deviceState?.deviceAddress, 10);
        if (addrInt < 65536) {
            const slot = addrInt >> 8;
            const address = ("00" + (addrInt & 0xFF).toString(16)).slice(-2);
            headerText += ` I2C Address 0x${address}`;
            if (slot === 0)
                headerText += ` (Main Bus)`;
            else
                headerText += ` (Slot ${slot})`;
        } else {
            headerText += ` Address ${deviceState?.deviceAddress}`;
        }
    }
    if ((deviceState?.busName !== undefined) && (deviceState?.busName !== "") && (deviceState?.busName !== "0")) {
        headerText += ` Bus ${deviceState?.busName}`;
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
                    </div>
                )}
            </div>
            <div className={`device-block-data`}>
                <div className="device-attrs-and-actions">
                    <DeviceAttrsForm deviceKey={deviceKey} lastUpdated={lastUpdated} />
                    <DeviceActionsForm deviceKey={deviceKey} />
                </div>
                {showCharts &&
                    <DeviceLineChart deviceKey={deviceKey} lastUpdated={timedChartUpdate} />
                }
            </div>
        </div>
    );
};

export default DevicePanel;
