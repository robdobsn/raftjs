/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// Visualizer registration
// Importing this module registers the built-in visualizers with the registry.
// Match priority: explicit vt field in the device type record wins; heuristics are fallbacks.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { VisualizerRegistry } from './VisualizerRegistry';
import SpectrumChart from './SpectrumChart';
import LedGridVisualizer from './LedGridVisualizer';
import { getAttrElemsPerSample } from '../../../../src/RaftDeviceInfo';

VisualizerRegistry.register({
    id: 'spectrum',
    placement: 'charts',
    match: (item) => {
        if (item.kind !== 'attribute') return 0;
        const attr = item.attribute;
        if (attr.vt === 'spectrum') return 100;
        // Heuristic: labelled array attribute defaults to a spectrum display
        if (attr.el && attr.t && getAttrElemsPerSample(attr.t) > 1) return 10;
        return 0;
    },
    component: SpectrumChart,
});

VisualizerRegistry.register({
    id: 'ledgrid',
    placement: 'actions',
    match: (item) => {
        if (item.kind !== 'action') return 0;
        if (item.action.vt === 'ledgrid') return 100;
        // Legacy: LEDPIX format flag
        if (item.action.f === 'LEDPIX') return 10;
        return 0;
    },
    component: LedGridVisualizer,
});

export { VisualizerRegistry } from './VisualizerRegistry';
export type { DeviceVisualizerProps, DeviceVisualizerEntry, PlacedVisualizer } from './VisualizerRegistry';
