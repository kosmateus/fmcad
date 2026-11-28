import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { controlledLegacyUiNative } from "../packages/node-adapters/src/execution/controlled-legacy-ui-native";
import { controlledHostUiNativeFiles } from "../packages/node-adapters/src/execution/controlled-host-ui-native";
import { encodedLegacyUiProgram } from "../packages/node-adapters/src/execution/controlled-legacy-ui";

const powershell = process.env["FMCAD_LEGACY_UI_WINDOWS_TEST_POWERSHELL"];
test(
  "Windows SDK-free UIA declarations compile and the pinned program parses (NO windows/input/Fusion)",
  {
    skip:
      !powershell &&
      "NOTRUN: explicit Windows PowerShell compiler path required",
  },
  () => {
    assert.ok(powershell);
    const foundation = controlledHostUiNativeFiles.split("$r = [Console]")[0]!;
    const pointDeclaration = controlledLegacyUiNative
      .split("\n")
      .find((line) => line.startsWith("Add-Type 'using System;"));
    assert.ok(pointDeclaration);
    const script = `
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$source=[Console]::In.ReadToEnd()
$tokens=$null;$errors=$null
$null=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count -gt 0){throw ($errors|Out-String)}
${foundation}
${pointDeclaration}
@{parserErrors=$errors.Count;uiaAssembliesLoaded=$true;csharpCompiled=$true;effect='Definitions only; no UI enumeration, input, Fusion or SDK'}|ConvertTo-Json -Compress
`;
    const result = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        input: controlledLegacyUiNative,
        encoding: "utf8",
        timeout: 90_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/, "")), {
      parserErrors: 0,
      uiaAssembliesLoaded: true,
      csharpCompiled: true,
      effect: "Definitions only; no UI enumeration, input, Fusion or SDK",
    });
    assert.ok(encodedLegacyUiProgram().length + 1024 < 32766);
  },
);
