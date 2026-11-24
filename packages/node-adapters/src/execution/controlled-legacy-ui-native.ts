import { controlledHostUiNativeFiles } from "./controlled-host-ui-native";

/** Fixed OS/UI program; not Python, Fusion console, SDK or a public action DSL. */
export const controlledLegacyUiNative =
  controlledHostUiNativeFiles +
  String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System;using System.Runtime.InteropServices;public static class LegacyPoint{[StructLayout(LayoutKind.Sequential)]public struct POINT{public int X,Y;}[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L,T,R,B;}[DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,uint c);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(POINT p);[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint c);[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);}'
$A=[System.Windows.Automation.AutomationElement]
$S=[System.Windows.Automation.TreeScope]
$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
$base='QTApplication.Nu::QTScriptsManagerDialog'
$treeId=$base+'.QTabWidget.qt_tabwidget_stackedwidget.Nu::QTScriptsManagerAddInsTab.QTreeView'
if((Get-Process -Id $PID).Path -ine $r.powershell){throw 'Pinned OS executable required'}
Lock-Original @{nativePath=$r.powershell;sha256=$r.powershellSha256} $false
Lock-Original @{nativePath=($r.powershell+'.config');sha256=$r.powershellConfigSha256} $false
Lock-Original @{nativePath=$r.executable;sha256=$r.executableSha256} $false
foreach($file in $r.vendorFiles){Lock-Original $file $false}
foreach($file in $r.originals){Lock-Original $file}
function Process-Guard {
 $p=Get-Process -Id $r.process.pid
 if($p.HasExited -or $p.StartTime.ToFileTimeUtc().ToString() -cne $r.process.birth -or $p.Path -ine $r.executable){throw 'Exact process changed'}
 return $p
}
function Own($h){
 [uint32]$owner=0
 if($h -eq [IntPtr]::Zero -or [ControlledHostWindow]::GetWindowThreadProcessId($h,[ref]$owner) -eq 0 -or $owner -ne $r.process.pid -or -not [ControlledHostWindow]::IsWindowVisible($h)){throw 'Exact visible HWND required'}
}
function Runtime($e){return ($e.GetRuntimeId() -join ',')}
function Control($e,$parent){
 $c=$e.Current
 if($c.ProcessId -ne $r.process.pid){throw 'Foreign UI owner'}
 $b=$c.BoundingRectangle;$x=$b.X;$y=$b.Y;$w=$b.Width;$h=$b.Height
 if([Double]::IsInfinity($x) -or [Double]::IsNaN($x) -or [Double]::IsInfinity($y) -or [Double]::IsNaN($y)){
  if(-not $c.IsOffscreen){throw 'Partial visible UI bounds'}
  $x=$null;$y=$null;$w=0;$h=0
 }
 $selected=$null;$value=$null;$readonly=$null;$toggle=$null;$v=$null
 if($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$v)){$selected=$v.Current.IsSelected}
 $v=$null
 if(-not $c.IsPassword -and $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$v)){$value=$v.Current.Value;$readonly=$v.Current.IsReadOnly}
 $v=$null
 if($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$v)){$toggle=$v.Current.ToggleState.ToString()}
 return [ordered]@{runtimeId=(Runtime $e);parent=$parent;id=$c.AutomationId;name=$c.Name;class=$c.ClassName;type=$c.ControlType.ProgrammaticName;pid=$c.ProcessId;enabled=$c.IsEnabled;offscreen=$c.IsOffscreen;selected=$selected;value=$value;readOnly=$readonly;toggle=$toggle;x=$x;y=$y;width=$w;height=$h}
}
function Capture {
 $p=Process-Guard;$main=$A::FromHandle($p.MainWindowHandle);Own $p.MainWindowHandle
 if($main.Current.ClassName -cne 'Nu::QTMainWindow' -or $main.Current.AutomationId -cne 'QTApplication.MW1_0'){throw 'Pinned main class/id differ'}
 $children=$main.FindAll($S::Children,[System.Windows.Automation.Condition]::TrueCondition)
 $dialogs=@($children|Where-Object{$_.Current.ClassName -match 'Dialog'})
 $mode='main';$dialog=$null;$image=$null;$selection=$null;$root=$main;$dh=$null
 if($dialogs.Count -gt 1){throw 'Ambiguous original dialogs'}
 if($dialogs.Count -eq 1){
  $dialog=$dialogs[0];$root=$dialog;$dh=$dialog.Current.NativeWindowHandle.ToString()
  Own ([IntPtr][long]$dh)
  if([LegacyPoint]::GetWindow([IntPtr][long]$dh,4) -ne $p.MainWindowHandle){throw 'Dialog native owner differs'}
  switch -Exact ($dialog.Current.ClassName){
   'Nu::QTPreferencesDialog' {$mode='preferences'}
   'Nu::QTScriptsManagerDialog' {$mode='manager'}
   default {throw 'Unqualified/foreign dialog, including QML'}
  }
 }
 $nodes=New-Object 'Collections.Generic.List[object]'
 $elements=@{};$pending=New-Object 'Collections.Generic.Queue[object]'
 $pending.Enqueue(@{e=$root;parent=$null;depth=0})
 while($pending.Count -gt 0){
  if($nodes.Count -ge 1200){throw 'Partial scoped UI budget'}
  $i=$pending.Dequeue();$e=$i.e;$data=Control $e $i.parent
  if($elements.ContainsKey($data.runtimeId)){throw 'Ambiguous UI runtime identity'}
  $elements[$data.runtimeId]=$e;$nodes.Add($data)
  if($mode -ne 'main'){
   $child=$walker.GetFirstChild($e);$count=0
   while($null -ne $child){
    if($i.depth -ge 20 -or $pending.Count -ge 1200 -or $count -ge 1200){throw 'Partial scoped UI hierarchy'}
    $pending.Enqueue(@{e=$child;parent=$data.runtimeId;depth=($i.depth+1)})
    $child=$walker.GetNextSibling($child);$count++
   }
  }
 }
 if($mode -eq 'manager'){
  $trees=@($nodes|Where-Object{$_.id -ceq $treeId -and $_.class -ceq 'QTreeView' -and $_.type -ceq 'ControlType.Tree'})
  if($trees.Count -eq 1){
   $sp=$null
   if(-not $elements[$trees[0].runtimeId].TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern,[ref]$sp)){throw 'Native tree selection unavailable'}
   $selection=[ordered]@{tree=$trees[0].runtimeId;rows=@($sp.Current.GetSelection()|ForEach-Object{Runtime $_})}
  }elseif($trees.Count -gt 1){throw 'Ambiguous actual add-ins tree'}
 }
 if($mode -ne 'main'){
  $h=[IntPtr][long]$dh;$rect=New-Object LegacyPoint+RECT
  if(-not [LegacyPoint]::GetWindowRect($h,[ref]$rect)){throw 'Dialog bounds unavailable'}
  $w=$rect.R-$rect.L;$height=$rect.B-$rect.T
  if($w -le 0 -or $height -le 0 -or $w*$height -gt 4000000){throw 'Dialog screenshot bounds refused'}
  $bitmap=New-Object Drawing.Bitmap($w,$height);$g=[Drawing.Graphics]::FromImage($bitmap);$dc=$g.GetHdc()
  try{if(-not [ControlledHostWindow]::PrintWindow($h,$dc,2)){throw 'Original dialog image unavailable'}}finally{$g.ReleaseHdc($dc);$g.Dispose()}
  $stream=New-Object IO.MemoryStream
  try{$bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$png=[Convert]::ToBase64String($stream.ToArray())}finally{$bitmap.Dispose();$stream.Dispose()}
  $image=[ordered]@{width=$w;height=$height;png=$png}
 }
 $null=Process-Guard
 return @{capture=[ordered]@{process=$r.process;mainHwnd=$p.MainWindowHandle.ToInt64().ToString();mode=$mode;dialogHwnd=$dh;controls=$nodes.ToArray();treeSelection=$selection;image=$image};elements=$elements;dialog=$dialog;main=$main}
}
function Fingerprint($c){
 return ([ordered]@{process=$c.process;mainHwnd=$c.mainHwnd;mode=$c.mode;dialogHwnd=$c.dialogHwnd;controls=$c.controls;treeSelection=$c.treeSelection}|ConvertTo-Json -Depth 12 -Compress)
}
function Unique($view,$predicate){
 $found=@($view.capture.controls|Where-Object $predicate)
 if($found.Count -ne 1){throw 'Unique original scoped target required'}
 $data=$found[0]
 if(-not $data.enabled -or $data.offscreen -or $data.width -le 0 -or $data.height -le 0){throw 'Target not visibly enabled'}
 return $view.elements[$data.runtimeId]
}
function Legacy-Option($v){
 if($v.capture.mode -cne 'preferences'){throw 'Actual Preferences required'}
 $api=Unique $v {$_.name -ceq 'API' -and $_.type -ceq 'ControlType.TreeItem' -and $_.selected -eq $true}
 $label=Unique $v {$_.name -ceq 'Starsze okno dialogowe Skrypty' -and $_.class -ceq 'QLabel'}
 $parent=$walker.GetParent($label)
 if($parent.Current.AutomationId -notmatch '^QTApplication\.Nu::QTPreferencesDialog\.QFrame\.scrollArea[0-9]+\.qt_scrollarea_viewport\.BaseWidget[0-9]+$'){throw 'Legacy label parent differs'}
 $lb=$label.Current.BoundingRectangle
 return Unique $v {$_.parent -ceq (Runtime $parent) -and $_.class -ceq 'QCheckBox' -and $_.x -ge $lb.Right -and $_.x-$lb.Right -le 30 -and [Math]::Abs(($_.y+$_.height/2)-($lb.Y+$lb.Height/2)) -le 2}
}
function Click($element,$view){
 $cp=$element.GetClickablePoint();$point=New-Object LegacyPoint+POINT;$point.X=[int]$cp.X;$point.Y=[int]$cp.Y
 $h=[IntPtr][long]$view.capture.dialogHwnd
 if(-not $element.Current.BoundingRectangle.Contains($cp) -or [LegacyPoint]::GetAncestor([LegacyPoint]::WindowFromPoint($point),2) -ne $h){throw 'Exact target hittest differs'}
 if(-not [LegacyPoint]::SetForegroundWindow($h) -or [LegacyPoint]::GetForegroundWindow() -ne $h){throw 'Original dialog not foreground'}
 if(-not [LegacyPoint]::SetCursorPos($point.X,$point.Y)){throw 'Target cursor failed'}
 if([LegacyPoint]::GetAncestor([LegacyPoint]::WindowFromPoint($point),2) -ne $h){throw 'Target ownership changed'}
 [LegacyPoint]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 [LegacyPoint]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
function Require-Entry($v){
 if($v.capture.mode -cne 'manager'){throw 'Actual legacy manager required'}
 $tab=Unique $v {$_.name -ceq 'Dodatki' -and $_.type -ceq 'ControlType.TabItem' -and $_.selected -eq $true}
 $tree=Unique $v {$_.id -ceq $treeId -and $_.class -ceq 'QTreeView'}
 $rows=@($v.capture.controls|Where-Object{$_.parent -ceq (Runtime $tree) -and $_.type -ceq 'ControlType.TreeItem' -and $_.selected -eq $true})
 if($rows.Count -ne 1 -or $rows[0].name -cne 'AutodeskFusionMCP' -or $v.capture.treeSelection.tree -cne (Runtime $tree) -or $v.capture.treeSelection.rows.Count -ne 1 -or $v.capture.treeSelection.rows[0] -cne $rows[0].runtimeId){throw 'Native selection disagreement/category'}
 $label=Unique $v {$_.name -ceq 'Pełna ścieżka' -and $_.class -ceq 'QLabel'}
 $field=$walker.GetNextSibling($label);$value=$null
 if($field.Current.ClassName -cne 'QPlainTextEdit' -or -not $field.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value) -or -not $value.Current.IsReadOnly -or -not $value.Current.Value -or [IO.Path]::GetFullPath($value.Current.Value) -ine $r.entry){throw 'Readonly labeled entry path differs'}
 $startup=Unique $v {$_.name -ceq 'Uruchom przy starcie' -and $_.class -ceq 'QCheckBox'}
 $toggle=$null
 if(-not $startup.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$toggle) -or $toggle.Current.ToggleState.ToString() -cne 'Off'){throw 'Startup must remain OFF'}
 return Unique $v {$_.id -ceq ($base+'.QToolButton') -and $_.class -ceq 'QToolButton' -and $_.name -ceq 'Uruchom' -and $_.type -ceq 'ControlType.Button'}
}
$before=Capture
if($r.action -cne 'capture'){
 if($r.action -notin @('openPreferences','selectApi','toggleLegacy','applyLegacy','cancelPreferences','openManager','addinsTab','details','selectEntry','closeManager','start')){throw 'Unknown UI action'}
 if((Fingerprint $before.capture) -cne (Fingerprint $r.expected)){throw 'Fresh original UI changed before dispatch'}
 if($null -eq $r.attempt -or $r.dispatchPath -cne ($r.attempt.nativePath+'.dispatch')){throw 'Durable original action required'}
 Lock-Original $r.attempt
 if($r.action -ceq 'start'){
  if($null -eq $r.intent -or $null -eq $r.profile -or $r.attempt.nativePath -cne ($r.intent.nativePath+'.legacy-start-attempt.json')){throw 'Original isolated stdout intent/profile required'}
  Lock-Original $r.intent;Lock-Original $r.profile
  $null=Require-Entry $before
 }
 $bytes=[Text.Encoding]::UTF8.GetBytes(($r.attempt|ConvertTo-Json -Compress))
 $dispatch=New-Object IO.FileStream([string]$r.dispatchPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
 try{$dispatch.Write($bytes,0,$bytes.Length);$dispatch.Flush($true);[ControlledHostWindow]::Private($dispatch)}finally{$dispatch.Dispose()}
 $fresh=Capture
 if((Fingerprint $fresh.capture) -cne (Fingerprint $before.capture)){throw 'UI changed after durable dispatch; no input'}
 $before=$fresh;$element=$null
 switch -Exact ($r.action){
  'openPreferences' {if($before.capture.mode -cne 'main'){throw 'Owned main-only Preferences navigation required'}}
  'openManager' {if($before.capture.mode -cne 'main'){throw 'Owned main-only manager navigation required'}}
  'selectApi' {$element=Unique $before {$_.name -ceq 'API' -and $_.type -ceq 'ControlType.TreeItem'}}
  'toggleLegacy' {
   $element=Legacy-Option $before;$p=$null
   if(-not $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$p) -or $p.Current.ToggleState.ToString() -cne $r.legacyBefore){throw 'Original legacy bool changed'}
   $pending=@($before.capture.controls|Where-Object{$_.name -ceq 'Zastosuj' -and $_.class -ceq 'QPushButton'})
   if($pending.Count -ne 1 -or $pending[0].enabled){throw 'Pending preferences changes; no toggle'}
  }
  'applyLegacy' {$element=Unique $before {$_.name -ceq 'Zastosuj' -and $_.class -ceq 'QPushButton'};$null=Legacy-Option $before}
  'cancelPreferences' {
   $pending=@($before.capture.controls|Where-Object{$_.name -ceq 'Zastosuj' -and $_.class -ceq 'QPushButton'})
   if($pending.Count -ne 1 -or $pending[0].enabled){throw 'Pending preferences changes; no cancel'}
   $element=Unique $before {$_.name -ceq 'Anuluj' -and $_.class -ceq 'QPushButton'}
  }
  'addinsTab' {$element=Unique $before {$_.name -ceq 'Dodatki' -and $_.type -ceq 'ControlType.TabItem'}}
  'details' {$element=Unique $before {$_.name -ceq 'Szczegóły' -and $_.class -ceq 'QPushButton'}}
  'selectEntry' {$element=Unique $before {$_.id -ceq $treeId -and $_.name -ceq 'AutodeskFusionMCP' -and $_.type -ceq 'ControlType.TreeItem'}}
  'closeManager' {if($before.capture.mode -cne 'manager'){throw 'Only own legacy manager may close'}}
  'start' {$element=Require-Entry $before}
 }
 $null=Process-Guard
 if($r.action -in @('openPreferences','openManager')){
  $h=[IntPtr][long]$before.capture.mainHwnd
  if(-not [LegacyPoint]::SetForegroundWindow($h) -or [LegacyPoint]::GetForegroundWindow() -ne $h){throw 'Original main not foreground'}
  $shortcut=if($r.action -ceq 'openPreferences'){'^,'}else{'+s'}
  [System.Windows.Forms.SendKeys]::SendWait($shortcut)
 }elseif($r.action -ceq 'closeManager'){
  $p=$null
  if(-not $before.dialog.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern,[ref]$p)){throw 'Owned dialog close unsupported'}
  $p.Close()
 }elseif($r.action -in @('applyLegacy','cancelPreferences','start')){
  $p=$null
  if(-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){throw 'Exact InvokePattern unavailable'}
  $p.Invoke()
 }else{Click $element $before}
}
[ordered]@{capture=$before.capture;inputDelivered=($r.action -cne 'capture')}|ConvertTo-Json -Depth 14 -Compress
foreach($file in $held){$file.Dispose()}
`;
