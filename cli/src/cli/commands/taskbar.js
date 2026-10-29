/**
 * `9router taskbar` — launches the native Windows Taskbar Speed Monitor.
 * Displays real-time streaming speed (tokens/sec) and active model directly on the Taskbar.
 */

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function findCscCompiler() {
  const candidates = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveExePath() {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "bin", "9router-taskbar.exe"),
    path.join(__dirname, "..", "..", "..", "..", "dist", "9router-taskbar.exe"),
    path.join(process.cwd(), "dist", "9router-taskbar.exe"),
    path.join(process.cwd(), "cli", "bin", "9router-taskbar.exe"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // If not built yet, attempt to compile on-the-fly
  const sourcePath = path.join(__dirname, "..", "..", "..", "..", "tools", "taskbar-monitor", "TaskbarMonitor.cs");
  if (fs.existsSync(sourcePath)) {
    const csc = findCscCompiler();
    if (csc) {
      try {
        const outDir = path.join(__dirname, "..", "..", "..", "bin");
        fs.mkdirSync(outDir, { recursive: true });
        const outExe = path.join(outDir, "9router-taskbar.exe");
        const iconPath = path.join(__dirname, "..", "tray", "icon.ico");
        const iconArg = fs.existsSync(iconPath) ? `/win32icon:"${iconPath}"` : "";

        const cmd = `"${csc}" /target:winexe /optimize+ /platform:anycpu /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ${iconArg} /out:"${outExe}" "${sourcePath}"`;
        execSync(cmd, { stdio: "ignore" });
        if (fs.existsSync(outExe)) return outExe;
      } catch (e) {}
    }
  }

  return null;
}

async function run(args = []) {
  if (process.platform !== "win32") {
    console.log("ℹ️  Taskbar Speed Monitor is currently supported on Windows.");
    return 0;
  }

  let port = 20128;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[++i], 10) || 20128;
    }
  }

  const exePath = resolveExePath();
  if (!exePath) {
    console.error("❌ Cannot find or compile 9router-taskbar.exe.");
    console.error("   Run `node scripts/build-taskbar-monitor.mjs` first.");
    return 1;
  }

  let cliToken = "";
  try {
    const { getCliToken } = require("../api/client");
    cliToken = getCliToken() || "";
  } catch (e) {}

  try {
    const spawnArgs = ["--port", String(port)];
    if (cliToken) {
      spawnArgs.push("--token", cliToken);
    }

    const child = spawn(exePath, spawnArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    console.log("⚡ 9Router Taskbar Speed Monitor is running!");
    console.log(`   Connected to: http://127.0.0.1:${port}`);
    console.log("   • Left-drag: move widget anywhere");
    console.log("   • Double-click: open Console Log in browser");
    console.log("   • Right-click: context menu (snap to taskbar, lock, exit)\n");
    return 0;
  } catch (err) {
    console.error("❌ Failed to launch taskbar monitor:", err.message);
    return 1;
  }
}

module.exports = { run, resolveExePath };