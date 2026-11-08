/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// ControlDirectory
// The controls (normalised inputs - see ControlTypes) of the connected devices, kept up to date as devices come,
// go, go offline and send data. Control adapters find controls from device type record metadata (as visualizers
// are found), never by device type name:
//   - touchstrip: an attribute with vt "touchstrip" (position array + vo sizeAttr/noValue/posMax/sizeMax/
//     numChannels) is a pos1d control - the Trill Flex/Bar/Ring/Craft and CogPro touch strip records
// Design: raftjs devdocs/dashboard-device-controls-and-bindings-design.md
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import ConnManager from '../ConnManager';
import { DeviceOnlineState, DeviceState } from '../../../../src/RaftDeviceStates';
import { DeviceTypeAttribute, getAttrElemsPerSample } from '../../../../src/RaftDeviceInfo';
import type { DeviceDecodedData } from '../../../../src/RaftDeviceManager';
import RaftDeviceMgrIF from '../../../../src/RaftDeviceMgrIF';
import { ControlKind, ControlListener, ControlSource, Pos1DEvent, Touch1D } from './ControlTypes';

const connManager = ConnManager.getInstance();

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Control sources
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// A source that is fed decoded data by the directory
interface FedControlSource extends ControlSource {
    handleDecoded(decoded: DeviceDecodedData): void;
    handleOffline(): void;
}

abstract class ControlSourceBase implements FedControlSource {
    id: string;
    online = true;
    private _listeners = new Set<ControlListener>();
    constructor(public deviceKey: string, public control: string, public kind: ControlKind, public label: string,
                public channels?: number) {
        this.id = `${deviceKey}:${control}`;
    }
    addListener(listener: ControlListener): () => void {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }
    protected emit(event: Pos1DEvent): void {
        this._listeners.forEach(l => {
            try { l(event); } catch (e) { console.warn(`ControlSource ${this.id} listener error`, e); }
        });
    }
    abstract handleDecoded(decoded: DeviceDecodedData): void;
    abstract handleOffline(): void;
}

// Max position change (0-1) for a touch in one sample to be the same touch
const TOUCH_MATCH_MAX = 0.2;

// pos1d from a touch strip attribute (array or single position, "no touch" value, optional size attribute)
export class TouchStripSource extends ControlSourceBase {
    private _touches: Touch1D[] = [];
    private _nextId = 1;
    private _sizeMaxSeen = 1;
    constructor(deviceKey: string, label: string, private _attr: DeviceTypeAttribute, private _sizeAttr: string | undefined,
                private _noValue: number | undefined, private _posMax: number, private _sizeMax: number | undefined,
                channels: number | undefined) {
        super(deviceKey, _attr.n, 'pos1d', label, channels);
    }

    handleDecoded(decoded: DeviceDecodedData): void {
        const posVals = decoded.attrValues[this._attr.n];
        if (!posVals || posVals.length === 0) return;
        const elems = Math.max(1, this._attr.t ? getAttrElemsPerSample(this._attr.t) : 1);
        const sizeVals = this._sizeAttr ? decoded.attrValues[this._sizeAttr] : undefined;
        const numSamples = Math.floor(posVals.length / elems);
        for (let s = 0; s < numSamples; s++) {
            const positions: { pos: number; size: number }[] = [];
            for (let e = 0; e < elems; e++) {
                const raw = Number(posVals[s * elems + e]);
                if (!Number.isFinite(raw) || (this._noValue !== undefined && raw === this._noValue)) continue;
                const rawSize = sizeVals ? Number(sizeVals[s * elems + e]) : NaN;
                if (Number.isFinite(rawSize) && rawSize > this._sizeMaxSeen) this._sizeMaxSeen = rawSize;
                const sizeMax = this._sizeMax ?? this._sizeMaxSeen;
                positions.push({
                    pos: Math.min(1, Math.max(0, raw / this._posMax)),
                    size: Number.isFinite(rawSize) ? Math.min(1, Math.max(0, rawSize / sizeMax)) : 0,
                });
            }
            const tsUs = decoded.timestampsUs[s];
            this.update(positions, tsUs !== undefined ? tsUs / 1000 : Date.now());
        }
    }

    handleOffline(): void {
        this.online = false;
        this.update([], Date.now());
    }

    // Match the new positions to the current touches (nearest first) and emit started/moved/ended
    private update(positions: { pos: number; size: number }[], timeMs: number): void {
        const prev = this._touches;
        const unmatchedPrev = new Set(prev.map((_, i) => i));
        const pairs: { p: number; n: number; d: number }[] = [];
        prev.forEach((t, p) => positions.forEach((np, n) => pairs.push({ p, n, d: Math.abs(t.pos - np.pos) })));
        pairs.sort((a, b) => a.d - b.d);
        const matchedNew = new Map<number, number>();     // new index -> prev index
        // One touch before and after is the same touch however far it moved (a fast swipe, or a single-touch device);
        // with more, the nearest pairs within TOUCH_MATCH_MAX are the same touches
        const singleTouch = (prev.length === 1) && (positions.length === 1);
        for (const pr of pairs) {
            if (!singleTouch && pr.d > TOUCH_MATCH_MAX) break;
            if (!unmatchedPrev.has(pr.p) || matchedNew.has(pr.n)) continue;
            matchedNew.set(pr.n, pr.p);
            unmatchedPrev.delete(pr.p);
        }
        const touches: Touch1D[] = [];
        const started: Touch1D[] = [];
        const moved: Touch1D[] = [];
        positions.forEach((np, n) => {
            const p = matchedNew.get(n);
            if (p === undefined) {
                const t = { id: this._nextId++, pos: np.pos, size: np.size };
                touches.push(t);
                started.push(t);
            } else {
                const old = prev[p];
                const t = { id: old.id, pos: np.pos, size: np.size };
                touches.push(t);
                if (t.pos !== old.pos || t.size !== old.size) moved.push(t);
            }
        });
        const ended = [...unmatchedPrev].map(i => prev[i]);
        this._touches = touches;
        if (started.length || moved.length || ended.length) {
            this.emit({ kind: 'pos1d', timeMs, touches, started, moved, ended });
        }
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Control adapters - find a device's controls from its record
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface ControlAdapter {
    id: string;
    // Sources for a device (none if it has no controls of this adapter's kind)
    createSources(deviceKey: string, deviceState: DeviceState, label: string): FedControlSource[];
}

const touchStripAdapter: ControlAdapter = {
    id: 'touchstrip',
    createSources(deviceKey, deviceState, label) {
        const attrs = deviceState.deviceTypeInfo?.resp?.a ?? [];
        return attrs
            .filter(a => a.vt === 'touchstrip')
            .map(a => {
                const vo = ((a as any).vo ?? {}) as { sizeAttr?: string; noValue?: number; posMax?: number;
                                                       sizeMax?: number; numChannels?: number };
                const posMax = vo.posMax ?? a.r?.[1] ?? 65535;
                return new TouchStripSource(deviceKey, label, a, vo.sizeAttr, vo.noValue, posMax > 0 ? posMax : 1,
                                            vo.sizeMax, vo.numChannels);
            });
    },
};

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// The directory
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

type DirectoryListener = () => void;

class ControlDirectoryImpl {
    private _adapters: ControlAdapter[] = [touchStripAdapter];
    private _sources = new Map<string, FedControlSource>();         // by source id
    private _sourcesByDevice = new Map<string, FedControlSource[]>();
    private _listeners = new Set<DirectoryListener>();
    private _deviceMgr: RaftDeviceMgrIF | undefined;
    private _version = 0;

    registerAdapter(adapter: ControlAdapter): void {
        if (!this._adapters.some(a => a.id === adapter.id)) this._adapters.push(adapter);
    }

    // Attach to the current connection's device manager (a new one is made for each connection)
    ensureAttached(): void {
        const dm = connManager.getConnector().getSystemType()?.deviceMgrIF;
        if (dm === this._deviceMgr) return;
        this.detach();
        this._deviceMgr = dm;
        if (!dm) return;
        dm.addNewDeviceCallback(this._onDeviceChange);
        dm.addNewAttributeCallback(this._onNewAttribute);
        dm.addDeviceRemovedCallback(this._onDeviceRemoved);
        if (dm.addDecodedDataCallback) {
            dm.addDecodedDataCallback(this._onDecoded);
        }
        for (const deviceKey of Object.keys(dm.getDevicesState())) this.scanDevice(deviceKey);
        this.changed();
    }

    getSources(kinds?: ControlKind[]): ControlSource[] {
        this.ensureAttached();
        return [...this._sources.values()].filter(s => !kinds || kinds.includes(s.kind));
    }

    getSource(id: string): ControlSource | undefined {
        return this._sources.get(id);
    }

    // Changes to the list (added, removed, online state) - not data
    subscribe(listener: DirectoryListener): () => void {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }

    get version(): number {
        return this._version;
    }

    private detach(): void {
        const dm = this._deviceMgr;
        if (dm) {
            dm.removeNewDeviceCallback(this._onDeviceChange);
            dm.removeNewAttributeCallback(this._onNewAttribute);
            dm.removeDeviceRemovedCallback(this._onDeviceRemoved);
            dm.removeDecodedDataCallback?.(this._onDecoded);
        }
        this._deviceMgr = undefined;
        if (this._sources.size > 0) {
            this._sources.forEach(s => s.handleOffline());
            this._sources.clear();
            this._sourcesByDevice.clear();
            this.changed();
        }
    }

    private changed(): void {
        this._version++;
        this._listeners.forEach(l => l());
    }

    // (Re)find a device's controls - when it appears, gains attributes or changes online state
    private scanDevice(deviceKey: string): void {
        const dm = this._deviceMgr;
        const deviceState = dm?.getDevicesState()[deviceKey];
        if (!dm || !deviceState || !deviceState.deviceTypeInfo) return;
        const online = deviceState.onlineState === DeviceOnlineState.Online;
        const existing = this._sourcesByDevice.get(deviceKey);
        if (existing && existing.length > 0) {
            let stateChanged = false;
            for (const s of existing) {
                if (s.online !== online) {
                    stateChanged = true;
                    if (online) s.online = true; else s.handleOffline();
                }
            }
            if (stateChanged) this.changed();
            return;
        }
        const label = deviceState.displayName || deviceState.deviceTypeInfo.name || deviceKey;
        const sources = this._adapters.flatMap(a => a.createSources(deviceKey, deviceState, label));
        if (sources.length === 0) return;
        if (sources.length > 1) sources.forEach(s => { s.label = `${label} (${s.control})`; });
        sources.forEach(s => { s.online = online; this._sources.set(s.id, s); });
        this._sourcesByDevice.set(deviceKey, sources);
        this.changed();
    }

    private _onDeviceChange = (deviceKey: string, _state: DeviceState) => this.scanDevice(deviceKey);
    private _onNewAttribute = (deviceKey: string) => this.scanDevice(deviceKey);

    private _onDeviceRemoved = (deviceKey: string) => {
        const sources = this._sourcesByDevice.get(deviceKey);
        if (!sources) return;
        sources.forEach(s => { s.handleOffline(); this._sources.delete(s.id); });
        this._sourcesByDevice.delete(deviceKey);
        this.changed();
    };

    private _onDecoded = (decoded: DeviceDecodedData) => {
        const sources = this._sourcesByDevice.get(decoded.deviceKey);
        if (!sources) {
            // The device may have just got its type info
            this.scanDevice(decoded.deviceKey);
            return;
        }
        for (const s of sources) {
            if (!s.online) {
                // Data again after being offline
                s.online = true;
                this.changed();
            }
            s.handleDecoded(decoded);
        }
    };
}

export const ControlDirectory = new ControlDirectoryImpl();
