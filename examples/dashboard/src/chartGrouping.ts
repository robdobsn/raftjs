/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// chartGrouping
// Splits a device's timeline-chartable attributes into chart groups. Attributes with an
// explicit visual group (schema vg field) always group together; otherwise, when a device
// has many traces, attributes are auto-grouped by their value units.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DeviceState } from '../../../src/RaftDeviceStates';

// Above this many traces, a device's timeline chart is split into per-group charts
const MAX_TRACES_ON_SINGLE_CHART = 6;

export interface TimelineChartGroup {
    id: string;
    attrNames: string[];
}

export function computeTimelineChartGroups(deviceState: DeviceState): TimelineChartGroup[] {
    // Attributes eligible for timeline charting (mirrors DeviceLineChart's filter)
    const eligible = Object.entries(deviceState.deviceAttributes)
        .filter(([, attr]) => {
            if (attr.visibleSeries === false) return false;
            if ((attr.elemsPerSample ?? 1) > 1) return false;
            if (attr.values.length > 0 && typeof attr.values[attr.values.length - 1] === 'string') return false;
            return true;
        });

    const anyExplicitGroups = eligible.some(([, attr]) => attr.visualGroup);
    if (!anyExplicitGroups && eligible.length <= MAX_TRACES_ON_SINGLE_CHART) {
        return [{ id: 'all', attrNames: eligible.map(([name]) => name) }];
    }

    // Group by explicit vg, falling back to units
    const groups = new Map<string, string[]>();
    for (const [name, attr] of eligible) {
        const groupId = attr.visualGroup ?? `u:${attr.units || 'none'}`;
        const group = groups.get(groupId);
        if (group) {
            group.push(name);
        } else {
            groups.set(groupId, [name]);
        }
    }
    return Array.from(groups.entries()).map(([id, attrNames]) => ({ id, attrNames }));
}
