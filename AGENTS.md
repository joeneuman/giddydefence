# hello-board — agent guide

This is a Board web game. Board is a 23.8" 1080p touch-display gaming console
that tracks physical Pieces on the screen alongside finger touches. The game
runs in a WebView on the device; the `@board.fun/web-sdk` package wraps the
JavaScript bridges the OS injects.

The canonical SDK guide for coding agents ships with the SDK package — read
`node_modules/@board.fun/web-sdk/AGENTS.md` for the full API surface, critical
constraints, and common patterns. Human docs: https://docs.dev.board.fun/

Project facts:

- `npm run dev` previews in a browser (`Board.isOnDevice` is false there; the
  starter fakes a finger contact from the pointer).
- `npm run pack` builds and packs `hello-board.webapp.zip` for the device. It
  requires `public/model.tflite` (downloaded from https://dev.board.fun, never
  committed or fetched at runtime).
- `vite.config.ts` sets `base: "./"`. Do not remove it: root-absolute asset
  URLs white-screen on the device.
- `board.config.json` carries the game's `packageId` and (after the first pack)
  its `appId`. Commit it; the appId scopes saves on the device.
- Deploy and observe with the `board-connect` CLI: `install <zip> --launch`,
  `logs <appId> --follow`, `screenshot --out shot.png`.
