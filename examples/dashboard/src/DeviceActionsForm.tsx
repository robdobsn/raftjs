import React, { useEffect, useRef, useState } from 'react';
import ConnManager from './ConnManager';
import { DeviceTypeAction, ActionMapEntry } from '../../../src/RaftDeviceInfo';
import DispLEDGrid from './DispLedGrid';

const connManager = ConnManager.getInstance();

// Generic sample rate options for devices without _conf.rate
const GENERIC_SAMPLE_RATES = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.01, 0.001];

// Find the closest value in an array to a target
function findClosest(arr: number[], target: number): number {
    return arr.reduce((prev, curr) =>
        Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
    );
}

function getDefaultActionValue(action: DeviceTypeAction): number {
    if (action.d !== undefined) {
        return action.d;
    }
    if (action.map) {
        const firstMapKey = Object.keys(action.map).sort((a, b) => parseFloat(a) - parseFloat(b))[0];
        return firstMapKey !== undefined ? parseFloat(firstMapKey) : 0;
    }
    if (action.r && action.r.length > 1) {
        return (action.r[1] + action.r[0]) / 2;
    }
    return 0;
}

type DeviceActionsTableProps = {
    deviceKey: string;
};

interface InputValues {
    [key: string]: number;
}

const DeviceActionsForm: React.FC<DeviceActionsTableProps> = ({ deviceKey }: DeviceActionsTableProps) => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const [deviceActions, setDeviceActions] = useState<DeviceTypeAction[]>([]);
    const [inputValues, setInputValues] = useState<InputValues>({});
    const [actionStatus, setActionStatus] = useState<string>('');
    const [genericRateHz, setGenericRateHz] = useState<number>(10);
    const [isBusDevice, setIsBusDevice] = useState<boolean>(false);
    const [hasConfRate, setHasConfRate] = useState<boolean>(false);

    useEffect(() => {
        if (!deviceManager) {
            return;
        }
        // Wait a little while inline for the device to be ready
        setTimeout(async () => {
            const deviceState = deviceManager.getDeviceState(deviceKey);
            const { deviceTypeInfo } = deviceState;
            const actions: DeviceTypeAction[] = deviceTypeInfo?.actions || [];
            setDeviceActions(actions);
            // Check if this is a bus device (has a valid busName)
            const busName = deviceState?.busName ?? '';
            const isBus = busName !== '' && busName !== '0';
            setIsBusDevice(isBus);
            // Check if device has _conf.rate action
            const confRateAction = actions.find(a => a.n === '_conf.rate');
            setHasConfRate(!!confRateAction);
            // Initialize input values with defaults
            const initialValues: InputValues = actions.reduce((acc, action) => {
                acc[action.n] = getDefaultActionValue(action);
                return acc;
            }, {} as InputValues);

            // Query current poll config from firmware to initialize rate dropdowns
            if (isBus && deviceState?.deviceAddress) {
                try {
                    const cmd = `devman/devconfig?bus=${busName}&addr=${deviceState.deviceAddress}`;
                    const resp = await connManager.getConnector().sendRICRESTMsg(cmd, {}) as any;
                    if (resp?.rslt === 'ok' && resp.pollIntervalUs > 0) {
                        const currentRateHz = 1000000 / resp.pollIntervalUs;
                        if (confRateAction?.map) {
                            // For _conf.rate: find the map key whose interval and numSamples
                            // best match the current config (both i and s needed to disambiguate
                            // e.g. 52Hz and 104Hz both use i=50000 but differ in s)
                            let bestKey = String(confRateAction.d ?? '');
                            let bestDist = Infinity;
                            for (const [key, entry] of Object.entries(confRateAction.map)) {
                                const mapEntry = entry as ActionMapEntry;
                                if (mapEntry.i !== undefined) {
                                    let dist = Math.abs(mapEntry.i - resp.pollIntervalUs);
                                    // Add penalty for numSamples mismatch to disambiguate entries with same interval
                                    if (mapEntry.s !== undefined && resp.numSamples !== undefined) {
                                        dist += Math.abs(mapEntry.s - resp.numSamples) * 1000000;
                                    }
                                    if (dist < bestDist) {
                                        bestDist = dist;
                                        bestKey = key;
                                    }
                                }
                            }
                            if (bestKey) {
                                initialValues['_conf.rate'] = parseFloat(bestKey);
                            }
                        } else {
                            // For generic rate dropdown: find closest option
                            setGenericRateHz(findClosest(GENERIC_SAMPLE_RATES, currentRateHz));
                        }
                    }
                } catch (err) {
                    // Ignore query errors — keep defaults
                }
            }

            setInputValues(initialValues);
        }, 1000);
    }, [deviceKey]);

    const handleInputChange = (name: string, value: number) => {
        setInputValues((prevValues: any) => ({
            ...prevValues,
            [name]: value,
        }));
    };

    const handleSendAction = async (action: DeviceTypeAction, value: number) => {
        // Send action to device
        if (!deviceManager) {
            return;
        }
        // For _conf.rate actions, use setSampleRate for coordinated polling config
        if (action.n === '_conf.rate' && action.map) {
            setActionStatus('Setting sample rate...');
            const result = await deviceManager.setSampleRate(deviceKey, value);
            if (result.ok) {
                setActionStatus(`Rate: ${result.actualRateHz} Hz, poll: ${result.intervalUs} µs, buf: ${result.numSamples}`);
            } else {
                setActionStatus(`Error: ${result.error}`);
            }
            setTimeout(() => setActionStatus(''), 5000);
        } else {
            deviceManager.sendAction(deviceKey, action, [value]);
        }
    };

    const handleGenericRateSend = async () => {
        if (!deviceManager) {
            return;
        }
        setActionStatus('Setting sample rate...');
        const result = await deviceManager.setSampleRate(deviceKey, genericRateHz);
        if (result.ok) {
            setActionStatus(`Rate: ${result.actualRateHz} Hz, poll: ${result.intervalUs} µs, buf: ${result.numSamples}`);
        } else {
            setActionStatus(`Error: ${result.error}`);
        }
        setTimeout(() => setActionStatus(''), 5000);
    };

    // Show generic rate control for bus devices without _conf.rate
    const showGenericRate = isBusDevice && !hasConfRate;

    if (deviceActions.length === 0 && !showGenericRate) {
        return <></>;
    }

    return (
        <div className="device-actions-form">
            <table>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Value</th>
                        <th>Send</th>
                    </tr>
                </thead>
                <tbody>
                    {deviceActions.map((action) => {
                        if (action.f === "LEDPIX") {
                            return (
                                <tr key={action.n}>
                                    <td>{action.n}</td>
                                    <td colSpan={2}>
                                        <DispLEDGrid
                                            rows={action.NY ?? 1}
                                            cols={action.NX ?? 1}
                                            deviceKey={deviceKey}
                                            deviceAction={action}
                                        />
                                    </td>
                                </tr>
                            );
                        } else if (action.map) {
                            const mapKeys = Object.keys(action.map).sort((a, b) => parseFloat(a) - parseFloat(b));
                            // Use "Rate Hz" label for _conf.rate actions
                            const actionLabel = action.n === '_conf.rate' ? 'Rate Hz' : (action.desc ?? action.n);
                            const actionValue = inputValues[action.n] ?? getDefaultActionValue(action);
                            return (
                                <tr key={action.n}>
                                    <td>{actionLabel}</td>
                                    <td>
                                        <select
                                            value={actionValue}
                                            onChange={(e) =>
                                                handleInputChange(
                                                    action.n,
                                                    parseFloat(e.target.value)
                                                )
                                            }
                                        >
                                            {mapKeys.map((key) => (
                                                <option key={key} value={parseFloat(key)}>
                                                    {key}
                                                </option>
                                            ))}
                                        </select>
                                    </td>
                                    <td>
                                        <button
                                            onClick={() =>
                                                handleSendAction(
                                                    action,
                                                    actionValue
                                                )
                                            }
                                        >
                                            Send
                                        </button>
                                    </td>
                                </tr>
                            );
                        } else {
                            const actionValue = inputValues[action.n] ?? getDefaultActionValue(action);
                            return (
                                <tr key={action.n}>
                                    <td>{action.n}</td>
                                    <td>
                                        {action.t ? (
                                            <input
                                                type="number"
                                                min={action.r?.[0] ?? 0}
                                                max={action.r?.[1] ?? 100}
                                                value={actionValue}
                                                onChange={(e) =>
                                                    handleInputChange(
                                                        action.n,
                                                        parseInt(e.target.value, 10)
                                                    )
                                                }
                                            />
                                        ) : null}
                                    </td>
                                    <td>
                                        <button
                                            onClick={() =>
                                                handleSendAction(
                                                    action,
                                                    actionValue
                                                )
                                            }
                                        >
                                            Send
                                        </button>
                                    </td>
                                </tr>
                            );
                        }
                    })}
                    {showGenericRate && (
                        <tr key="__generic_rate">
                            <td>Rate Hz</td>
                            <td>
                                <select
                                    value={genericRateHz}
                                    onChange={(e) => setGenericRateHz(parseFloat(e.target.value))}
                                >
                                    {GENERIC_SAMPLE_RATES.map((rate) => (
                                        <option key={rate} value={rate}>
                                            {rate >= 1 ? `${rate} Hz` : `${rate} Hz`}
                                        </option>
                                    ))}
                                </select>
                            </td>
                            <td>
                                <button onClick={handleGenericRateSend}>Send</button>
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
            {actionStatus && <div className="action-status">{actionStatus}</div>}
        </div>
    );
};

export default DeviceActionsForm;
