// Control directory touch tracking and the synth binding modes (Keys, Stylophone), with the connection mocked
jest.mock('../ConnManager', () => ({ __esModule: true, default: { getInstance: () => ({ getConnector: () => ({ getSystemType: () => undefined }) }) } }));
import { TouchStripSource } from './ControlDirectory';
import { BindingManager } from './BindingManager';
import './synthModes';
import { scaleNote } from './synthModes';
import { Pos1DEvent } from './ControlTypes';

const attr: any = { n: 'loc', t: '<H', vt: 'touchstrip' };
function feed(src: TouchStripSource, locs: number[]) {
    src.handleDecoded({ deviceKey: '1_37', busName: '1', deviceAddress: '37', deviceType: 'x', attrValues: { loc: locs, size: locs.map(l => l === 65535 ? 0 : 500) }, timestampsUs: locs.map((_, i) => i * 50000) } as any);
}

test('touch tracking', () => {
    const src = new TouchStripSource('1_37', 'Touch', attr, 'size', 65535, 3584, 765, 15);
    const evs: Pos1DEvent[] = [];
    src.addListener(e => evs.push(e as Pos1DEvent));
    feed(src, [65535, 0, 256, 512, 65535]);
    expect(evs.map(e => [e.started.length, e.moved.length, e.ended.length])).toEqual([[1,0,0],[0,1,0],[0,1,0],[0,0,1]]);
    expect(evs[0].started[0].pos).toBe(0);
    expect(evs[2].moved[0].id).toBe(evs[0].started[0].id);
    expect(evs[3].ended[0].pos).toBeCloseTo(512/3584);
});

function run(modeId: string, locs: number[]) {
    const src = new TouchStripSource('1_37', 'Touch', attr, 'size', 65535, 3584, 765, 15);
    const sent: string[] = [];
    const runner = BindingManager.getMode(modeId)!.createRunner({ source: src, targetKey: '0_0', params: { scale: 'major', lowNote: 48, notes: 15, reverse: false },
        send: (a, v) => { sent.push(`${a}(${v})`); } });
    src.addListener(e => runner.onEvent(e));
    feed(src, locs);
    runner.stop();
    return sent;
}

test('scale', () => {
    expect([0,1,2,3,4,5,6,7,14].map(s => scaleNote(48, 'major', s))).toEqual([48,50,52,53,55,57,59,60,72]);
});

test('keys mode', () => {
    // pad 0 (C3), pad 1 (D3), pad 1 again, release
    expect(run('keys', [0, 256, 260, 65535])).toEqual(['noteOn(48)', 'noteOff(48)', 'noteOn(50)', 'noteOff(50)']);
});

test('stylophone mode', () => {
    expect(run('stylophone', [0, 256, 512, 65535])).toEqual(['noteOn(48)', 'glide(50)', 'glide(52)', 'noteOff(52)']);
    // stop() while held releases the note
    expect(run('stylophone', [3584])).toEqual(['noteOn(72)', 'noteOff(72)']);
});
