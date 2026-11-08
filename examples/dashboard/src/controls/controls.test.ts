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

test('touch tracking: a fast single-touch swipe stays one touch, two touches are matched by position', () => {
    const src = new TouchStripSource('1_37', 'Touch', { n: 'loc', t: '<H[2]', vt: 'touchstrip' } as any, undefined, 65535, 3584, undefined, 15);
    const evs: Pos1DEvent[] = [];
    src.addListener(e => evs.push(e as Pos1DEvent));
    // one touch jumps from the start to the end; then a second touch joins; the first lifts
    feed2(src, [[0, 65535], [3584, 65535], [3584, 500], [65535, 520]]);
    expect(evs.map(e => [e.started.length, e.moved.length, e.ended.length])).toEqual([[1,0,0],[0,1,0],[1,0,0],[0,1,1]]);
    const firstId = evs[0].started[0].id;
    expect(evs[1].moved[0].id).toBe(firstId);
    expect(evs[3].ended[0].id).toBe(firstId);
    expect(evs[3].moved[0].id).toBe(evs[2].started[0].id);
});

function feed2(src: TouchStripSource, samples: number[][]) {
    src.handleDecoded({ deviceKey: '1_37', busName: '1', deviceAddress: '37', deviceType: 'x', attrValues: { loc: samples.flat() }, timestampsUs: samples.map((_, i) => i * 50000) } as any);
}

function run(modeId: string, locs: number[], params: Record<string, any> = { scale: 'major', lowNote: 48, notes: 15, reverse: false }) {
    const src = new TouchStripSource('1_37', 'Touch', attr, 'size', 65535, 3584, 765, 15);
    const sent: string[] = [];
    const runner = BindingManager.getMode(modeId)!.createRunner({ source: src, targetKey: '0_0', params,
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

test('bend mode', () => {
    // touch at the middle, slide a quarter of the strip up (half the range), then past the end (clamped), lift
    // bending notes held elsewhere: lifting returns to pitch
    expect(run('bend', [1792, 2688, 3584, 65535], { play: false, range: 200, reverse: false })).toEqual(['bend(100)', 'bend(200)', 'bend(0)']);
    // playing its own note (middle of 15 notes of C major from C3 = C4): bend kept until the next touch resets it
    expect(run('bend', [1792, 2688, 65535, 0, 65535], { play: true, range: 200, scale: 'major', lowNote: 48, notes: 15, reverse: false }))
        .toEqual(['noteOn(60)', 'bend(100)', 'noteOff(60)', 'bend(0)', 'noteOn(48)', 'noteOff(48)']);
});

test('expression mode', () => {
    expect(run('expression', [0, 1792, 3584, 65535], { target: 'vibrato', reverse: false })).toEqual(['vibrato(0)', 'vibrato(50)', 'vibrato(100)']);
});
