# Device identity fields: what to use (raftjs 2.6)

For WebUI, dashboard and app authors. raftjs 2.6 adds fields that each hold one thing. Three older fields held
different things depending on the firmware and the message format. The older fields keep their current
values, so nothing breaks. They are marked `@deprecated` and will change meaning only at a major version.

## Use these

| Field | Holds | Notes |
|---|---|---|
| `DeviceState.displayName` | The name to show for the device: its device name if it has one, otherwise the type display name and the device ID (e.g. `Accelerometer & Gyroscope 1_68`) | From the firmware's `displayName` (firmware from 2026-10-16); derived by the same rule for older firmware |
| `DeviceState.deviceName` | The device name set with `devman/setname` (or the configuration), `""` if none | |
| `DeviceState.deviceTypeKey` | The device type key, e.g. `MPU6050` | The firmware's `deviceTypeKey`, or `devinfo.type` for older firmware (which differs from the key in two Robotical records) |
| `DeviceState.busNum` | The bus number (0 for a directly connected device) | |
| `DeviceTypeInfo.typeDisplayName` | The type display name (`devInfoJson.name`), e.g. `Accelerometer & Gyroscope` | Never replaced by the device name |
| `DeviceTypeInfo.deviceTypeKey` | The device type key | |

`DeviceManager.getDeviceDisplayName(deviceKey)` returns the display name for any device key.

## Instead of these (deprecated, unchanged)

| Field | What it holds today | Use instead |
|---|---|---|
| `DeviceTypeInfo.name` | The type display name, **or the device name if one is set** (it overwrites it) | `typeDisplayName` for the type; `DeviceState.displayName` or `deviceName` for the device |
| `DeviceState.deviceType` | devbin: the same value as `DeviceTypeInfo.name`. devjson: the device type index (`_i`), or the key from very old firmware | `deviceTypeKey`, `displayName` |
| `DeviceState.busName` | The bus number as a string, not the bus name | `busNum` |

## Names change while connected

- `setDeviceName()` and `setDeviceRole()` (with `save` to keep the change over a restart) update the cached
  data and the device's state at once. Before this, a new name was only seen after a reload.
- `addDeviceNameChangedCallback((deviceKey, state) => ...)` is called when a known device's `displayName` or
  `deviceName` changes. This happens after a `setDeviceName`, or when the device is identified as another type.

## REST

To name a device type, use `deviceTypeKey=` or `deviceTypeIndex=`. The older `type=` (key or index) is still
accepted. See the DeviceManager REST API page on the RaftCore wiki.
