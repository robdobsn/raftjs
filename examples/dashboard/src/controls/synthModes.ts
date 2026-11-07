/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// synthModes
// Binding modes that play a synth (a device with noteOn/noteOff, and glide for the stylophone) from a 1D control
// such as a touch strip. Positions along the control map to the notes of a scale from a low note.
//
//   keys        each touch plays the note under it; moving to another note plays that one instead
//   stylophone  a touch plays the note under it; moving glides (always in tune, as the scale is quantised)
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { BindingManager, BindingMode, ModeContext, ModeParamDef, ParamValue } from './BindingManager';
import { ControlEvent, Touch1D } from './ControlTypes';

// Semitone steps of each scale within an octave
export const SCALES: Record<string, number[]> = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    blues: [0, 3, 5, 6, 7, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

// Note for the n-th step of a scale above a low note (MIDI)
export function scaleNote(lowNote: number, scale: string, step: number): number {
    const steps = SCALES[scale] ?? SCALES.major;
    const octave = Math.floor(step / steps.length);
    const note = lowNote + octave * 12 + steps[((step % steps.length) + steps.length) % steps.length];
    return Math.min(127, Math.max(0, note));
}

const COMMON_PARAMS: ModeParamDef[] = [
    { name: 'scale', label: 'Scale', type: 'select', options: Object.keys(SCALES) },
    { name: 'lowNote', label: 'Lowest note', type: 'number', min: 0, max: 120 },
    { name: 'notes', label: 'Notes along the strip', type: 'number', min: 2, max: 48 },
    { name: 'reverse', label: 'Reverse', type: 'boolean' },
];

function defaultParams(ctxChannels?: number): Record<string, ParamValue> {
    return { scale: 'major', lowNote: 48, notes: ctxChannels && ctxChannels > 1 ? ctxChannels : 15, reverse: false };
}

// Note for a position along the control (pad centres map to notes)
function noteAtPos(ctx: ModeContext, pos: number): number {
    const p = ctx.params;
    const numNotes = Math.max(2, Number(p.notes) || 15);
    const pos01 = p.reverse ? 1 - pos : pos;
    const step = Math.round(pos01 * (numNotes - 1));
    return scaleNote(Number(p.lowNote) || 48, String(p.scale || 'major'), step);
}

// Keys: every touch plays a note, chords with multi-touch controls
const keysMode: BindingMode = {
    id: 'keys',
    label: 'Keys',
    description: 'Touch to play the note under your finger; slide to play the next notes',
    sourceKinds: ['pos1d'],
    requiredActions: ['noteOn', 'noteOff'],
    params: COMMON_PARAMS,
    defaultParams: defaultParams(),
    createRunner(ctx) {
        const held = new Map<number, number>();       // touch id -> note
        const release = (note: number) => {
            // Another touch may still be on the same note
            if (![...held.values()].includes(note)) ctx.send('noteOff', note);
        };
        return {
            onEvent(ev: ControlEvent) {
                for (const t of ev.ended) {
                    const note = held.get(t.id);
                    held.delete(t.id);
                    if (note !== undefined) release(note);
                }
                const play = (t: Touch1D) => {
                    const note = noteAtPos(ctx, t.pos);
                    const prev = held.get(t.id);
                    if (prev === note) return;
                    held.set(t.id, note);
                    if (prev !== undefined) release(prev);
                    ctx.send('noteOn', note);
                };
                ev.started.forEach(play);
                ev.moved.forEach(play);
            },
            stop() {
                for (const note of new Set(held.values())) ctx.send('noteOff', note);
                held.clear();
            },
        };
    },
};

// Stylophone: one voice that glides between the notes of the scale as the touch moves
const stylophoneMode: BindingMode = {
    id: 'stylophone',
    label: 'Stylophone',
    description: 'Touch to play; slide and the note glides to the next notes of the scale',
    sourceKinds: ['pos1d'],
    requiredActions: ['noteOn', 'noteOff', 'glide'],
    params: COMMON_PARAMS,
    defaultParams: defaultParams(),
    createRunner(ctx) {
        let touchId: number | null = null;       // the touch that plays (the first one down)
        let note: number | null = null;
        return {
            onEvent(ev: ControlEvent) {
                if (touchId !== null && ev.ended.some(t => t.id === touchId)) {
                    if (note !== null) ctx.send('noteOff', note);
                    touchId = null;
                    note = null;
                }
                if (touchId === null && ev.touches.length > 0) {
                    const t = ev.touches[0];
                    touchId = t.id;
                    note = noteAtPos(ctx, t.pos);
                    ctx.send('noteOn', note);
                    return;
                }
                const t = ev.moved.find(m => m.id === touchId);
                if (t && note !== null) {
                    const newNote = noteAtPos(ctx, t.pos);
                    if (newNote !== note) {
                        note = newNote;
                        ctx.send('glide', newNote, 'latest');
                    }
                }
            },
            stop() {
                if (note !== null) ctx.send('noteOff', note);
                touchId = null;
                note = null;
            },
        };
    },
};

BindingManager.registerMode(keysMode);
BindingManager.registerMode(stylophoneMode);

// Default parameters for a source (the number of notes follows its channels)
export function synthModeDefaults(channels?: number): Record<string, ParamValue> {
    return defaultParams(channels);
}
