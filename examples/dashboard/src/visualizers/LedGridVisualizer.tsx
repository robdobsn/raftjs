/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// LedGridVisualizer
// Adapts the existing DispLEDGrid component to the visualizer registry interface.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React from 'react';
import DispLEDGrid from '../DispLedGrid';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const LedGridVisualizer: React.FC<DeviceVisualizerProps> = ({ deviceKey, action }) => {
    if (!action) {
        return null;
    }
    return (
        <DispLEDGrid
            rows={action.NY ?? 1}
            cols={action.NX ?? 1}
            deviceKey={deviceKey}
            deviceAction={action}
        />
    );
};

export default LedGridVisualizer;
