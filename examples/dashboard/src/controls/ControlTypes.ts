/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// ControlTypes
// Normalised controls: a device's input attributes (a touch strip, a slider, ...) seen as one of a few control
// kinds with values from 0 to 1, so that a mode (e.g. "play the synth from a strip") works with any device that
// provides that kind of control. Design: raftjs devdocs/dashboard-device-controls-and-bindings-design.md
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type ControlKind = 'pos1d' | 'pos2d' | 'scalar' | 'buttons';

// One touch on a 1D control: id is stable from the touch starting to it ending
export interface Touch1D {
    id: number;
    pos: number;        // 0-1 along the control
    size: number;       // 0-1 (0 if the device doesn't report a size)
}

export interface Pos1DEvent {
    kind: 'pos1d';
    timeMs: number;
    touches: Touch1D[];     // all current touches
    started: Touch1D[];     // touches that began with this sample
    moved: Touch1D[];       // continuing touches whose position or size changed
    ended: Touch1D[];       // touches that ended (their last position)
}

export type ControlEvent = Pos1DEvent;

export type ControlListener = (event: ControlEvent) => void;

export interface ControlSource {
    id: string;                 // `${deviceKey}:${control}`
    deviceKey: string;
    control: string;            // the attribute the control comes from
    kind: ControlKind;
    label: string;              // for menus: device display name (and control if not the only one)
    channels?: number;          // sensing channels (pads) along the control, if known
    online: boolean;
    addListener(listener: ControlListener): () => void;
}
