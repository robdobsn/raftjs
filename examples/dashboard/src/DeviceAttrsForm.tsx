import React, { useState } from 'react';
import { deviceAttrGetLatestFormatted, DeviceState } from '../../../src/RaftDeviceStates';
import ConnManager from './ConnManager';

const connManager = ConnManager.getInstance();

// Array attributes with more elements than this per sample (e.g. a thermal camera's pixels) start collapsed,
// showing only their element count until expanded
const ARRAY_COLLAPSE_THRESHOLD = 10;

type DeviceAttributesTableProps = {
    deviceKey: string;
    lastUpdated: number;
};

const DeviceAttrsForm: React.FC<DeviceAttributesTableProps> = ({ deviceKey, lastUpdated }) => {
    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);

    // Large arrays the user has expanded (by attribute name)
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const toggleExpanded = (attributeName: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(attributeName)) next.delete(attributeName);
            else next.add(attributeName);
            return next;
        });
    };

    if (!deviceState || Object.keys(deviceState.deviceAttributes).length === 0) {
        return <></>;
    }

    return (
        <div className="device-attrs-form">
            <table>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Value</th>
                        <th>Units</th>
                    </tr>
                </thead>
                <tbody>
                    {Object.entries(deviceState.deviceAttributes)
                        .filter(([attributeName, attributeDetails]) => attributeDetails.visibleForm !== false)
                        .map(([attributeName, attributeDetails]) => {
                            const numElems = attributeDetails.elemsPerSample ?? 1;
                            const collapsible = numElems > ARRAY_COLLAPSE_THRESHOLD;
                            const isExpanded = collapsible && expanded.has(attributeName);
                            const valStr = collapsible && !isExpanded ? '' : deviceAttrGetLatestFormatted(attributeDetails);
                            return (
                                <tr key={attributeName}>
                                    <td>{attributeName}</td>
                                    <td>
                                        {collapsible && (
                                            <button type="button" className="attr-array-toggle" onClick={() => toggleExpanded(attributeName)}
                                                    title={isExpanded ? 'Hide the values' : 'Show the values'}>
                                                {isExpanded ? '\u25BE' : '\u25B8'} {numElems} values
                                            </button>
                                        )}
                                        {valStr}
                                    </td>
                                    <td>{attributeDetails.units}</td>
                                </tr>
                            );
                    })}
                </tbody>
            </table>
        </div>
    );
};

export default DeviceAttrsForm;
