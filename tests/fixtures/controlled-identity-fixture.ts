import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const source = String.raw`
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
[assembly: AssemblyFileVersion("1.2.3.4")]
[assembly: AssemblyInformationalVersion("1.2.3.4")]
static class IdentityFixture {
    static string Stamp(DateTime value) {
        return value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    }
    static void Write(string image, int pid, DateTime time, string message) {
        string line = Stamp(time) + " [AdskIdentityManager:" + pid + ", 5972] [AdskIdentityManager INFO] " + message + Environment.NewLine;
        File.AppendAllText(image + ".log", line, new UTF8Encoding(false));
    }
    [STAThread]
    static void Main() {
        Process current = Process.GetCurrentProcess();
        int pid = current.Id;
        string image = current.MainModule.FileName;
        string version = FileVersionInfo.GetVersionInfo(image).FileVersion;
        string args = String.Join(" ", Environment.GetCommandLineArgs().Skip(1).ToArray());
        string modeFile = image + ".mode";
        string mode = File.Exists(modeFile) ? File.ReadAllText(modeFile).Trim() : "normal";
        DateTime now = DateTime.UtcNow;
        Write(image, pid, now, "Starting Autodesk IDSDK Server process (Version: " + version + " Config: x64-Release Elevated: No File: " + image + ")");
        if (mode != "coarse-timestamp") Thread.Sleep(10);
        Write(image, pid, mode == "coarse-timestamp" ? now : DateTime.UtcNow, "Command line arguments: " + (mode == "wrong-args" ? args + " --unexpected" : args));
        if (mode != "coarse-timestamp") Thread.Sleep(10);
        if (mode.StartsWith("delayed-ready-", StringComparison.Ordinal)) {
            int delay = Int32.Parse(mode.Substring("delayed-ready-".Length), CultureInfo.InvariantCulture);
            Thread.Sleep(delay);
        }
        if (mode != "missing-event") {
            int readyPid = mode == "wrong-pid" ? pid + 1 : pid;
            DateTime readyTime = mode == "pre-birth" ? DateTime.UtcNow.AddMinutes(-1) : mode == "coarse-timestamp" ? now : DateTime.UtcNow;
            Write(image, readyPid, readyTime, "SSO Server is ready");
        }
        Form form = new Form();
        form.ShowInTaskbar = false;
        form.Opacity = 0;
        System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        DateTime expires = DateTime.UtcNow.AddMinutes(3);
        timer.Interval = 100;
        timer.Tick += delegate {
            if (File.Exists(image + ".stop") || DateTime.UtcNow >= expires) {
                timer.Stop();
                form.Close();
            }
        };
        timer.Start();
        Application.Run(form);
    }
}
`;

function mapped(nativePath: string) {
  if (!/^[A-Za-z]:\\/.test(nativePath))
    throw new Error("Canonical Windows fixture path required");
  return `/mnt/${nativePath[0]!.toLowerCase()}/${nativePath.slice(3).replaceAll("\\", "/")}`;
}

export function compileControlledIdentityFixture(
  directory: string,
  executableName = "FmcadControlledIdentityFixture.exe",
) {
  const sourcePath = path.win32.join(directory, "IdentityFixture.cs");
  if (!/^[A-Za-z0-9._-]+\.exe$/i.test(executableName))
    throw new Error("Controlled Identity fixture executable name is invalid");
  const executable = path.win32.join(directory, executableName);
  const logFile = `${executable}.log`;
  fs.writeFileSync(mapped(sourcePath), source);
  const compiler = mapped(
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  );
  const result = spawnSync(
    compiler,
    [
      "/nologo",
      "/target:winexe",
      `/out:${path.win32.basename(executable)}`,
      "/r:System.Windows.Forms.dll",
      "IdentityFixture.cs",
    ],
    { cwd: mapped(directory), encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      result.stderr || "Windows Identity fixture compilation failed",
    );
  return Object.freeze({
    executable,
    mappedExecutable: mapped(executable),
    sha256: createHash("sha256")
      .update(fs.readFileSync(mapped(executable)))
      .digest("hex"),
    version: "1.2.3.4",
    arguments: Object.freeze([
      "--process_name",
      "Autodesk.IDSDK.DefaultProcess-v2",
      "--server_name",
      "Autodesk.IDSDK.DefaultServer-v2",
    ] as const),
    logFile,
    mappedLogFile: mapped(logFile),
    modeFile: `${executable}.mode`,
    mappedModeFile: mapped(`${executable}.mode`),
    stopFile: `${executable}.stop`,
    mappedStopFile: mapped(`${executable}.stop`),
  });
}
