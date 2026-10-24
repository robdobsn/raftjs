# Raft Device Types

A web app for Raft device type records. You can:

- browse and search the catalogue;
- connect to a Raft device and see its device types;
- build and push its device type file (from RaftCore's records, GitHub sources and local record files);
- download the setup as a project's `DeviceTypeSources.json`, with its lock.

It's published on RaftCore's GitHub Pages site at `https://robdobsn.github.io/RaftCore/devtypes/app/`, built by RaftCore's `pages.yml` workflow. The design is in [devdocs/device-type-management-web-plan.md](../../devdocs/device-type-management-web-plan.md).

```sh
npm install        # in this folder (and npm install in raftjs, which the app is built from)
npm start          # http://localhost:1234
npm run build      # dist/
```

- **Catalogue:** the app reads it from the site it's served from (`.../devtypes/`), otherwise from RaftCore's Pages site. To use another catalogue, add `?catalogue=<url of a devtypes folder>`, e.g. one built with `AssembleDeviceTypes.py --pages` and served locally.
- **Connections:** Bluetooth and USB serial need Chrome or Edge and a secure page (`https` or `localhost`). WiFi (WebSocket) is offered only on `http` pages and `localhost`, because an `https` page can't open `ws://` to a device.
- **Logic:** all of it is in raftjs (`RaftDeviceTypeFile`, `RaftDeviceTypeSources`, `RaftDeviceTypeCatalogue` and `RaftDeviceTypeFileManager`), checked against the same test vectors as RaftCore's Python tools. `src/model.ts` holds the app's state, and the `*Panel.tsx` files are its views.
- **Storage:** the selection and any local record files are kept in this browser's local storage.
