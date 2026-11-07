/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// PlayWithRow
// "Play with: [device] Mode: [..] ..." - shown by a target's visualizer (e.g. the synth keyboard) when there are
// control sources that can drive it. Choosing a source creates a binding (BindingManager); it keeps running if the
// panel is hidden, and pauses (waiting) if the source device goes. Choosing "Off" removes it. Nothing is connected
// unless chosen here.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React from 'react';
import { BindingManager, ParamValue } from './BindingManager';
import { ControlKind } from './ControlTypes';
import { useBindingsForTarget, useControlSources } from './useControls';
import { synthModeDefaults } from './synthModes';

interface PlayWithRowProps {
    targetKey: string;
    kinds?: ControlKind[];
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (note: number) => `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;

const PlayWithRow: React.FC<PlayWithRowProps> = ({ targetKey, kinds = ['pos1d'] }) => {
    const sources = useControlSources(kinds).filter(s => s.deviceKey !== targetKey);
    const bindings = useBindingsForTarget(targetKey);
    const binding = bindings[0];
    const boundSource = binding ? sources.find(s => s.id === binding.sourceId) : undefined;

    // Nothing to offer
    if (!binding && sources.length === 0) return null;

    const modes = boundSource ? BindingManager.modesFor(boundSource, targetKey) : [];
    const mode = binding ? BindingManager.getMode(binding.modeId) : undefined;

    const chooseSource = (sourceId: string) => {
        if (!sourceId) {
            if (binding) BindingManager.remove(binding.id);
            return;
        }
        const source = sources.find(s => s.id === sourceId);
        if (!source) return;
        if (binding) {
            BindingManager.update(binding.id, { sourceId });
            return;
        }
        const available = BindingManager.modesFor(source, targetKey);
        if (available.length === 0) return;
        const modeId = available.find(m => m.id === 'stylophone')?.id ?? available[0].id;
        BindingManager.create(sourceId, targetKey, modeId, synthModeDefaults(source.channels));
    };

    const setParam = (name: string, value: ParamValue) => {
        if (binding) BindingManager.update(binding.id, { params: { [name]: value } });
    };

    const waiting = binding && BindingManager.status(binding.id) === 'waiting';

    return (
        <div className="playwith-row">
            <label>
                Play with:{' '}
                <select value={binding?.sourceId ?? ''} onChange={e => chooseSource(e.target.value)}>
                    <option value="">Off</option>
                    {sources.map(s => <option key={s.id} value={s.id}>{s.label}{s.online ? '' : ' (offline)'}</option>)}
                    {binding && !sources.some(s => s.id === binding.sourceId) && (
                        <option value={binding.sourceId}>{binding.sourceId} (gone)</option>
                    )}
                </select>
            </label>
            {binding && (
                <>
                    {modes.length > 0 && (
                        <label title={mode?.description}>
                            Mode:{' '}
                            <select value={binding.modeId} onChange={e => BindingManager.update(binding.id, { modeId: e.target.value })}>
                                {modes.map(m => <option key={m.id} value={m.id} title={m.description}>{m.label}</option>)}
                            </select>
                        </label>
                    )}
                    {(mode?.params ?? []).map(p => {
                        const value = binding.params[p.name];
                        if (p.type === 'select') {
                            return (
                                <label key={p.name}>{p.label}:{' '}
                                    <select value={String(value)} onChange={e => setParam(p.name, e.target.value)}>
                                        {(p.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                </label>
                            );
                        }
                        if (p.type === 'boolean') {
                            return (
                                <label key={p.name}>
                                    <input type="checkbox" checked={!!value} onChange={e => setParam(p.name, e.target.checked)} /> {p.label}
                                </label>
                            );
                        }
                        const num = Number(value);
                        return (
                            <label key={p.name}>{p.label}:{' '}
                                <input type="number" className="playwith-number" min={p.min} max={p.max} value={Number.isFinite(num) ? num : ''}
                                       onChange={e => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) setParam(p.name, v); }} />
                                {p.name === 'lowNote' && Number.isFinite(num) && <span className="playwith-note">{noteName(num)}</span>}
                            </label>
                        );
                    })}
                    {waiting && <span className="playwith-waiting">waiting for the device…</span>}
                </>
            )}
        </div>
    );
};

export default PlayWithRow;
