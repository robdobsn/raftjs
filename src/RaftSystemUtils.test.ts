import RaftSystemUtils from './RaftSystemUtils';
import RaftMsgHandler from './RaftMsgHandler';
import { RaftWifiConnState } from './RaftWifiTypes';

// RaftSystemUtils with a message handler that answers sysmodinfo/NetMan with the given response
function utilsAnswering(resp: object): RaftSystemUtils {
  const msgHandler = {
    sendRICRESTURL: jest.fn(async (url: string) => {
      expect(url).toBe('sysmodinfo/NetMan');
      return resp;
    }),
  } as unknown as RaftMsgHandler;
  return new RaftSystemUtils(msgHandler);
}

describe('getWiFiConnStatus', () => {
  // As sent by an ESP32-S3 with current RaftCore (captured from a device)
  const connected = {
    rslt: 'ok', v: '0.1.5', hostname: 'Axiom0182cc23e',
    wifiSTA: { conn: 1, SSID: 'homenet', MAC: 'dc:b4:d9:2c:c2:3c', RSSI: -75, IP: '192.168.86.136' },
  };

  it('reads the wifiSTA object of current firmware when connected', async () => {
    const utils = utilsAnswering(connected);
    expect(await utils.getWiFiConnStatus()).toBe(true);
    const status = utils.getCachedWifiStatus();
    expect(status.connState).toBe(RaftWifiConnState.WIFI_CONN_CONNECTED);
    expect(status.isPaused).toBe(false);
    expect(status.ipAddress).toBe('192.168.86.136');
    expect(status.hostname).toBe('Axiom0182cc23e');
    expect(status.ssid).toBe('homenet');
    expect(status.bssid).toBe('dc:b4:d9:2c:c2:3c');
    expect(status.validMs).toBeGreaterThan(0);
  });

  it('reports not connected when current firmware is not connected', async () => {
    // (as sent by a device with no WiFi credentials)
    const utils = utilsAnswering({
      rslt: 'ok', v: '1', hostname: 'TinyS3Test4f4322',
      wifiSTA: { conn: 0, SSID: '', MAC: 'f4:12:fa:4f:43:20' },
    });
    expect(await utils.getWiFiConnStatus()).toBe(false);
    const status = utils.getCachedWifiStatus();
    expect(status.connState).toBe(RaftWifiConnState.WIFI_CONN_NONE);
    expect(status.isPaused).toBe(false);
    expect(status.ipAddress).toBe('');
    expect(status.hostname).toBe('TinyS3Test4f4322');
  });

  it('reports paused when current firmware has WiFi paused', async () => {
    const utils = utilsAnswering({
      rslt: 'ok', hostname: 'h',
      wifiSTA: { conn: 1, SSID: 'homenet', MAC: 'aa', RSSI: -60, IP: '10.0.0.2', paused: 1 },
    });
    expect(await utils.getWiFiConnStatus()).toBe(true);
    expect(utils.getCachedWifiStatus().isPaused).toBe(true);
  });

  it('reports not connected when there is no WiFi station info', async () => {
    const utils = utilsAnswering({ rslt: 'ok', hostname: 'h' });
    expect(await utils.getWiFiConnStatus()).toBe(false);
    expect(utils.getCachedWifiStatus().connState).toBe(RaftWifiConnState.WIFI_CONN_NONE);
  });

  it('still reads the top-level fields of older firmware', async () => {
    const utils = utilsAnswering({
      rslt: 'ok', isConn: 1, isPaused: 0, connState: 'WiFiAndIP', SSID: 'old', IP: '10.0.0.3',
      Hostname: 'oldhost', WiFiMAC: '11:22:33:44:55:66',
    });
    expect(await utils.getWiFiConnStatus()).toBe(true);
    const status = utils.getCachedWifiStatus();
    expect(status.connState).toBe(RaftWifiConnState.WIFI_CONN_CONNECTED);
    expect(status.ipAddress).toBe('10.0.0.3');
    expect(status.hostname).toBe('oldhost');
    expect(status.ssid).toBe('old');
    expect(status.bssid).toBe('11:22:33:44:55:66');

    const off = utilsAnswering({ rslt: 'ok', isConn: 0, isPaused: 0, SSID: '', IP: '', Hostname: 'oldhost', WiFiMAC: '' });
    expect(await off.getWiFiConnStatus()).toBe(false);
    expect(off.getCachedWifiStatus().connState).toBe(RaftWifiConnState.WIFI_CONN_NONE);
  });

  it('returns null when the request fails', async () => {
    const msgHandler = {
      sendRICRESTURL: jest.fn(async () => { throw new Error('timeout'); }),
    } as unknown as RaftMsgHandler;
    const utils = new RaftSystemUtils(msgHandler);
    expect(await utils.getWiFiConnStatus()).toBeNull();
    expect(utils.getCachedWifiStatus().validMs).toBe(0);
  });
});
