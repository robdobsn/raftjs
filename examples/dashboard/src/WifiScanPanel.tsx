import React, { useEffect, useRef, useState } from 'react';
import './styles.css';
import {
  RaftWifiScanOutcome,
  RaftWifiScanProgress,
  RaftWifiScanStatus,
  WifiScanWifiItem,
} from "../../../src/main";
import ConnManager from "./ConnManager";

const connManager = ConnManager.getInstance();

function formatScanStatus(scan: RaftWifiScanStatus | undefined): string {
  if (!scan)
    return "no scan status (older firmware)";
  let str = `${scan.state} id ${scan.id}`;
  if (scan.elapsedMs !== undefined)
    str += ` elapsed ${scan.elapsedMs}ms`;
  if (scan.durMs !== undefined)
    str += ` took ${scan.durMs}ms`;
  if (scan.err !== undefined)
    str += ` err "${scan.err}"`;
  if (scan.count !== undefined)
    str += ` count ${scan.count} found ${scan.found} new ${scan.new} lost ${scan.lost}`;
  return str;
}

export default function WifiScanPanel() {
  const [scanning, setScanning] = useState(false);
  const [scanStartMs, setScanStartMs] = useState(0);
  const [scanElapsedMs, setScanElapsedMs] = useState(0);
  const [resumeWifiIfPaused, setResumeWifiIfPaused] = useState(true);
  const [statusText, setStatusText] = useState("");
  const [statusIsError, setStatusIsError] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [wifiList, setWifiList] = useState<WifiScanWifiItem[]>([]);
  const [wifiListIsPrevious, setWifiListIsPrevious] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Elapsed time while scanning - progress callbacks can't be relied on for this as a WiFi
  // connection to the device is unresponsive for the duration of the scan
  useEffect(() => {
    if (!scanning)
      return;
    const interval = setInterval(() => setScanElapsedMs(Date.now() - scanStartMs), 100);
    return () => clearInterval(interval);
  }, [scanning, scanStartMs]);

  // Keep the log scrolled to the latest line
  useEffect(() => {
    if (logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const handleScan = async () => {
    const systemUtils = connManager.getConnector().getRaftSystemUtils();
    const startMs = Date.now();
    const log = (line: string) => {
      if (mountedRef.current)
        setLogLines((prev) => [...prev, `${((Date.now() - startMs) / 1000).toFixed(2)}s ${line}`]);
    };
    setScanStartMs(startMs);
    setScanElapsedMs(0);
    setScanning(true);
    setStatusIsError(false);
    setStatusText("");
    setLogLines([]);

    // WiFi is paused by the firmware while BLE is connected and a scan can't be started while paused
    // so wifiScan can resume it for the scan and pause it again afterwards
    log("wifiScan started");
    const outcome: RaftWifiScanOutcome = await systemUtils.wifiScan({
      resumeWifiIfPaused,
      onProgress: (progress: RaftWifiScanProgress) => {
        if (!mountedRef.current)
          return;
        log(`progress: ${formatScanStatus(progress.scan)} prevScanWifi ${progress.prevScanWifi.length}`);
        setWifiList(progress.prevScanWifi);
        setWifiListIsPrevious(true);
      },
    });
    if (!mountedRef.current)
      return;

    if (outcome.wifiResumed)
      log("WiFi was paused - resumed for the scan and paused again");
    log(`${outcome.ok ? "complete" : "FAILED"}: ${outcome.error ? outcome.error + " - " : ""}${formatScanStatus(outcome.scan)}`);
    if (outcome.ok) {
      const scan = outcome.scan;
      setStatusText(`${outcome.wifi.length} access points` +
        (scan ? ` (${scan.found} found, ${scan.new} new, ${scan.lost} lost) in ${scan.durMs}ms` : " (older firmware)"));
      setWifiList(outcome.wifi);
      setWifiListIsPrevious(false);
    } else {
      // Leave any previous results showing
      setStatusIsError(true);
      setStatusText(`Scan failed: ${outcome.error}`);
    }
    setScanning(false);
  };

  return (
    <div className="wifi-scan-panel">
      <div className="wifi-scan-controls">
        <button className="action-button" onClick={handleScan} disabled={scanning}>
          {scanning ? `Scanning ... ${(scanElapsedMs / 1000).toFixed(1)}s` : "Scan WiFi"}
        </button>
        <label className="wifi-scan-option" title="WiFi is paused while BLE is connected and a scan can't be started while it is paused - if it is paused resume it for the scan and pause it again afterwards">
          <input
            type="checkbox"
            checked={resumeWifiIfPaused}
            disabled={scanning}
            onChange={(e) => setResumeWifiIfPaused(e.target.checked)}
          />
          Resume WiFi if paused
        </label>
      </div>
      {statusText !== "" &&
        <div className={statusIsError ? "logging-error" : "wifi-scan-status"}>{statusText}</div>
      }
      {logLines.length > 0 &&
        <div className="wifi-scan-log" ref={logRef}>
          {logLines.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      }
      {wifiList.length > 0 &&
        <div className={"wifi-scan-list" + (wifiListIsPrevious ? " wifi-scan-list-previous" : "")}>
          {wifiListIsPrevious && <div className="wifi-scan-list-note">Previous scan results</div>}
          {wifiList.map((ap) => (
            <div className="wifi-scan-item" key={ap.bssid} title={`${ap.bssid} pair ${ap.pair} group ${ap.group}`}>
              <span className="wifi-scan-ssid">{ap.ssid !== "" ? ap.ssid : "(hidden)"}</span>
              {ap.new === 1 && <span className="wifi-scan-new">NEW</span>}
              <span className="wifi-scan-detail">{ap.rssi}dBm ch{ap.ch1} {ap.auth}</span>
            </div>
          ))}
        </div>
      }
    </div>
  );
}
