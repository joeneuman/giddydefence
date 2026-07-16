# hello-board

A Board web game, scaffolded with `npm create @board.fun/game`. It draws every
finger and Piece the device reports, and wires the system pause menu so quitting
works out of the box.

## Setup

```bash
npm install
```

Then download the Piece Set Model for your game from https://dev.board.fun and
save it as `public/model.tflite`. Every Board web app bundles a model; without
one the device delivers no input frames. If your game has no Pieces yet, any
Piece Set Model enables finger input.

## Develop

```bash
npm run dev
```

Opens a browser preview with a pointer stand-in for touch. On a Board, the same
build receives real finger and Piece contacts.

## Run it on a Board

```bash
npm run pack
board-connect pair <board-ip>                       # once; tap Approve on the Board
board-connect install hello-board.webapp.zip --launch
board-connect logs <appId> --follow                 # appId is in board.config.json
```

`board-connect` is the Board CLI; install it from https://dev.board.fun. The
first pack mints a random `appId` and writes it to `board.config.json`. Commit
that file: the appId ties your app to its saves on the device.

## Learn more

- Build & deploy guide: https://docs.dev.board.fun/web/getting-started/build-and-deploy
- Input & Pieces: https://docs.dev.board.fun/guides/touch-input
- API reference: https://docs.dev.board.fun/web/reference/api
