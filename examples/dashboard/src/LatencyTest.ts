import { mean, standardDeviation } from 'simple-statistics';
import { DeviceAttributeState } from '../../../src/RaftDeviceStates';
import SettingsManager from './SettingsManager';

class LatencyTest {
  private static instance: LatencyTest;

  private lastWhiteTime: number | null = null;
  private lastBlackTime: number | null = null;
  private lastAttrValue: number | null = null;

  private latencyRecords: { type: 'white' | 'black'; latency: number }[] = [];
  private latencyWindowSize: number = 10;
  private sampleCounter: number = 0;

  // Singleton access
  static getInstance(): LatencyTest {
    if (!LatencyTest.instance) {
      LatencyTest.instance = new LatencyTest();
    }
    return LatencyTest.instance;
  }

  // Get abruptChangeThreshold
  private get abruptChangeThreshold(): number {
    const settingsManager = SettingsManager.getInstance();
    return settingsManager.getSetting('latencyChangeThreshold') || 50;
  }

  // Record color change time
  recordColorChange(color: 'white' | 'black', timestamp: number): void {
    if (color === 'white') {
      this.lastWhiteTime = timestamp;
      this.lastBlackTime = null;
    } else if (color === 'black') {
      this.lastBlackTime = timestamp;
      this.lastWhiteTime = null;
    }
    // console.log(`Color change recorded: ${color} at ${timestamp}`);
  }

  // Process values
  processAttrValues(attribute: DeviceAttributeState, timestamp: number): void {
    for (let i = 0; i < attribute.numNewValues; i++) {
      const newValue = attribute.values[attribute.values.length - attribute.numNewValues + i];
      if (typeof newValue !== 'number') continue;
      // console.log(`New value: ${newValue} prev value: ${this.lastAttrValue}`);
      if (this.lastAttrValue === null) {
        this.lastAttrValue = newValue;
        return;
      }
      this.sampleCounter++;

      // Calculate change and update last value
      const change = newValue - this.lastAttrValue;
      this.lastAttrValue = newValue;

      // Check size of change - needs to be above threshold
      if (Math.abs(change) < this.abruptChangeThreshold) {
        continue;
      }

      // console.log(`[${new Date().toISOString()}] new ${newValue} chg ${Math.abs(change)} >thresh ${Math.abs(change) >= this.abruptChangeThreshold} ${this.sampleCounter}`);

      // Skip invalid changes (in the wrong direction) - also skips repeated values
      // since lastWhiteTime and lastBlackTime are cleared after a change
      if ((change >= 0 && this.lastWhiteTime === null) || (change < 0 && this.lastBlackTime === null)) {
        // console.log(`Invalid change detected: ${change} lastWhite ${this.lastWhiteTime} lastBlack ${this.lastBlackTime}`);
        continue;
      }

      // console.log(
      //   `[${new Date().toISOString()}] ${newValue} ${this.lastAttrValue} ${change} ${Math.abs(change)} ${this.abruptChangeThreshold} ${Math.abs(change) >= this.abruptChangeThreshold} ${this.sampleCounter} ${this.lastTriggerIndex}`
      // );

      // console.log(`Sample counter = ${this.sampleCounter} Last trigger index = ${this.lastTriggerIndex} Diff = ${this.sampleCounter - this.lastTriggerIndex}`);

      // Detect abrupt change with threshold
      if (Math.abs(change) >= this.abruptChangeThreshold) {
        const eventType = change > 0 ? 'white' : 'black';
        const relatedTime =
          eventType === 'white' ? this.lastWhiteTime : this.lastBlackTime;

        if (relatedTime !== null) {
          const latency = timestamp - relatedTime;
          this.latencyRecords.push({ type: eventType, latency });
          if (this.latencyRecords.length > this.latencyWindowSize) {
            this.latencyRecords.shift();
          }

          // console.log(
          //   `[${new Date().toISOString()}] Triggered: ${eventType} change ${change} detected. Last white time = ${this.lastWhiteTime} Last black time = ${this.lastBlackTime} Latency = ${latency} ms`
          // );
        }
      }

      // Clear timers of change
      this.lastWhiteTime = null;
      this.lastBlackTime = null;
    }
  }

  // Get latency stats
  getLatencyStats(): {
    meanLatency: number | null;
    stdDevLatency: number | null;
    records: { type: 'white' | 'black'; latency: number }[];
  } {
    if (this.latencyRecords.length === 0) {
      return {
        meanLatency: null,
        stdDevLatency: null,
        records: [],
      };
    }

    const latencies = this.latencyRecords.map((record) => record.latency);
    const meanLatency = mean(latencies);
    const stdDevLatency = standardDeviation(latencies);

    // console.log(`Mean latency: ${meanLatency} ms, Std Dev: ${stdDevLatency} ms Num records: ${this.latencyRecords.length}`);

    return {
      meanLatency,
      stdDevLatency,
      records: this.latencyRecords,
    };
  }
}

export default LatencyTest;
