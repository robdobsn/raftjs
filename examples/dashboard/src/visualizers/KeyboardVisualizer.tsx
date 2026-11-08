/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// KeyboardVisualizer
// A playable piano keyboard for a synth device, attached to its note-on action (vt "keyboard"). Pressing a key
// sends note-on, releasing it note-off. Dragging across keys with a key held either glides to the new note
// (stylophone / portamento, with a glide action) or plays each key in turn. Several fingers play chords.
// Keys light from the device's published notes (and envelope levels), so notes played by anything else - a script,
// the touch strip - show too. Optional controls: octave down/up and an instrument picker (a map action).
//
// Options come from the note-on action's "vo" object in the device type record (all optional):
//   lowNote           MIDI note of the lowest key (default 48, C3) - octave buttons move it
//   numKeys           number of keys (default 25)
//   noteOffAction     action that stops a note (default "noteOff")
//   glideAction       action that slides the sounding note to another (default "glide"; none: drag replays)
//   instrumentAction  map action shown as an instrument picker (default "instrument" if present)
//   notesAttr         array attribute: MIDI note per voice, 0 = none (default "notes")
//   levelsAttr        array attribute: level per voice 0-255, same order (default "levels")
//
// Values sent are MIDI note numbers (the action's t, normally "B").
//
// When a control such as a touch strip is connected, a "Play with" row (controls/PlayWithRow) lets it play the synth
// (keys or stylophone - controls/synthModes); its notes light the keys like any others.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceTypeAction } from '../../../../src/RaftDeviceInfo';
import { DeviceVisualizerProps } from './VisualizerRegistry';
import PlayWithRow from '../controls/PlayWithRow';
import '../controls/synthModes';

const connManager = ConnManager.getInstance();

interface KeyboardOptions {
    lowNote?: number;
    numKeys?: number;
    noteOffAction?: string;
    glideAction?: string;
    instrumentAction?: string;
    notesAttr?: string;
    levelsAttr?: string;
}

// Latest complete sample of an attribute (all its elements)
function latestSample(attrState: DeviceAttributeState | undefined): number[] {
    if (!attrState) return [];
    const elems = attrState.elemsPerSample ?? 1;
    if (attrState.values.length < elems) return [];
    return attrState.values.slice(-elems).map(v => typeof v === 'number' ? v : NaN);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlackKey = (note: number) => [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
const noteName = (note: number) => `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;

// Drawing (SVG units)
const WHITE_W = 40;
const WHITE_H = 160;
const BLACK_W = 24;
const BLACK_H = 100;

interface KeyGeom { note: number; black: boolean; x: number; w: number; h: number; }

function layoutKeys(lowNote: number, numKeys: number): { keys: KeyGeom[]; width: number } {
    const keys: KeyGeom[] = [];
    let whiteIdx = 0;
    for (let note = lowNote; note < lowNote + numKeys; note++) {
        if (isBlackKey(note)) {
            // Centred on the boundary with the previous white key
            keys.push({ note, black: true, x: whiteIdx * WHITE_W - BLACK_W / 2, w: BLACK_W, h: BLACK_H });
        } else {
            keys.push({ note, black: false, x: whiteIdx * WHITE_W, w: WHITE_W, h: WHITE_H });
            whiteIdx++;
        }
    }
    // White keys first so black keys draw (and hit-test) on top
    keys.sort((a, b) => Number(a.black) - Number(b.black));
    return { keys, width: Math.max(1, whiteIdx) * WHITE_W };
}

const KeyboardVisualizer: React.FC<DeviceVisualizerProps> = ({ deviceKey, action }) => {
    const opts: KeyboardOptions = ((action as any)?.vo ?? {}) as KeyboardOptions;
    const numKeys = Math.min(Math.max(opts.numKeys ?? 25, 5), 61);
    const [lowNote, setLowNote] = useState<number>(Math.min(Math.max(opts.lowNote ?? 48, 0), 127 - numKeys + 1));
    const [dragGlide, setDragGlide] = useState<boolean>(true);
    const [instrument, setInstrument] = useState<string>('');

    // Notes held by each pointer, and all notes held here (shown at once, before the device reports them)
    const pointerNotes = useRef<Map<number, number>>(new Map());
    const [heldNotes, setHeldNotes] = useState<Set<number>>(new Set());
    const svgRef = useRef<SVGSVGElement | null>(null);

    // Commands are sent one after another so a note-off can't overtake its note-on
    const sendQueue = useRef<Promise<unknown>>(Promise.resolve());

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const actions: DeviceTypeAction[] = deviceState?.deviceTypeInfo?.actions ?? [];
    const findAction = (name?: string) => (name ? actions.find(a => a.n === name) : undefined);
    const noteOffAction = findAction(opts.noteOffAction ?? 'noteOff');
    const glideAction = findAction(opts.glideAction ?? 'glide');
    const instrumentAction = findAction(opts.instrumentAction ?? 'instrument');
    const instrumentNames = instrumentAction?.map ? Object.keys(instrumentAction.map) : [];

    const send = useCallback((act: DeviceTypeAction | undefined, value: number | string) => {
        if (!act || !deviceManager) return;
        sendQueue.current = sendQueue.current
            .then(() => deviceManager.sendAction(deviceKey, act, [value]))
            .catch(() => undefined);
    }, [deviceManager, deviceKey]);

    const refreshHeld = () => setHeldNotes(new Set(pointerNotes.current.values()));

    // Key under a point (black keys are on top so are found first)
    const { keys, width } = layoutKeys(lowNote, numKeys);
    const noteAtClientPoint = (clientX: number, clientY: number): number | null => {
        const svg = svgRef.current;
        if (!svg) return null;
        const rect = svg.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * width;
        const y = ((clientY - rect.top) / rect.height) * WHITE_H;
        for (let i = keys.length - 1; i >= 0; i--) {
            const k = keys[i];
            if (x >= k.x && x < k.x + k.w && y >= 0 && y < k.h) return k.note;
        }
        return null;
    };

    const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
        const note = noteAtClientPoint(e.clientX, e.clientY);
        if (note === null) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerNotes.current.set(e.pointerId, note);
        refreshHeld();
        send(action, note);
    };

    const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
        const prevNote = pointerNotes.current.get(e.pointerId);
        if (prevNote === undefined) return;
        const note = noteAtClientPoint(e.clientX, e.clientY);
        if ((note === null) || (note === prevNote)) return;
        pointerNotes.current.set(e.pointerId, note);
        refreshHeld();
        if (dragGlide && glideAction) {
            // The device slides the sounding note to the new one (it then holds the new note)
            send(glideAction, note);
        } else {
            send(noteOffAction, prevNote);
            send(action, note);
        }
    };

    const onPointerEnd = (e: React.PointerEvent<SVGSVGElement>) => {
        const note = pointerNotes.current.get(e.pointerId);
        if (note === undefined) return;
        pointerNotes.current.delete(e.pointerId);
        refreshHeld();
        // Another finger may still hold the same note
        if (![...pointerNotes.current.values()].includes(note))
            send(noteOffAction, note);
    };

    // Release anything still held if the visualizer goes away
    useEffect(() => () => {
        for (const note of new Set(pointerNotes.current.values()))
            send(noteOffAction, note);
        pointerNotes.current.clear();
    }, [send, noteOffAction]);

    if (!action || !deviceState) {
        return null;
    }

    // Notes sounding on the device, with their levels
    const devNotes = latestSample(deviceState.deviceAttributes[opts.notesAttr ?? 'notes']);
    const devLevels = latestSample(deviceState.deviceAttributes[opts.levelsAttr ?? 'levels']);
    const soundingLevel = new Map<number, number>();
    devNotes.forEach((n, i) => {
        if (Number.isFinite(n) && n > 0) {
            const lvl = Number.isFinite(devLevels[i]) ? devLevels[i] / 255 : 1;
            soundingLevel.set(n, Math.max(soundingLevel.get(n) ?? 0, lvl));
        }
    });

    const keyFill = (k: KeyGeom): string => {
        const held = heldNotes.has(k.note);
        const level = soundingLevel.get(k.note);
        if (level !== undefined) {
            // Sounding: from a light to a strong blue with the envelope level
            const a = 0.35 + 0.65 * Math.min(1, Math.max(0, level));
            return `rgba(79, 195, 247, ${a.toFixed(2)})`;
        }
        if (held) return '#ffb74d';
        return k.black ? '#222' : '#f4f4f4';
    };

    const shiftOctave = (delta: number) => {
        setLowNote(prev => Math.min(Math.max(prev + delta * 12, 0), 127 - numKeys + 1));
    };

    return (
        <div className="device-keyboard">
            <div className="zonegrid-header">
                <span className="zonegrid-title">Keyboard</span>
                <span className="keyboard-controls">
                    <button onClick={() => shiftOctave(-1)} disabled={lowNote < 12} title="Octave down">◀ Oct</button>
                    <span className="keyboard-range">{noteName(lowNote)} – {noteName(lowNote + numKeys - 1)}</span>
                    <button onClick={() => shiftOctave(1)} disabled={lowNote + numKeys + 12 > 128} title="Octave up">Oct ▶</button>
                    {glideAction && (
                        <label title="Dragging across keys glides (stylophone) or plays each key">
                            <input type="checkbox" checked={dragGlide} onChange={e => setDragGlide(e.target.checked)} /> Glide
                        </label>
                    )}
                    {instrumentNames.length > 0 && (
                        <select value={instrument}
                                onChange={e => { setInstrument(e.target.value); if (e.target.value) send(instrumentAction, e.target.value); }}
                                title="Instrument">
                            <option value="">Instrument…</option>
                            {instrumentNames.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                    )}
                </span>
            </div>
            <PlayWithRow targetKey={deviceKey} />
            <svg ref={svgRef} className="keyboard-svg" viewBox={`0 0 ${width} ${WHITE_H}`} preserveAspectRatio="none"
                 onPointerDown={onPointerDown} onPointerMove={onPointerMove}
                 onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
                {keys.map(k => (
                    <g key={k.note}>
                        <rect x={k.x + 1} y={0} width={k.w - 2} height={k.h} rx={4}
                              fill={keyFill(k)} stroke="#555" strokeWidth={1.5} />
                        {!k.black && (k.note % 12 === 0) && (
                            <text x={k.x + k.w / 2} y={WHITE_H - 10} textAnchor="middle" fontSize={13} fill="#555">{noteName(k.note)}</text>
                        )}
                    </g>
                ))}
            </svg>
        </div>
    );
};

export default KeyboardVisualizer;
