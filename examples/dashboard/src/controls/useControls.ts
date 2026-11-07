/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// useControls
// React hooks for the control directory and bindings: re-render when control sources come, go or change online
// state, or when bindings change.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { useEffect, useState } from 'react';
import { ControlDirectory } from './ControlDirectory';
import { BindingManager, Binding } from './BindingManager';
import { ControlKind, ControlSource } from './ControlTypes';

// Control sources of the given kinds
export function useControlSources(kinds?: ControlKind[]): ControlSource[] {
    const [, setVersion] = useState(0);
    useEffect(() => ControlDirectory.subscribe(() => setVersion(v => v + 1)), []);
    return ControlDirectory.getSources(kinds);
}

// Bindings that drive a target device
export function useBindingsForTarget(targetKey: string): Binding[] {
    const [, setVersion] = useState(0);
    useEffect(() => BindingManager.subscribe(() => setVersion(v => v + 1)), []);
    return BindingManager.bindingsForTarget(targetKey);
}
