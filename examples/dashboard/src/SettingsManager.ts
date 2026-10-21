export type Settings = {
  showCharts: boolean;
  maxChartDataPoints: number;
  maxDatapointsToStore: number;
  latencyTest: boolean;
  latencyAttributeName: string;
  latencyChangeThreshold: number;
  // Device types whose timeline charts are combined into one chart rather than split by units (keyed by
  // device type, e.g. "RoboAxiomPowerV1", so the choice follows the type wherever the device is attached)
  combinedChartTypes: string[];
};

class SettingsManager {
  private static instance: SettingsManager;
  private settings: Settings;
  private storageKey = "RaftJS_Settings";
  private maxChartDataPoints_default = 50;
  private maxDatapointsToStore_default = 1000;

  private constructor() {
    // Load settings from localStorage or use default values
    const savedSettings = localStorage.getItem(this.storageKey);
    // Saved settings are merged over the defaults so settings added since they were saved get a value
    this.settings = { ...this.defaultSettings(), ...(savedSettings ? JSON.parse(savedSettings) : {}) };
  }

  private defaultSettings(): Settings {
    return {
      latencyTest: false,
      showCharts: true,
      maxChartDataPoints: this.maxChartDataPoints_default,
      maxDatapointsToStore: this.maxDatapointsToStore_default,
      latencyAttributeName: "amb0",
      latencyChangeThreshold: 100,
      combinedChartTypes: [],
    };
  }

  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  getSetting<K extends keyof Settings>(key: K): Settings[K] {
    return this.settings[key];
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings[key] = value;
    this.saveSettings();
  }

  getAllSettings(): Settings {
    return this.settings;
  }

  // Save settings to localStorage
  private saveSettings(): void {
    localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
  }

  // Reset to default settings
  resetSettings(): void {
    this.settings = this.defaultSettings();
    this.saveSettings();
  }
}

export default SettingsManager;
