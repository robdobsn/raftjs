/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceStates
// Device states for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DeviceTypeInfo } from "./RaftDeviceInfo";

export function deviceAttrGetLatestFormatted(attrState: DeviceAttributeState): string {

    if (attrState.values.length === 0) {
        return 'N/A';
    }
    // Array attributes: format the latest full sample
    const elemsPerSample = attrState.elemsPerSample ?? 1;
    if (elemsPerSample > 1 && attrState.values.length >= elemsPerSample) {
        const sample = attrState.values.slice(-elemsPerSample);
        return '[' + sample.map(v => deviceAttrFormatLabelled(v, attrState)).join(', ') + ']';
    }
    const value = attrState.values[attrState.values.length - 1];
    return deviceAttrFormatLabelled(value, attrState);
}

/**
 * The display label for a value of an attribute with value labels (vl) or bit labels (bl), or null if the attribute
 * has neither. Labels are display only: the value itself stays numeric everywhere else.
 *   vl: the label for the value; an unlisted value gives "<value> (?)"
 *   bl: the labels of the bits set, space separated, in mask order; set bits without a label are added as hex
 *       ("+0x80"); an empty label ignores its bits (e.g. a configuration bit that is always set); a value of 0, or
 *       one with only ignored bits set, gives the "0" entry's label, or "-"
 * vl takes precedence if an attribute has both.
 */
export function deviceAttrValueLabel(value: number | string, attrState: DeviceAttributeState): string | null {
    if (typeof value === 'string' || Number.isNaN(value)) {
        return null;
    }
    if (attrState.valueLabels) {
        const label = attrState.valueLabels[String(value)];
        return label !== undefined ? label : `${deviceAttrFormatValue(value, attrState.format)} (?)`;
    }
    if (attrState.bitLabels) {
        const bits = Math.round(value) >>> 0;
        const zeroLabel = attrState.bitLabels["0"] ?? "-";
        if (bits === 0) {
            return zeroLabel;
        }
        const masks = Object.keys(attrState.bitLabels)
            .filter((key) => key !== "0")
            .map((key) => ({ mask: Number(key) >>> 0, label: attrState.bitLabels![key] }))
            .filter((entry) => entry.mask !== 0 && !Number.isNaN(entry.mask))
            .sort((a, b) => a.mask - b.mask);
        const labels: string[] = [];
        let unlabelled = bits;
        for (const entry of masks) {
            if ((bits & entry.mask) === entry.mask) {
                if (entry.label !== "") {
                    labels.push(entry.label);
                }
                unlabelled &= ~entry.mask;
            }
        }
        if (unlabelled !== 0) {
            labels.push(`+0x${(unlabelled >>> 0).toString(16)}`);
        }
        return labels.length > 0 ? labels.join(' ') : zeroLabel;
    }
    return null;
}

// A value formatted for display: its label if the attribute has value or bit labels, otherwise the formatted number
function deviceAttrFormatLabelled(value: number | string, attrState: DeviceAttributeState): string {
    const label = deviceAttrValueLabel(value, attrState);
    return label !== null ? label : deviceAttrFormatValue(value, attrState.format);
}

function deviceAttrFormatValue(value: number | string, formatIn: string): string {
    // String values are returned directly
    if (typeof value === 'string') {
        return value;
    }
    if (formatIn.length === 0) {
        return value.toString();
    }
    let format = formatIn;
    if (format.startsWith("%")) {
        format = format.slice(1);
    }
    if (format.endsWith('f')) {
        // Floating point number formatting
        const parts = format.split('.');
        let decimalPlaces = 0;
        if (parts.length === 2) {
            decimalPlaces = parseInt(parts[1], 10);
        }
        const formattedNumber = value.toFixed(decimalPlaces);
        const fieldWidth = parseInt(parts[0], 10);
        return fieldWidth ? formattedNumber.padStart(fieldWidth, ' ') : formattedNumber;
    } else if (format.endsWith('x')) {
        // Hexadecimal formatting
        const totalLength = parseInt(format.slice(0, -1), 10);
        return Math.floor(value).toString(16).padStart(totalLength, format.startsWith('0') ? '0' : ' ');
    } else if (format.endsWith('d')) {
        // Decimal integer formatting
        const totalLength = parseInt(format.slice(0, -1), 10);
        return Math.floor(value).toString(10).padStart(totalLength, format.startsWith('0') ? '0' : ' ');
    } else if (format.endsWith('b')) {
        // Binary formatting
        return Math.floor(value) === 0 ? 'no' : 'yes';
    }
    return value.toString();
}

export interface DeviceAttributeState {
    name: string;
    newAttribute: boolean;
    newData: boolean;
    numNewValues: number;
    values: (number | string)[];
    units: string;
    range: number[];
    format: string;
    visibleSeries: boolean;
    visibleForm: boolean;
    // Number of values per sample (array attributes decode to >1 value per sample;
    // values[] is then viewed as values[sampleIdx * elemsPerSample + elemIdx])
    elemsPerSample?: number;
    // Element labels/units for array attributes (from schema el/eu fields)
    elemLabels?: string[];
    elemUnits?: string;
    // Visual group for timeline chart splitting (from schema vg field)
    visualGroup?: string;
    // Value labels and bit labels for display (from schema vl and bl fields) - see deviceAttrValueLabel
    valueLabels?: Record<string, string>;
    bitLabels?: Record<string, string>;
}

export interface DeviceAttributesState {
    [attributeName: string]: DeviceAttributeState;
}

export interface DeviceTimeline {
    timestampsUs: number[];
    lastReportTimestampUs: number;
    reportTimestampOffsetUs: number;
    totalSamplesAdded: number;
    // Piecewise EMA timestamp reconstruction state
    emaLastSampleTimeUs: number;
    emaIntervalUs: number;
    emaPrevPollTimeUs: number;
    emaCalibrated: boolean;
    emaCalibrationPolls: number;
}

export interface DeviceStats {
    totalSamples: number;
    windowMs: number;
    windowSamples: number;
    sampleRateHz: number;
    lastSampleTimeMs: number | null;
    lastUpdateTimeMs: number | null;
}

export enum DeviceOnlineState {
    Offline = 0,
    Online = 1,
    PendingDeletion = 2,
}

export interface DeviceState {
    deviceTypeInfo: DeviceTypeInfo | undefined;
    deviceTimeline: DeviceTimeline;
    deviceAttributes: DeviceAttributesState;
    deviceIsNew: boolean;
    stateChanged: boolean;
    onlineState: DeviceOnlineState;
    deviceAddress: string;
    /**
     * @deprecated Holds the type display name or the device name (devbin), or the device type index (devjson) -
     * use deviceTypeKey, displayName or deviceName. Kept with its current meaning until a major version
     */
    deviceType: string;
    /**
     * @deprecated Holds the bus number as a string - use busNum. Kept with its current meaning until a major
     * version
     */
    busName: string;
    /** The name to show for the device: its device name if it has one, otherwise its type display name and its
     * device ID (from the firmware's displayName, or derived the same way for older firmware) */
    displayName?: string;
    /** The device name (assigned with devman/setname), or "" if it has none */
    deviceName?: string;
    /** The device type key (e.g. "MPU6050") */
    deviceTypeKey?: string;
    /** The bus number (0 for a directly connected device) */
    busNum?: number;
}

export class DevicesState {
    [deviceKey: string]: DeviceState;
}

// Format a numeric device address as canonical hex string:
// lowercase, no "0x" prefix, no leading zeros
export function formatDeviceAddrHex(addr: number): string {
    return addr.toString(16);
}

// Generate a composite device key from bus number and hex address
export function getDeviceKey(busNumberAsString: string, devAddrHexStr: string): string {
    return `${busNumberAsString}_${devAddrHexStr}`;
}

// Parse a device key into its bus and address components
export function parseDeviceKey(deviceKey: string): { bus: string; addr: string } {
    const sep = deviceKey.indexOf('_');
    if (sep < 0) {
        return { bus: deviceKey, addr: '' };
    }
    return { bus: deviceKey.substring(0, sep), addr: deviceKey.substring(sep + 1) };
}
