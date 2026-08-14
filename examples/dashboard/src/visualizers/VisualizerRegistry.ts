/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// VisualizerRegistry
// Registry of specialized device data visualizers. Visualizers self-register with a match
// function; selection is driven by device-type metadata (vt field or heuristics), not
// hardcoded conditionals in forms/panels.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React from 'react';
import { DeviceState } from '../../../../src/RaftDeviceStates';
import { DeviceTypeAttribute, DeviceTypeAction } from '../../../../src/RaftDeviceInfo';

export type VisualizerPlacement = 'actions' | 'charts';

export interface DeviceVisualizerProps {
    deviceKey: string;
    attribute?: DeviceTypeAttribute;
    action?: DeviceTypeAction;
    lastUpdated?: number;
}

export type VisualizerMatchItem =
    | { kind: 'attribute'; attribute: DeviceTypeAttribute }
    | { kind: 'action'; action: DeviceTypeAction };

export interface DeviceVisualizerEntry {
    id: string;                                 // e.g. 'spectrum', 'ledgrid'
    placement: VisualizerPlacement;             // left actions panel vs right chart panel
    // Return a score > 0 to claim the item; highest score wins
    match(item: VisualizerMatchItem, deviceState?: DeviceState): number;
    component: React.ComponentType<DeviceVisualizerProps>;
}

export interface PlacedVisualizer {
    entry: DeviceVisualizerEntry;
    attribute?: DeviceTypeAttribute;
    action?: DeviceTypeAction;
    key: string;
}

class VisualizerRegistryImpl {
    private _entries: DeviceVisualizerEntry[] = [];

    register(entry: DeviceVisualizerEntry): void {
        if (this._entries.some(e => e.id === entry.id)) return;
        this._entries.push(entry);
    }

    // Best-scoring entry for a single item, optionally restricted to a placement
    matchItem(item: VisualizerMatchItem, deviceState?: DeviceState, placement?: VisualizerPlacement): DeviceVisualizerEntry | null {
        let best: DeviceVisualizerEntry | null = null;
        let bestScore = 0;
        for (const entry of this._entries) {
            if (placement && entry.placement !== placement) continue;
            const score = entry.match(item, deviceState);
            if (score > bestScore) {
                best = entry;
                bestScore = score;
            }
        }
        return best;
    }

    // All visualizers for a device at the given placement (attributes and actions)
    selectForDevice(deviceState: DeviceState, placement: VisualizerPlacement): PlacedVisualizer[] {
        const placed: PlacedVisualizer[] = [];
        const attrs = deviceState.deviceTypeInfo?.resp?.a ?? [];
        for (const attribute of attrs) {
            const entry = this.matchItem({ kind: 'attribute', attribute }, deviceState, placement);
            if (entry) {
                placed.push({ entry, attribute, key: `${entry.id}_attr_${attribute.n}` });
            }
        }
        const actions = deviceState.deviceTypeInfo?.actions ?? [];
        for (const action of actions) {
            const entry = this.matchItem({ kind: 'action', action }, deviceState, placement);
            if (entry) {
                placed.push({ entry, action, key: `${entry.id}_action_${action.n}` });
            }
        }
        return placed;
    }
}

export const VisualizerRegistry = new VisualizerRegistryImpl();
