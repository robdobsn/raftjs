import React, { useEffect, useRef, useState } from 'react';
import ConnManager from './ConnManager';
import { DeviceTypeAction } from '../../../src/RaftDeviceInfo';
import DispLEDGrid from './DispLedGrid';

const connManager = ConnManager.getInstance();

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

    useEffect(() => {
        if (!deviceManager) {
            return;
        }
        // Wait a little while inline for the device to be ready
        setTimeout(() => {
            const deviceState = deviceManager.getDeviceState(deviceKey);
            const { deviceTypeInfo } = deviceState;
            const actions: DeviceTypeAction[] = deviceTypeInfo?.actions || [];
            setDeviceActions(actions);
            // Initialize input values
            const initialValues: InputValues = actions.reduce((acc, action) => {
                acc[action.n] =
                    action.d ??
                    (action.r
                        ? action.r.length > 1
                            ? (action.r[1] + action.r[0]) / 2
                            : 0
                        : 0);
                return acc;
            }, {} as InputValues);
            setInputValues(initialValues);
        }, 1000);
    }, [deviceKey]);

    const handleInputChange = (name: string, value: number) => {
        setInputValues((prevValues: any) => ({
            ...prevValues,
            [name]: value,
        }));
    };

    const handleSendAction = (action: DeviceTypeAction, value: number) => {
        // Send action to device
        if (!deviceManager) {
            return;
        }
        deviceManager.sendAction(deviceKey, action, [value]);
    };

    if (deviceActions.length === 0) {
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
                        } else {
                            return (
                                <tr key={action.n}>
                                    <td>{action.n}</td>
                                    <td>
                                        {action.t ? (
                                            <input
                                                type="number"
                                                min={action.r?.[0] ?? 0}
                                                max={action.r?.[1] ?? 100}
                                                value={inputValues[action.n]}
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
                                                    inputValues[action.n]
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
                </tbody>
            </table>
        </div>
    );
};

export default DeviceActionsForm;
