/**
 * Read-only UIA/screenshot capture, or one UIA selection/invocation against the
 * freshly re-read exact host. No keyboard, global focus, coordinates or SDK.
 * Trusted OS/vendor accessibility and operator exclusivity are assumptions.
 */
export const controlledHostUiNative = String.raw`
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.IO;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
public static class ControlledHostWindow {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct FI {
  public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out FI info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr h,StringBuilder text,uint n,uint flags);
 public static string Identity(FileStream s) {
  FI i;
  if(!GetFileInformationByHandle(s.SafeFileHandle.DangerousGetHandle(),out i) ||
     (i.Attributes & 0x410)!=0 || i.Links!=1) throw new Exception("Regular original FD required");
  return "["+String.Join(",",new uint[]{i.Volume,i.IndexHigh,i.IndexLow,i.CreationHigh,i.CreationLow,i.WriteHigh,i.WriteLow,i.SizeHigh,i.SizeLow,i.Links,i.Attributes})+"]";
 }
 public static string FinalPath(FileStream s) {
  var b=new StringBuilder(32768);
  uint n=GetFinalPathNameByHandle(s.SafeFileHandle.DangerousGetHandle(),b,32768,0);
  if(n==0 || n>=32768) throw new Exception("Original FD path unavailable");
  string p=b.ToString();
  if(!p.StartsWith(@"\\?\")) throw new Exception("Local native FD path required");
  return p.Substring(4);
 }
 public static void Private(FileStream s) {
  var raw=new RawSecurityDescriptor(s.GetAccessControl().GetSecurityDescriptorBinaryForm(),0);
  var current=WindowsIdentity.GetCurrent().User.Value;
  Func<string,bool> trusted = sid => sid==current || sid=="S-1-5-18" || sid=="S-1-5-32-544";
  if(raw.Owner==null || !trusted(raw.Owner.Value) || raw.DiscretionaryAcl==null)
    throw new Exception("Private Windows owner/DACL required");
  foreach(GenericAce ace in raw.DiscretionaryAcl) {
   var qualified=ace as QualifiedAce;
   if(qualified==null || qualified.IsCallback) throw new Exception("Unsupported private ACE");
   if(qualified.AceQualifier==AceQualifier.AccessAllowed &&
      !trusted(qualified.SecurityIdentifier.Value) && qualified.SecurityIdentifier.Value!="S-1-3-4")
     throw new Exception("Public original DACL refused");
   if(qualified.AceQualifier!=AceQualifier.AccessAllowed && qualified.AceQualifier!=AceQualifier.AccessDenied)
     throw new Exception("Unsupported private DACL");
  }
 }
}
'@
$r = [Console]::In.ReadToEnd() | ConvertFrom-Json
$held=New-Object 'Collections.Generic.List[IDisposable]'
function Lock-Original($reference, $private=$true) {
 $name=[string]$reference.nativePath
 if ([IO.Path]::GetFullPath($name) -ine $name -or $name -notmatch '^[A-Za-z]:\\') {
   throw "Canonical local original required"
 }
 $parent=$name
 while ($parent) {
   if (([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
     throw "Original reparse ancestor refused"
   }
   $parent=[IO.Path]::GetDirectoryName($parent)
 }
 $file=New-Object IO.FileStream($name,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $held.Add($file)
 $identity=[ControlledHostWindow]::Identity($file)
 if ([ControlledHostWindow]::FinalPath($file) -ine $name -or
     ($null -ne $reference.identity -and $identity -cne $reference.identity)) {
   throw "Original FD/path identity differs"
 }
 if ($private) { [ControlledHostWindow]::Private($file) }
 $hash=[Security.Cryptography.SHA256]::Create()
 try {$actual=([BitConverter]::ToString($hash.ComputeHash($file))).Replace("-","").ToLowerInvariant()}
 finally {$hash.Dispose()}
 if ($actual -cne $reference.sha256 -or [ControlledHostWindow]::Identity($file) -cne $identity) {
   throw "Original locked bytes differ"
 }
 if ($private) { [ControlledHostWindow]::Private($file) }
}
$self = Get-Process -Id $PID
if ($self.Path -ine $r.powershell) {
 throw "Pinned UI helper executable bytes/path differ"
}
Lock-Original @{nativePath=$r.powershell;sha256=$r.powershellSha256} $false
Lock-Original @{nativePath=($r.powershell+".config");sha256=$r.powershellConfigSha256} $false
Lock-Original @{nativePath=$r.executable;sha256=$r.executableSha256} $false
$A = [System.Windows.Automation.AutomationElement]
$S = [System.Windows.Automation.TreeScope]
function Assert-Process {
 $p = Get-Process -Id $r.process.pid
 if ($p.HasExited -or $p.StartTime.ToFileTimeUtc().ToString() -cne $r.process.birth -or
     $p.Path -ine $r.executable) { throw "Exact process image/birth differs" }
}
function Own-Handle($h, $requireVisible = $true) {
 [uint32]$owner = 0
 if ($h -eq [IntPtr]::Zero -or
     [ControlledHostWindow]::GetWindowThreadProcessId($h, [ref]$owner) -eq 0 -or
     $owner -ne $r.process.pid -or ($requireVisible -and -not [ControlledHostWindow]::IsWindowVisible($h))) {
   throw "Visible HWND ownership differs"
 }
}
function Read-Control($e, [int]$i) {
 $c = $e.Current
 if ($c.ProcessId -ne $r.process.pid) { throw "Foreign/partial tree" }
 if ($c.NativeWindowHandle -ne 0) {
   Own-Handle ([IntPtr]$c.NativeWindowHandle) $false
 }
 $b = $c.BoundingRectangle
 $x=$b.X;$y=$b.Y;$width=$b.Width;$height=$b.Height
 if ([double]::IsInfinity($b.X) -or [double]::IsInfinity($b.Y) -or
     [double]::IsNaN($b.X) -or [double]::IsNaN($b.Y)) {
   if (-not $c.IsOffscreen) { throw "Partial visible rectangle" }
   # Collapsed controls grant no input.
   $x=$null;$y=$null;$width=0;$height=0
 }
 $selected = $null
 $pattern = $null
 if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
   $selected = $pattern.Current.IsSelected
 }
 return [ordered]@{
   index=$i; id=$c.AutomationId; name=$c.Name; class=$c.ClassName;
   type=$c.ControlType.ProgrammaticName; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen;
   x=$x; y=$y; width=$width; height=$height; selected=$selected
 }
}
function Matches($d, $selector) {
 return $d.id -ceq $selector.id -and $d.name -ceq $selector.name -and
        $d.class -ceq $selector.class -and $d.type -ceq $selector.type
}
function Capture {
 Assert-Process
 $cond = New-Object System.Windows.Automation.AndCondition(
   (New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$r.process.pid)),
   (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, [string]$r.mainClass)))
 $windows = $A::RootElement.FindAll($S::Children, $cond)
 if ($windows.Count -ne 1) { throw "Ambiguous exact main window" }
 $main = $windows[0]
 $hwnd = [IntPtr]$main.Current.NativeWindowHandle
 Own-Handle $hwnd
 if ($null -ne $r.expected -and $r.expected.hwnd -cne $hwnd.ToInt64().ToString()) {
   throw "Original HWND changed"
 }
 $elements = $main.FindAll($S::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
 if ($elements.Count -gt 4096) { throw "Incomplete tree budget" }
 $tree = @()
 for ($i=0; $i -lt $elements.Count; $i++) { $tree += (Read-Control $elements[$i] $i) }
 $mainData = Read-Control $main -1
 if ($mainData.offscreen -or -not $mainData.enabled -or $mainData.width -le 0 -or
     $mainData.height -le 0 -or $mainData.width * $mainData.height -gt 16777216) {
   throw "Main window capture unavailable"
 }
 $selected = @($tree | Where-Object { $_.selected -eq $true })
 # Require the full installed path, not a label.
 if ($selected.Count -gt 1) { throw "Ambiguous selected entry" }
 $entry = $null
 if ($selected.Count -eq 1) { $entry = $selected[0].name }
 $bitmap = New-Object System.Drawing.Bitmap([int]$mainData.width, [int]$mainData.height)
 $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
 $stream = New-Object System.IO.MemoryStream
 try {
   $dc=$graphics.GetHdc()
   try {
     if (-not [ControlledHostWindow]::PrintWindow($hwnd,$dc,2)) { throw "Exact HWND screenshot unavailable" }
   } finally { $graphics.ReleaseHdc($dc) }
   $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
   $png = [Convert]::ToBase64String($stream.ToArray())
 } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
 Assert-Process
 Own-Handle $hwnd
 return @{
   view=[ordered]@{process=$r.process; hwnd=$hwnd.ToInt64().ToString(); main=$mainData; tree=@($tree); selectedEntry=$entry};
   png=$png; elements=$elements; main=$main
 }
}
$before = Capture
if ($r.action -cne "capture") {
 if ($r.action -cne "invoke" -and $r.action -cne "select") { throw "Unknown input" }
 $actual = $before.view | ConvertTo-Json -Depth 12 -Compress
 $expected = $r.expected | ConvertTo-Json -Depth 12 -Compress
 if ($actual -cne $expected) { throw "Fresh original view differs; no input" }
 $found = @($before.view.tree | Where-Object { Matches $_ $r.selector })
 if ($found.Count -ne 1 -or $found[0].offscreen -or -not $found[0].enabled -or
     $found[0].width -le 0 -or $found[0].height -le 0) { throw "Unambiguous visible input required" }
 $element = $before.elements[$found[0].index]
 # Re-read the exact control.
 $current = Read-Control $element $found[0].index
 if (($current | ConvertTo-Json -Compress) -cne ($found[0] | ConvertTo-Json -Compress)) {
   throw "Control changed before input"
 }
 Assert-Process
 Own-Handle ([IntPtr][long]$before.view.hwnd)
 if ($null -eq $r.attempt -or $r.dispatchPath -cne ($r.attempt.nativePath+".dispatch")) {
   throw "Original durable action attempt unavailable"
 }
 Lock-Original $r.attempt
 if ($null -ne $r.intent) {
   if ($null -eq $r.profile -or $r.attempt.nativePath -cne ($r.intent.nativePath+".ui-start-attempt.json") -or
       $before.view.selectedEntry -cne $r.entry) { throw "Original intent/profile/selection required" }
   Lock-Original $r.intent
   Lock-Original $r.profile
 }
 # Permanent O_EXCL dispatch fence; never remove.
 $dispatchBytes=[Text.Encoding]::UTF8.GetBytes(($r.attempt | ConvertTo-Json -Compress))
 $dispatch=New-Object IO.FileStream([string]$r.dispatchPath, [IO.FileMode]::CreateNew,
   [IO.FileAccess]::Write, [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough)
 try {
   $dispatch.Write($dispatchBytes,0,$dispatchBytes.Length)
   $dispatch.Flush($true)
   [ControlledHostWindow]::Private($dispatch)
 } finally { $dispatch.Dispose() }
 # Fresh owned tree/screenshot after durable I/O, before the ONE input.
 $reviewed=Capture
 if (($reviewed.view | ConvertTo-Json -Depth 12 -Compress) -cne
     ($before.view | ConvertTo-Json -Depth 12 -Compress)) {
   throw "Selection/control changed after durable attempt; no input"
 }
 $before=$reviewed
 $element=$before.elements[$found[0].index]
 $pattern = $null
 if ($r.action -ceq "select") {
   if ($r.selector.name -cne $r.entry -or
       -not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
     throw "Exact installed entry selection unavailable"
   }
   $pattern.Select()
 } else {
   if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
     throw "Supported InvokePattern unavailable"
   }
   $pattern.Invoke()
 }
 # Delivery is not startup. No retry.
}
[ordered]@{view=$before.view; png=$before.png; inputDelivered=($r.action -cne "capture")} |
 ConvertTo-Json -Depth 12 -Compress
foreach($file in $held) {$file.Dispose()}
`;
