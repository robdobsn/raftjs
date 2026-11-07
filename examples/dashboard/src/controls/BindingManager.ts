/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// BindingManager
// Bindings: a control source (e.g. a touch strip) driving a target device (e.g. a synth) through a mode (e.g.
// "keys"). A binding is data - source, target, mode and parameters - and runs here, outside React components, so
// it keeps going while panels re-render or are hidden. Modes turn normalised control events into the target's
// actions (by name, from its device type record).
//
// Actions are sent through one queue per target, one at a time, in order. A "latest" action (a continuous value
// such as a glide) that is still waiting is replaced by a newer one, so a 20 Hz stream can't build a backlog over a
// slow link; "ordered" actions (note on/off) are never dropped or reordered.
//
// Design: raftjs devdocs/dashboard-device-controls-and-bindings-design.md
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import ConnManager from '../ConnManager';
import { DeviceTypeAction } from '../../../../src/RaftDeviceInfo';
import { ControlDirectory } from './ControlDirectory';
import { ControlEvent, ControlKind, ControlSource } from './ControlTypes';

const connManager = ConnManager.getInstance();

export type ParamValue = number | string | boolean;
export type SendPolicy = 'ordered' | 'latest';

export interface ModeParamDef {
    name: string;
    label: string;
    type: 'number' | 'select' | 'boolean';
    options?: string[];             // for select
    min?: number;
    max?: number;
}

export interface ModeContext {
    source: ControlSource;
    targetKey: string;
    params: Record<string, ParamValue>;
    send(actionName: string, value: number | string, policy?: SendPolicy): void;
}

export interface ModeRunner {
    onEvent(event: ControlEvent): void;
    stop(): void;                   // release anything held (e.g. notes)
}

export interface BindingMode {
    id: string;
    label: string;
    description: string;
    sourceKinds: ControlKind[];
    requiredActions: string[];      // the target must have these actions for the mode to be offered
    params: ModeParamDef[];
    defaultParams: Record<string, ParamValue>;
    createRunner(ctx: ModeContext): ModeRunner;
}

export interface Binding {
    id: string;
    sourceId: string;
    targetKey: string;
    modeId: string;
    params: Record<string, ParamValue>;
}

export type BindingStatus = 'active' | 'waiting';     // waiting: its source isn't available (yet, or any more)

interface RunningBinding {
    binding: Binding;
    runner?: ModeRunner;
    unlisten?: () => void;
}

interface QueueItem {
    actionName: string;
    value: number | string;
    policy: SendPolicy;
}

class BindingManagerImpl {
    private _modes = new Map<string, BindingMode>();
    private _bindings = new Map<string, RunningBinding>();
    private _listeners = new Set<() => void>();
    private _queues = new Map<string, { items: QueueItem[]; busy: boolean }>();
    private _nextId = 1;

    constructor() {
        ControlDirectory.subscribe(() => this.relink());
    }

    registerMode(mode: BindingMode): void {
        this._modes.set(mode.id, mode);
    }

    getMode(id: string): BindingMode | undefined {
        return this._modes.get(id);
    }

    // Modes that a source can drive on a target (its kind, and the target has the actions)
    modesFor(source: ControlSource, targetKey: string): BindingMode[] {
        const actionNames = new Set(this.targetActions(targetKey).map(a => a.n));
        return [...this._modes.values()].filter(m =>
            m.sourceKinds.includes(source.kind) && m.requiredActions.every(n => actionNames.has(n)));
    }

    bindingsForTarget(targetKey: string): Binding[] {
        return [...this._bindings.values()].map(r => r.binding).filter(b => b.targetKey === targetKey);
    }

    status(bindingId: string): BindingStatus {
        return this._bindings.get(bindingId)?.runner ? 'active' : 'waiting';
    }

    create(sourceId: string, targetKey: string, modeId: string, params?: Record<string, ParamValue>): Binding | null {
        const mode = this._modes.get(modeId);
        if (!mode) return null;
        const binding: Binding = {
            id: `b${this._nextId++}`, sourceId, targetKey, modeId,
            params: { ...mode.defaultParams, ...(params ?? {}) },
        };
        this._bindings.set(binding.id, { binding });
        this.link(binding.id);
        this.changed();
        return binding;
    }

    update(bindingId: string, change: Partial<Pick<Binding, 'sourceId' | 'modeId' | 'params'>>): void {
        const running = this._bindings.get(bindingId);
        if (!running) return;
        this.unlink(bindingId);
        const b = running.binding;
        if (change.modeId && change.modeId !== b.modeId) {
            const mode = this._modes.get(change.modeId);
            b.modeId = change.modeId;
            b.params = { ...(mode?.defaultParams ?? {}), ...b.params };
        }
        if (change.sourceId) b.sourceId = change.sourceId;
        if (change.params) b.params = { ...b.params, ...change.params };
        this.link(bindingId);
        this.changed();
    }

    remove(bindingId: string): void {
        this.unlink(bindingId);
        this._bindings.delete(bindingId);
        this.changed();
    }

    subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }

    private changed(): void {
        this._listeners.forEach(l => l());
    }

    // Start a binding's runner if its source is available
    private link(bindingId: string): void {
        const running = this._bindings.get(bindingId);
        if (!running || running.runner) return;
        const b = running.binding;
        const source = ControlDirectory.getSource(b.sourceId);
        const mode = this._modes.get(b.modeId);
        if (!source || !source.online || !mode) return;
        const runner = mode.createRunner({
            source,
            targetKey: b.targetKey,
            params: b.params,
            send: (actionName, value, policy = 'ordered') => this.enqueue(b.targetKey, { actionName, value, policy }),
        });
        running.runner = runner;
        running.unlisten = source.addListener(ev => runner.onEvent(ev));
    }

    private unlink(bindingId: string): void {
        const running = this._bindings.get(bindingId);
        if (!running?.runner) return;
        running.unlisten?.();
        running.runner.stop();
        running.runner = undefined;
        running.unlisten = undefined;
    }

    // Sources came, went or changed online state: start waiting bindings, stop ones whose source has gone
    private relink(): void {
        let changed = false;
        for (const [id, running] of this._bindings) {
            const source = ControlDirectory.getSource(running.binding.sourceId);
            const available = !!source && source.online;
            if (running.runner && !available) {
                this.unlink(id);
                changed = true;
            } else if (!running.runner && available) {
                this.link(id);
                changed = changed || !!running.runner;
            }
        }
        if (changed) this.changed();
    }

    private targetActions(targetKey: string): DeviceTypeAction[] {
        const dm = connManager.getConnector().getSystemType()?.deviceMgrIF;
        return dm?.getDeviceState(targetKey)?.deviceTypeInfo?.actions ?? [];
    }

    private enqueue(targetKey: string, item: QueueItem): void {
        let queue = this._queues.get(targetKey);
        if (!queue) {
            queue = { items: [], busy: false };
            this._queues.set(targetKey, queue);
        }
        if (item.policy === 'latest') {
            const waiting = queue.items.find(i => i.policy === 'latest' && i.actionName === item.actionName);
            if (waiting) {
                waiting.value = item.value;
                return;
            }
        }
        queue.items.push(item);
        void this.pump(targetKey);
    }

    private async pump(targetKey: string): Promise<void> {
        const queue = this._queues.get(targetKey);
        if (!queue || queue.busy) return;
        queue.busy = true;
        try {
            while (queue.items.length > 0) {
                const item = queue.items.shift()!;
                const dm = connManager.getConnector().getSystemType()?.deviceMgrIF;
                const action = this.targetActions(targetKey).find(a => a.n === item.actionName);
                if (!dm || !action) continue;
                try {
                    await dm.sendAction(targetKey, action, [item.value]);
                } catch (e) {
                    console.warn(`BindingManager send ${item.actionName} to ${targetKey} failed`, e);
                }
            }
        } finally {
            queue.busy = false;
        }
    }
}

export const BindingManager = new BindingManagerImpl();
