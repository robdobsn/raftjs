/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// panelSplit
// The width of the left column (attributes and actions) of the device panels, shared by every panel so they line
// up, and kept for the page session: set to a fraction of the panel when first shown, then changed only by the user
// dragging a splitter (or double-clicking it to go back to the default). A page refresh starts again.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

type Listener = (widthPx: number) => void;

export const DEFAULT_LEFT_FRACTION = 1 / 3;
export const MIN_LEFT_PX = 200;
export const MIN_RIGHT_PX = 240;

let leftWidthPx: number | null = null;
const listeners = new Set<Listener>();

export function getLeftWidthPx(): number | null {
    return leftWidthPx;
}

// Width for a panel of a given width: the default fraction, kept within the minimums
export function defaultLeftWidthPx(panelWidthPx: number): number {
    return clampLeftWidthPx(Math.round(panelWidthPx * DEFAULT_LEFT_FRACTION), panelWidthPx);
}

export function clampLeftWidthPx(widthPx: number, panelWidthPx: number): number {
    const maxPx = Math.max(MIN_LEFT_PX, panelWidthPx - MIN_RIGHT_PX);
    return Math.round(Math.min(Math.max(widthPx, MIN_LEFT_PX), maxPx));
}

export function setLeftWidthPx(widthPx: number): void {
    if (widthPx === leftWidthPx) return;
    leftWidthPx = widthPx;
    listeners.forEach(l => l(widthPx));
}

export function subscribeLeftWidth(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
