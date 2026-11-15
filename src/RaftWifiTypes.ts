/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftWifiTypes
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export enum RaftWifiConnState {
  WIFI_CONN_NONE,
  WIFI_CONN_CONNECTED,
}

export class RaftWifiConnStatus {
  connState = RaftWifiConnState.WIFI_CONN_NONE;
  isPaused = false;
  ipAddress = '';
  hostname = '';
  ssid = '';
  bssid = '';
  validMs = 0;
}

// Response to sysmodinfo/NetMan. Current firmware (RaftCore's NetworkSystem) sends the hostname and a
// wifiSTA object; older firmware sent the fields at the top level. All fields are optional as a result.
export type RaftSysModInfoWiFiSTA = {
  conn?: number;      // 1 if connected with an IP address
  SSID?: string;
  MAC?: string;
  RSSI?: number;
  IP?: string;
  paused?: number;    // present (1) only while WiFi is paused
};

export class RaftSysModInfoWiFi {
  rslt = 'ok';
  // Current firmware
  hostname?: string;
  wifiSTA?: RaftSysModInfoWiFiSTA;
  // Older firmware
  isConn?: number;
  isPaused?: number;
  connState?: string;
  SSID?: string;
  IP?: string;
  Hostname?: string;
  WiFiMAC?: string;
}
