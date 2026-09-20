// RaftSystemUtils.wifiScan() against current firmware (scan status object) and older firmware
// (RaftCore 1.54.1 and earlier - results fail while the scan is in progress)
import RaftSystemUtils from '../src/RaftSystemUtils';
import RaftMsgHandler from '../src/RaftMsgHandler';
import { RaftWifiScanProgress } from '../src/RaftTypes';

const AP = { ssid: 'rd01', rssi: -66, ch1: 6, ch2: 0, auth: 'WPA2_PSK', bssid: 'aa:aa:9a:17:89:bb', pair: 'CCMP', group: 'CCMP' };

// Mock message handler which replies with the next scripted response for each URL (the last one repeats)
// A response of 'hang' never completes (as when the link to the device is unresponsive)
function makeSystemUtils(script: { [url: string]: Array<object | Error | 'hang'> }) {
    const sent: string[] = [];
    const msgTimeouts: Array<number | undefined> = [];
    const msgHandler = {
        sendRICRESTURL: async (url: string, _bridgeID?: number, msgTimeoutMs?: number) => {
            sent.push(url);
            msgTimeouts.push(msgTimeoutMs);
            const responses = script[url];
            const resp = responses.length > 1 ? responses.shift() : responses[0];
            if (resp === 'hang')
                return new Promise(() => undefined);
            if (resp instanceof Error)
                throw resp;
            return resp;
        },
    };
    return { systemUtils: new RaftSystemUtils(msgHandler as unknown as RaftMsgHandler), sent, msgTimeouts };
}

const FAST = { pollIntervalMs: 1, timeoutMs: 500 };

describe('wifiScan current firmware', () => {
    test('polls while scanning then returns results', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 3, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': [
                { req: 'wifiscan/results', scan: { state: 'scanning', id: 3, elapsedMs: 10 }, wifi: [], rslt: 'ok' },
                { req: 'wifiscan/results', scan: { state: 'scanning', id: 3, elapsedMs: 20 }, wifi: [], rslt: 'ok' },
                { req: 'wifiscan/results', scan: { state: 'done', id: 3, durMs: 25, ageMs: 1, count: 1, found: 1, new: 0, lost: 0 }, wifi: [{ ...AP, new: 0 }], rslt: 'ok' },
            ],
        });
        const progress: RaftWifiScanProgress[] = [];
        const outcome = await systemUtils.wifiScan({ ...FAST, onProgress: (p) => progress.push(p) });
        expect(outcome.ok).toBe(true);
        expect(outcome.legacyFirmware).toBe(false);
        expect(outcome.wifi).toEqual([{ ...AP, new: 0 }]);
        expect(outcome.scan?.id).toBe(3);
        expect(progress.length).toBe(2);
        expect(progress[0].scan?.state).toBe('scanning');
        expect(sent).toEqual(['wifiscan/start', 'wifiscan/results', 'wifiscan/results', 'wifiscan/results']);
    });

    test('previous scan results are provided as progress', async () => {
        const { systemUtils } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 2, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': [
                { req: 'wifiscan/results', scan: { state: 'scanning', id: 2, elapsedMs: 10, count: 1, found: 1, new: 0, lost: 0 }, wifi: [AP], rslt: 'ok' },
                { req: 'wifiscan/results', scan: { state: 'done', id: 2, durMs: 25, ageMs: 1, count: 0, found: 0, new: 0, lost: 1 }, wifi: [], rslt: 'ok' },
            ],
        });
        const progress: RaftWifiScanProgress[] = [];
        const outcome = await systemUtils.wifiScan({ ...FAST, onProgress: (p) => progress.push(p) });
        expect(progress[0].prevScanWifi).toEqual([AP]);
        expect(outcome.ok).toBe(true);
        expect(outcome.wifi).toEqual([]);
    });

    test('retries start while busy', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            'wifiscan/start': [
                { req: 'wifiscan/start', scan: { state: 'failed', id: 1, durMs: 0, ageMs: 0, err: 'busy (STA connecting)' }, rslt: 'fail' },
                { req: 'wifiscan/start', scan: { state: 'scanning', id: 2, elapsedMs: 0 }, rslt: 'ok' },
            ],
            'wifiscan/results': [{ req: 'wifiscan/results', scan: { state: 'done', id: 2, durMs: 25, ageMs: 1, count: 1, found: 1, new: 0, lost: 0 }, wifi: [AP], rslt: 'ok' }],
        });
        const outcome = await systemUtils.wifiScan(FAST);
        expect(outcome.ok).toBe(true);
        expect(sent.filter((url) => url === 'wifiscan/start').length).toBe(2);
    });

    test('start failure other than busy is not retried', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'failed', id: 1, durMs: 0, ageMs: 0, err: 'ESP_ERR_WIFI_NOT_STARTED' }, rslt: 'fail' }],
        });
        const outcome = await systemUtils.wifiScan(FAST);
        expect(outcome).toMatchObject({ ok: false, error: 'ESP_ERR_WIFI_NOT_STARTED', legacyFirmware: false });
        expect(sent).toEqual(['wifiscan/start']);
    });

    test('scan failure is reported', async () => {
        const { systemUtils } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 1, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': [{ req: 'wifiscan/results', scan: { state: 'failed', id: 1, durMs: 5, ageMs: 1, err: 'abandoned' }, wifi: [], rslt: 'ok' }],
        });
        const outcome = await systemUtils.wifiScan(FAST);
        expect(outcome).toMatchObject({ ok: false, error: 'abandoned', wifi: [] });
    });

    test('device restart during scan is reported', async () => {
        const { systemUtils } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 4, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': [{ req: 'wifiscan/results', scan: { state: 'idle', id: 0 }, wifi: [], rslt: 'ok' }],
        });
        const outcome = await systemUtils.wifiScan(FAST);
        expect(outcome).toMatchObject({ ok: false, error: 'scan lost' });
    });

    test('lost messages are tolerated and timeout is reported', async () => {
        const { systemUtils } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 1, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': [new Error('msg timeout')],
        });
        const outcome = await systemUtils.wifiScan({ pollIntervalMs: 1, timeoutMs: 30 });
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toContain('timeout');
    });

    test('messages are not automatically retried during the operation', async () => {
        // A retried start arriving just after the scan completes would start another scan
        const { systemUtils, msgTimeouts } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 1, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': [{ req: 'wifiscan/results', scan: { state: 'done', id: 1, durMs: 5, ageMs: 1, count: 1, found: 1, new: 0, lost: 0 }, wifi: [AP], rslt: 'ok' }],
        });
        await systemUtils.wifiScan({ pollIntervalMs: 1, timeoutMs: 12000 });
        expect(msgTimeouts).toEqual([12000, 12000]);
    });

    test('overall timeout applies when the link is unresponsive', async () => {
        const noStartResp = makeSystemUtils({ 'wifiscan/start': ['hang'] });
        const outcome1 = await noStartResp.systemUtils.wifiScan({ pollIntervalMs: 1, timeoutMs: 30 });
        expect(outcome1.ok).toBe(false);
        expect(outcome1.error).toContain('no response');
        expect(noStartResp.sent).toEqual(['wifiscan/start']);

        const noResultsResp = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 1, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': ['hang'],
        });
        const outcome2 = await noResultsResp.systemUtils.wifiScan({ pollIntervalMs: 1, timeoutMs: 30 });
        expect(outcome2.ok).toBe(false);
        expect(outcome2.error).toContain('timeout');
        expect(noResultsResp.sent).toEqual(['wifiscan/start', 'wifiscan/results']);
    });

    test('concurrent calls share one scan', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 1, elapsedMs: 0 }, rslt: 'ok' }],
            'wifiscan/results': [{ req: 'wifiscan/results', scan: { state: 'done', id: 1, durMs: 5, ageMs: 1, count: 1, found: 1, new: 0, lost: 0 }, wifi: [AP], rslt: 'ok' }],
        });
        const [outcome1, outcome2] = await Promise.all([systemUtils.wifiScan(FAST), systemUtils.wifiScan(FAST)]);
        expect(outcome1).toBe(outcome2);
        expect(sent).toEqual(['wifiscan/start', 'wifiscan/results']);
    });
});

describe('wifiScan resumeWifiIfPaused', () => {
    const SCAN_OK = {
        'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'scanning', id: 1, elapsedMs: 0 }, rslt: 'ok' }],
        'wifiscan/results': [{ req: 'wifiscan/results', scan: { state: 'done', id: 1, durMs: 5, ageMs: 1, count: 1, found: 1, new: 0, lost: 0 }, wifi: [AP], rslt: 'ok' }],
    };
    const PAUSE_OK = {
        'wifipause/resume': [{ req: 'wifipause/resume', isPaused: 0, rslt: 'ok' }],
        'wifipause/pause': [{ req: 'wifipause/pause', isPaused: 1, rslt: 'ok' }],
    };

    test('paused WiFi is resumed for the scan and paused again afterwards', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            ...SCAN_OK, ...PAUSE_OK,
            'wifipause/status': [{ req: 'wifipause/status', isPaused: 1, rslt: 'ok' }],
        });
        const outcome = await systemUtils.wifiScan({ ...FAST, resumeWifiIfPaused: true });
        expect(outcome).toMatchObject({ ok: true, wifi: [AP], wifiResumed: true });
        expect(sent).toEqual(['wifipause/status', 'wifipause/resume', 'wifiscan/start', 'wifiscan/results', 'wifipause/pause']);
    });

    test('WiFi is paused again when the scan fails', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            ...PAUSE_OK,
            'wifipause/status': [{ req: 'wifipause/status', isPaused: 1, rslt: 'ok' }],
            'wifiscan/start': [{ req: 'wifiscan/start', scan: { state: 'failed', id: 1, durMs: 0, ageMs: 0, err: 'ESP_ERR_WIFI_NOT_STARTED' }, rslt: 'fail' }],
        });
        const outcome = await systemUtils.wifiScan({ ...FAST, resumeWifiIfPaused: true });
        expect(outcome).toMatchObject({ ok: false, wifiResumed: true });
        expect(sent).toEqual(['wifipause/status', 'wifipause/resume', 'wifiscan/start', 'wifipause/pause']);
    });

    test('WiFi which is not paused is left alone', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            ...SCAN_OK,
            'wifipause/status': [{ req: 'wifipause/status', isPaused: 0, rslt: 'ok' }],
        });
        const outcome = await systemUtils.wifiScan({ ...FAST, resumeWifiIfPaused: true });
        expect(outcome.ok).toBe(true);
        expect(outcome.wifiResumed).toBeUndefined();
        expect(sent).toEqual(['wifipause/status', 'wifiscan/start', 'wifiscan/results']);
    });

    test('unknown pause state is left alone', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            ...SCAN_OK,
            'wifipause/status': [new Error('msg timeout')],
        });
        const outcome = await systemUtils.wifiScan({ ...FAST, resumeWifiIfPaused: true });
        expect(outcome.ok).toBe(true);
        expect(sent).toEqual(['wifipause/status', 'wifiscan/start', 'wifiscan/results']);
    });

    test('pause state is not touched without the option', async () => {
        const { systemUtils, sent } = makeSystemUtils(SCAN_OK);
        await systemUtils.wifiScan(FAST);
        expect(sent).toEqual(['wifiscan/start', 'wifiscan/results']);
    });
});

describe('wifiScan older firmware', () => {
    test('fail results mean in progress and results are read only once', async () => {
        const { systemUtils, sent } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', rslt: 'ok' }],
            'wifiscan/results': [
                { req: 'wifiscan/results', rslt: 'fail' },
                { req: 'wifiscan/results', rslt: 'fail' },
                { req: 'wifiscan/results', wifi: [AP], rslt: 'ok' },
                { req: 'wifiscan/results', wifi: [], rslt: 'ok' },
            ],
        });
        const progress: RaftWifiScanProgress[] = [];
        const outcome = await systemUtils.wifiScan({ ...FAST, onProgress: (p) => progress.push(p) });
        expect(outcome).toEqual({ ok: true, wifi: [AP], legacyFirmware: true });
        expect(progress.length).toBe(2);
        expect(progress[0]).toMatchObject({ legacyFirmware: true, prevScanWifi: [] });
        expect(progress[0].scan).toBeUndefined();
        expect(sent.filter((url) => url === 'wifiscan/results').length).toBe(3);
    });

    test('unexplained start failure is retried', async () => {
        const { systemUtils } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', rslt: 'fail' }, { req: 'wifiscan/start', rslt: 'ok' }],
            'wifiscan/results': [{ req: 'wifiscan/results', wifi: [AP], rslt: 'ok' }],
        });
        const outcome = await systemUtils.wifiScan(FAST);
        expect(outcome).toEqual({ ok: true, wifi: [AP], legacyFirmware: true });
    });

    test('never-ready results time out', async () => {
        const { systemUtils } = makeSystemUtils({
            'wifiscan/start': [{ req: 'wifiscan/start', rslt: 'ok' }],
            'wifiscan/results': [{ req: 'wifiscan/results', rslt: 'fail' }],
        });
        const outcome = await systemUtils.wifiScan({ pollIntervalMs: 1, timeoutMs: 30 });
        expect(outcome).toMatchObject({ ok: false, error: 'timeout', legacyFirmware: true });
    });
});

describe('wifiScanStart / wifiScanResults', () => {
    test('wifiScanStart reflects rslt', async () => {
        const ok = makeSystemUtils({ 'wifiscan/start': [{ req: 'wifiscan/start', rslt: 'ok' }] });
        expect(await ok.systemUtils.wifiScanStart()).toBe(true);
        const fail = makeSystemUtils({ 'wifiscan/start': [{ req: 'wifiscan/start', rslt: 'fail' }] });
        expect(await fail.systemUtils.wifiScanStart()).toBe(false);
    });

    test('pauseWifiConnection returns true on success and false on failure', async () => {
        const ok = makeSystemUtils({
            'wifipause/pause': [{ req: 'wifipause/pause', isPaused: 1, rslt: 'ok' }],
            'wifipause/resume': [{ req: 'wifipause/resume', isPaused: 0, rslt: 'ok' }],
        });
        expect(await ok.systemUtils.pauseWifiConnection(true)).toBe(true);
        expect(await ok.systemUtils.pauseWifiConnection(false)).toBe(true);
        expect(ok.sent).toEqual(['wifipause/pause', 'wifipause/resume']);
        const failed = makeSystemUtils({ 'wifipause/pause': [{ req: 'wifipause/pause', rslt: 'fail' }] });
        expect(await failed.systemUtils.pauseWifiConnection(true)).toBe(false);
        const noComms = makeSystemUtils({ 'wifipause/pause': [new Error('msg timeout')] });
        expect(await noComms.systemUtils.pauseWifiConnection(true)).toBe(false);
    });

    test('wifiScanResults returns false on comms failure', async () => {
        const { systemUtils } = makeSystemUtils({ 'wifiscan/results': [new Error('msg timeout')] });
        expect(await systemUtils.wifiScanResults()).toBe(false);
    });
});
