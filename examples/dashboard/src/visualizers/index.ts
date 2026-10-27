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
import VcpCalVisualizer from './VcpCalVisualizer';
import ZoneGridVisualizer from './ZoneGridVisualizer';
import StackLightVisualizer from './StackLightVisualizer';
import DistanceStripVisualizer from './DistanceStripVisualizer';
import TouchStripVisualizer from './TouchStripVisualizer';
import HeartRateVisualizer from './HeartRateVisualizer';
import ColourVisualizer from './ColourVisualizer';
import LightSpectrumVisualizer from './LightSpectrumVisualizer';
import ThermalCameraVisualizer from './ThermalCameraVisualizer';
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
    id: 'lightspectrum',
    placement: 'charts',
    match: (item) => {
        if (item.kind !== 'attribute') return 0;
        // Bands of a spectral light sensor, one bar per band in its wavelength's colour (e.g. AS7341)
        if (item.attribute.vt === 'lightspectrum') return 100;
        return 0;
    },
    component: LightSpectrumVisualizer,
});

VisualizerRegistry.register({
    id: 'colour',
    placement: 'charts',
    match: (item, deviceState) => {
        if (item.kind !== 'attribute') return 0;
        const attr = item.attribute;
        if (attr.vt === 'colour') return 100;
        // Heuristic: one view for a device with red, green and blue attributes, placed on the red one
        const names = new Set((deviceState?.deviceTypeInfo?.resp?.a ?? []).map(a => a.n));
        if (attr.n === 'red' && names.has('green') && names.has('blue')) return 20;
        return 0;
    },
    component: ColourVisualizer,
});

VisualizerRegistry.register({
    id: 'thermal',
    placement: 'charts',
    match: (item, deviceState) => {
        if (item.kind !== 'attribute') return 0;
        const attr = item.attribute;
        if (attr.vt === 'thermal') return 100;
        // Heuristic: the pixel array of a thermal camera (TCAM class, e.g. AMG8833) - ahead of the zone grid
        const isTCAM = deviceState?.deviceTypeInfo?.clas?.some(c => c.toUpperCase() === 'TCAM');
        if (isTCAM && attr.t && getAttrElemsPerSample(attr.t) > 1) return 30;
        return 0;
    },
    component: ThermalCameraVisualizer,
});

VisualizerRegistry.register({
    id: 'zonegrid',
    placement: 'charts',
    match: (item) => {
        if (item.kind !== 'attribute') return 0;
        const attr = item.attribute;
        if (attr.vt === 'zonegrid' || attr.vt === 'heatmap') return 100;
        // Heuristic: array attribute declaring a square "resolution" such as "8x8" (e.g. AMG8833)
        const res = (attr as any).resolution;
        if (typeof res === 'string' && /^\d+x\d+$/.test(res) && attr.t && getAttrElemsPerSample(attr.t) > 1) return 20;
        return 0;
    },
    component: ZoneGridVisualizer,
});

VisualizerRegistry.register({
    id: 'diststrip',
    placement: 'charts',
    match: (item) => {
        if (item.kind !== 'attribute') return 0;
        if (item.attribute.vt === 'diststrip') return 100;
        return 0;
    },
    component: DistanceStripVisualizer,
});

VisualizerRegistry.register({
    id: 'touchstrip',
    placement: 'charts',
    match: (item) => {
        if (item.kind !== 'attribute') return 0;
        if (item.attribute.vt === 'touchstrip') return 100;
        return 0;
    },
    component: TouchStripVisualizer,
});

VisualizerRegistry.register({
    id: 'hrm',
    placement: 'charts',
    match: (item, deviceState) => {
        if (item.kind !== 'attribute') return 0;
        if (item.attribute.vt === 'hrm') return 100;
        // Heuristic: one view for an HRM-class device (e.g. MAX30101), placed on its first attribute
        const typeInfo = deviceState?.deviceTypeInfo;
        if (typeInfo?.clas?.some(c => c.toUpperCase() === 'HRM') && typeInfo.resp?.a?.[0]?.n === item.attribute.n) return 50;
        return 0;
    },
    component: HeartRateVisualizer,
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

VisualizerRegistry.register({
    id: 'stacklight',
    placement: 'actions',
    match: (item) => {
        if (item.kind !== 'action') return 0;
        if (item.action.vt === 'stacklight') return 100;
        // Legacy-style format flag (as LEDPIX)
        if (item.action.f === 'STACKLIGHT') return 10;
        return 0;
    },
    component: StackLightVisualizer,
});

VisualizerRegistry.register({
    id: 'vcpcal',
    placement: 'actions',
    match: (item) => {
        if (item.kind !== 'action') return 0;
        if (item.action.vt === 'vcpcal') return 100;
        return 0;
    },
    component: VcpCalVisualizer,
});

export { VisualizerRegistry } from './VisualizerRegistry';
export type { DeviceVisualizerProps, DeviceVisualizerEntry, PlacedVisualizer } from './VisualizerRegistry';
