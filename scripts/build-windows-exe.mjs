#!/usr/bin/env node

/**
 * Build 9Router standalone Windows executable (e.g., 9router-v0.5.95.exe).
 *
 * Packaging strategy:
 * 1. Verifies/builds Next.js standalone artifacts into `cli/app/` (via `cli/scripts/build-cli.js`).
 * 2. Bundles `cli/` runtime (`cli.js`, `hooks/`, `src/`, `app/`) + portable `node.exe`.
 * 3. Compiles a high-performance C# Win32 PE launcher using Windows built-in `csc.exe`.
 * 4. Embeds the compressed payload as a Win32 assembly resource.
 *
 * Usage:
 *   node scripts/build-windows-exe.mjs
 *   node scripts/build-windows-exe.mjs --version 0.5.95
 *   node scripts/build-windows-exe.mjs --skip-build
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const cliDir = path.join(rootDir, "cli");
const cliAppDir = path.join(cliDir, "app");
const distDir = path.join(rootDir, "dist");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    version: null,
    skipBuild: false,
    outputName: null,
    nodePath: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--version" && args[i + 1]) options.version = args[++i];
    else if (a === "--skip-build") options.skipBuild = true;
    else if (a === "--output-name" && args[i + 1]) options.outputName = args[++i];
    else if (a === "--node-path" && args[i + 1]) options.nodePath = args[++i];
  }
  return options;
}

function getAppVersion() {
  const pkgPath = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg.version || "0.5.95";
}

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

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function generateLauncherCs(appVersion) {
  return `// Auto-generated 9Router Windows Standalone Launcher
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

class Program {
    private const string APP_VERSION = "${appVersion}";

    private static string EscapeArg(string arg) {
        if (string.IsNullOrEmpty(arg)) return "\\"\\"";
        if (!arg.Contains(" ") && !arg.Contains("\\t") && !arg.Contains("\\"")) return arg;
        return "\\"" + arg.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"") + "\\"";
    }

    private static string BuildCommandLine(string cliJs, string[] args) {
        var sb = new StringBuilder();
        sb.Append(EscapeArg(cliJs));
        foreach (var a in args) {
            sb.Append(" ");
            sb.Append(EscapeArg(a));
        }
        return sb.ToString();
    }

    static int Main(string[] args) {
        try {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData)) {
                localAppData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            }
            string targetDir = Path.Combine(localAppData, "9router", "bin-" + APP_VERSION);
            string readyMarker = Path.Combine(targetDir, ".ready");
            string nodeExe = Path.Combine(targetDir, "node.exe");
            string cliJs = Path.Combine(targetDir, "cli.js");

            bool needsExtract = !File.Exists(readyMarker) || !File.Exists(nodeExe) || !File.Exists(cliJs) || !Directory.Exists(Path.Combine(targetDir, "node_modules"));

            if (needsExtract) {
                Console.WriteLine("[9Router] Extracting standalone runtime (one-time setup)...");
                Directory.CreateDirectory(targetDir);

                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload")) {
                    if (s == null) {
                        Console.Error.WriteLine("Fatal Error: Embedded payload resource not found in executable.");
                        return 1;
                    }
                    using (var archive = new ZipArchive(s, ZipArchiveMode.Read)) {
                        foreach (var entry in archive.Entries) {
                            string fullPath = Path.Combine(targetDir, entry.FullName);
                            if (string.IsNullOrEmpty(entry.Name)) {
                                Directory.CreateDirectory(fullPath);
                            } else {
                                Directory.CreateDirectory(Path.GetDirectoryName(fullPath));
                                entry.ExtractToFile(fullPath, true);
                            }
                        }
                    }
                }

                File.WriteAllText(readyMarker, APP_VERSION);
            }

            var psi = new ProcessStartInfo {
                FileName = nodeExe,
                Arguments = BuildCommandLine(cliJs, args),
                UseShellExecute = false,
                WorkingDirectory = Environment.CurrentDirectory
            };
            string existingNodePath = Environment.GetEnvironmentVariable("NODE_PATH") ?? "";
            string appNodeModules = Path.Combine(targetDir, "node_modules") + ";" + Path.Combine(targetDir, "app", "node_modules");
            psi.EnvironmentVariables["NODE_PATH"] = string.IsNullOrEmpty(existingNodePath) ? appNodeModules : appNodeModules + ";" + existingNodePath;
            psi.EnvironmentVariables["NINE_ROUTER_EXE_PATH"] = Process.GetCurrentProcess().MainModule.FileName;

            using (var proc = Process.Start(psi)) {
                if (proc == null) {
                    Console.Error.WriteLine("Fatal Error: Failed to start 9router node process.");
                    return 1;
                }
                proc.WaitForExit();
                return proc.ExitCode;
            }
        } catch (Exception ex) {
            Console.Error.WriteLine("Fatal Error: " + ex.Message);
            return 1;
        }
    }
}
`;
}

async function main() {
  const options = parseArgs();
  const version = options.version || getAppVersion();
  const outputName = options.outputName || `9router-v${version}.exe`;
  const outputExe = path.join(distDir, outputName);
  const aliasExe = path.join(distDir, "9router.exe");

  console.log(`\n🚀 Building Windows standalone executable: ${outputName}`);
  console.log(`📌 Version: ${version}\n`);

  // Step 1: Ensure CLI artifacts exist
  const serverPath = path.join(cliAppDir, "server.js");
  const serverWrapperPath = path.join(cliAppDir, "custom-server.js");
  const hasCliBuild = fs.existsSync(serverPath) && fs.existsSync(serverWrapperPath);

  if (!hasCliBuild || (!options.skipBuild && process.env.FORCE_REBUILD === "1")) {
    console.log("1️⃣  Building Next.js standalone CLI package...");
    execSync("node cli/scripts/build-cli.js", { stdio: "inherit", cwd: rootDir });
  } else {
    console.log("1️⃣  Using existing CLI package build in cli/app");
  }

  // Step 2: Prepare Staging
  const stagingDir = path.join(rootDir, ".tmp", "exe-staging");
  const zipPath = path.join(rootDir, ".tmp", "payload.zip");
  const csSourcePath = path.join(rootDir, ".tmp", "Launcher.cs");

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  console.log("\n2️⃣  Assembling runtime files into staging directory...");

  // Copy cli files
  fs.copyFileSync(path.join(cliDir, "cli.js"), path.join(stagingDir, "cli.js"));
  fs.copyFileSync(path.join(cliDir, "package.json"), path.join(stagingDir, "package.json"));
  copyDirRecursive(path.join(cliDir, "src"), path.join(stagingDir, "src"));
  copyDirRecursive(path.join(cliDir, "hooks"), path.join(stagingDir, "hooks"));
  copyDirRecursive(cliAppDir, path.join(stagingDir, "app"));

  // Copy CLI runtime node_modules
  const cliNodeModules = [
    "node-machine-id",
    "enquirer",
    "ansi-colors",
    "confbox",
    "node-forge",
    "sql.js",
  ];
  const stagingNodeModules = path.join(stagingDir, "node_modules");
  fs.mkdirSync(stagingNodeModules, { recursive: true });
  for (const mod of cliNodeModules) {
    const candidates = [
      path.join(rootDir, "node_modules", mod),
      path.join(cliAppDir, "node_modules", mod),
    ];
    const srcMod = candidates.find((p) => fs.existsSync(p));
    if (srcMod) {
      copyDirRecursive(srcMod, path.join(stagingNodeModules, mod));
    }
  }

  // Copy node.exe
  const nodeSrc = options.nodePath || process.execPath;
  if (!fs.existsSync(nodeSrc)) {
    throw new Error(`Node binary not found at ${nodeSrc}`);
  }
  console.log(`   Embedding Node runtime from: ${nodeSrc}`);
  fs.copyFileSync(nodeSrc, path.join(stagingDir, "node.exe"));

  // Step 3: Compress staging into payload.zip
  console.log("3️⃣  Compressing payload archive...");
  const psZipCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${stagingDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Fastest, $false)"`;
  execSync(psZipCmd, { stdio: "inherit" });

  const zipStat = fs.statSync(zipPath);
  console.log(`   Payload compressed size: ${(zipStat.size / (1024 * 1024)).toFixed(2)} MB`);

  // Step 4: Compile C# Launcher
  console.log("\n4️⃣  Compiling native Windows PE launcher with .NET csc...");
  const cscPath = findCscCompiler();
  const launcherCs = generateLauncherCs(version);
  fs.writeFileSync(csSourcePath, launcherCs, "utf8");

  const compileCmd = `"${cscPath}" /nologo /target:exe /optimize+ /platform:x64 /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/resource:${zipPath},Payload" /out:"${outputExe}" "${csSourcePath}"`;
  execSync(compileCmd, { stdio: "inherit" });

  // Create convenience alias 9router.exe
  fs.copyFileSync(outputExe, aliasExe);

  // Step 5: Clean up temp artifacts
  console.log("\n5️⃣  Cleaning up temporary staging files...");
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(csSourcePath, { force: true });

  const exeStat = fs.statSync(outputExe);
  console.log("\n========================================================");
  console.log(`✨ Standalone executable successfully created!`);
  console.log(`📁 Output: ${outputExe}`);
  console.log(`📁 Alias:  ${aliasExe}`);
  console.log(`📊 Size:   ${(exeStat.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error(`\n❌ Build failed: ${err.message}`);
  process.exit(1);
});
