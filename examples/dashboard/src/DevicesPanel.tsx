// Component which uses the DeviceList component to display the list of devices

import React, { useEffect, useRef, useState } from 'react';
// import { DeviceAttributeState, DevicesState, DeviceState } from "../../../src/main";
// import { DeviceManager } from './DeviceManager';
// import DeviceScreen from './DeviceScreen';
import './styles.css';
import ConnManager from "./ConnManager";
import { DeviceAttributeState, DevicesState, DeviceState } from '../../../src/RaftDeviceStates';
import DevicePanel from './DevicePanel';

const connManager = ConnManager.getInstance();

// Device data callbacks fire once per attribute per incoming publish frame (tens of times a
// second, more for FIFO devices). Re-rendering on every callback runs React synchronously inside
// the BLE 'message' handler and floods the main thread. Coalesce them into at most one re-render
// per REFRESH_INTERVAL_MS, deferred out of the message handler. Charts have their own 500ms timer,
// so this only paces the live value display and remains visually smooth.
const REFRESH_INTERVAL_MS = 150;

export class DevicesPanelProps {
    constructor(
    ) { }
}

export default function DevicesPanel(props: DevicesPanelProps) {
    const [lastUpdated, setLastUpdated] = useState<number>(0);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
        if (!deviceManager) {
            return;
        }

        // Trailing throttle: schedule a single re-render shortly after activity, coalescing any
        // further callbacks that arrive within the window. Running via setTimeout also moves the
        // state update (and render) out of the synchronous message handler.
        const scheduleRefresh = () => {
            if (refreshTimerRef.current !== null) {
                return;
            }
            refreshTimerRef.current = setTimeout(() => {
                refreshTimerRef.current = null;
                setLastUpdated(Date.now());
            }, REFRESH_INTERVAL_MS);
        };

        const onNewDevice = (deviceKey: string, newDeviceState: DeviceState) => {
            scheduleRefresh();
        };
        deviceManager.addNewDeviceCallback(onNewDevice);

        const onNewAttribute = (deviceKey: string, attribute: DeviceAttributeState) => {
            scheduleRefresh();
        }
        deviceManager.addNewAttributeCallback(onNewAttribute);

        const onNewAttributeData = (deviceKey: string, attribute: DeviceAttributeState) => {
            scheduleRefresh();
        }
        deviceManager.addAttributeDataCallback(onNewAttributeData);

        const onDeviceRemoved = (deviceKey: string, state: DeviceState) => {
            scheduleRefresh();
        };
        deviceManager.addDeviceRemovedCallback(onDeviceRemoved);

        return () => {
            deviceManager.removeNewDeviceCallback(onNewDevice);
            deviceManager.removeNewAttributeCallback(onNewAttribute);
            deviceManager.removeAttributeDataCallback(onNewAttributeData);
            deviceManager.removeDeviceRemovedCallback(onDeviceRemoved);
            if (refreshTimerRef.current !== null) {
                clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }
        };
    }, []);

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    let devicesState: DevicesState = {};
    if (deviceManager) 
        devicesState = deviceManager.getDevicesState();
    
    return (
        <div className="devices-container">
        {Object.entries(devicesState).filter(([key, _]) => key !== 'getDeviceKey').map(([deviceKey, data]) => (
            <DevicePanel key={deviceKey} deviceKey={deviceKey} lastUpdated={lastUpdated} />
        ))}
      </div>
    );
}
