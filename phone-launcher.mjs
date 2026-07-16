// Tiny LAN page with one job: launch Piece Defense on the Board from a phone.
// Run: node phone-launcher.mjs  (auto-started by the Startup-folder shortcut)
import { createServer } from "node:http";
import { execFile } from "node:child_process";

const APP_ID = "aaeaf789-920d-46a5-a714-26f1043feb65";
const PORT = 8787;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Piece Defense</title>
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; gap: 24px;
         align-items: center; justify-content: center; background: #141826;
         font-family: sans-serif; }
  button { font-size: 28px; font-weight: bold; padding: 36px 48px; border-radius: 14px;
           border: 3px solid #c9a227; background: #1d2540; color: #ffd43b; width: 80%;
           max-width: 420px; }
  button:active { background: #2a355c; }
  #msg { color: #99a6bf; font-size: 18px; min-height: 24px; }
</style>
</head>
<body>
<button onclick="go()">&#9889; LAUNCH PIECE DEFENSE</button>
<div id="msg"></div>
<script>
async function go() {
  const msg = document.getElementById("msg");
  msg.textContent = "Launching...";
  try {
    const r = await fetch("/launch", { method: "POST" });
    msg.textContent = r.ok ? "On the Board!" : "Failed: " + (await r.text());
  } catch (e) {
    msg.textContent = "Failed: " + e;
  }
}
</script>
</body>
</html>`;

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/launch") {
    execFile(
      "C:\\Users\\joe\\.local\\bin\\board-connect.exe",
      ["launch", APP_ID],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(String(stderr || err));
        } else {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("launched");
        }
      },
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
}).listen(PORT, () => {
  console.log(`phone launcher on http://0.0.0.0:${PORT}`);
});
