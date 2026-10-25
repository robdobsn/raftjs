# Raft Flasher

Flash a Raft app to an ESP32 over USB from the browser (Chrome or Edge), with no tools installed. It's published on RaftCore's GitHub Pages site at `https://robdobsn.github.io/RaftCore/flash/`, built by RaftCore's `pages.yml` workflow.

Pick the project's `build/<SysType>` folder (or its `flasher_args.json` and `.bin` files), or give the URL of an ESP Web Tools manifest (also as `?manifest=<url>`). The flasher:

- writes what `raft flash` writes, where it writes it, from `flasher_args.json`;
- reads the partition table and the app's description (name, version, build date, ESP-IDF version), and checks each image fits its partition and the build is for the board's chip;
- writes everything, the firmware only (keeping the file system, as `raft flash --no-fs`), or the file system image only, optionally erasing the flash first;
- checks each image after writing it (MD5), then restarts the board.

```sh
npm install
npm start          # http://localhost:1234
npm run build      # dist/
```

It uses Espressif's [esptool-js](https://github.com/espressif/esptool-js). `src/flashImage.ts` reads a build (tested in `flashImage.test.ts`, run by raftjs's `npm test`), and `src/App.tsx` is the page.
