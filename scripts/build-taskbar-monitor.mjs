#!/usr/bin/env node

/**
 * Build 9Router Taskbar Speed Monitor executable using Windows built-in csc.exe.
 * Produces a lightweight (~50KB) native Win32/WinForms executable.
 *
 * Usage:
 *   node scripts/build-taskbar-monitor.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sourceFile = path.join(rootDir, "tools", "taskbar-monitor", "TaskbarMonitor.cs");
const distDir = path.join(rootDir, "dist");
const cliBinDir = path.join(rootDir, "cli", "bin");
const iconFile = path.join(rootDir, "cli", "src", "cli", "tray", "icon.ico");

function findCscCompiler() {
  const candidates = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Cannot find Microsoft .NET Framework csc.exe compiler on this machine.");
}

async function main() {
  console.log("\n⚡ Building 9Router Taskbar Speed Monitor (TrafficMonitor style)...");

  if (!fs.existsSync(sourceFile)) {
    console.error(`❌ Source file not found: ${sourceFile}`);
    process.exit(1);
  }

  const csc = findCscCompiler();
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });

  const outputExe = path.join(distDir, "9router-taskbar.exe");
  const cliExe = path.join(cliBinDir, "9router-taskbar.exe");

  const references = [
    "System.dll",
    "System.Windows.Forms.dll",
    "System.Drawing.dll",
  ];

  const args = [
    `"${csc}"`,
    "/target:winexe",
    "/optimize+",
    "/platform:anycpu",
    ...references.map((r) => `/r:${r}`),
    fs.existsSync(iconFile) ? `/win32icon:"${iconFile}"` : "",
    `/out:"${outputExe}"`,
    `"${sourceFile}"`,
  ].filter(Boolean);

  const cmd = args.join(" ");

  try {
    execSync(cmd, { stdio: "inherit", cwd: rootDir });
    // Also copy to cli/bin for CLI distribution
    fs.copyFileSync(outputExe, cliExe);

    const stats = fs.statSync(outputExe);
    console.log(`\n✅ Build successful!`);
    console.log(`   Dist: ${outputExe} (${Math.round(stats.size / 1024)} KB)`);
    console.log(`   CLI:  ${cliExe}`);
  } catch (err) {
    console.error("\n❌ Compilation failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});