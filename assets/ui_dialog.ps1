param(
  [Parameter(Mandatory=$true)][ValidateSet('inspect','respond','watch','watch-status')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$RequestBase64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($RequestBase64.Length -gt 21848) { throw 'UIA request exceeds bounded argv size' }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($Mode -ne 'watch-status') {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FmcadUiWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
}
'@
}

function Emit([hashtable]$Value) {
  [Console]::Out.WriteLine('FMCAD_UI_RESULT ' + (ConvertTo-Json -InputObject $Value -Depth 16 -Compress))
}

function Emit-Watcher($Request, [hashtable]$Value) {
  try { Write-WatcherLifecycle $Request 'finished' $Value }
  catch { $Value.unavailableEvidence = @($Value.unavailableEvidence) + @('durable watcher receipt write failed') }
  Emit $Value
}

function Emit-WatcherStatus($Value) {
  [Console]::Out.WriteLine('FMCAD_UI_WATCHER_STATUS ' + (ConvertTo-Json -InputObject $Value -Depth 12 -Compress))
}

function Write-WatcherLifecycle($Request, [string]$State, $Result) {
  if (-not $Request.lifecycleFile -or -not $Request.lifecycleId -or -not (Test-Path -LiteralPath $Request.lifecycleFile)) { return $false }
  $record = Get-Content -LiteralPath $Request.lifecycleFile -Raw | ConvertFrom-Json
  if ($record.lifecycleId -cne $Request.lifecycleId -or $record.requestId -cne $Request.requestId -or
      $record.leaseHash -cne $Request.leaseHash -or $record.intent -cne $Request.intent -or
      ($record.operationId -and $record.operationId -cne $Request.lease.operationId) -or
      $record.profileId -cne $Request.profile.profileId -or
      $record.target.name -cne $Request.expectedIdentity.name -or
      $record.target.creationId -cne $Request.expectedIdentity.creationId -or
      $record.target.fileId -cne $Request.expectedIdentity.fileId -or
      [string]$record.target.commandId -cne [string]$Request.expectedIdentity.commandId) { return $false }
  if ($record.state -ceq 'finished') { return $true }
  $hostProcess = $null
  try {
    $currentProcess = Get-Process -Id $PID -ErrorAction Stop
    $hostProcess = @{ processId=[int]$PID; startTimeTicks=[string]$currentProcess.StartTime.ToUniversalTime().Ticks;
      processName=[string]$currentProcess.ProcessName }
  } catch {}
  $record.state = $State
  $record.updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($hostProcess) { $record.hostProcess = $hostProcess }
  if ($null -ne $Result) {
    $record.result = @{ status=$Result.status; actionSubmitted=$Result.actionSubmitted;
      dialogClosed=$Result.dialogClosed; operationOutcome=$Result.operationOutcome;
      unavailableEvidence=@($Result.unavailableEvidence) }
  }
  $temporary = [string]$Request.lifecycleFile + '.' + [string]$PID + '.tmp'
  $json = ConvertTo-Json -InputObject $record -Depth 12 -Compress
  [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Request.lifecycleFile -Force
  return $true
}

function Get-OwnerChain([IntPtr]$Handle, [IntPtr]$RootHandle) {
    $current = $Handle
    for ($i = 0; $i -lt 12 -and $current -ne [IntPtr]::Zero; $i++) {
        if ($current -eq $RootHandle) { return $true }
        $current = [FmcadUiWindow]::GetWindow($current, 4) # GW_OWNER
    }
    return ($Handle -eq $RootHandle)
}

function Get-RuntimeIdText($Element) {
    try { return (@($Element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.') }
    catch { return '' }
}

function Get-ControlRow($Element, [IntPtr]$WindowHandle, [string[]]$ParentPath, [string]$ContainerKey) {
    $c = $Element.Current
    $isPassword = $false
    try { $isPassword = [bool]$c.IsPassword } catch {}
    $isModal = $false
    if ($c.ControlType.ProgrammaticName -eq 'ControlType.Window') {
        try { $isModal = [bool]([System.Windows.Automation.WindowPattern]$Element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Current.IsModal } catch {}
    }
    $invoke = $false
    try { $null = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $invoke = $true } catch {}
    $name = [string]$c.Name
    if ($isPassword) { $name = '[redacted]' }
    return @{
        windowHandle = $WindowHandle.ToInt64()
        runtimeId = @((Get-RuntimeIdText $Element) -split '\.' | Where-Object { $_ -ne '' })
        containerKey = $ContainerKey
        parentPath = @($ParentPath | Select-Object -First 12)
        automationId = [string]$c.AutomationId
        name = $name
        controlType = ([string]$c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
        className = [string]$c.ClassName
        enabled = [bool]$c.IsEnabled
        offscreen = [bool]$c.IsOffscreen
        isPassword = $isPassword
        isModal = $isModal
        invokeAvailable = $invoke
        semanticRole = $null
    }
}

function Get-WindowTree($RootElement, [bool]$IsMain, [int]$MaxControls) {
    $handle = [IntPtr]$RootElement.Current.NativeWindowHandle
    $rootKey = 'root:' + $handle.ToInt64()
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@{ element=$RootElement; depth=0; path=@(); containerKey=$rootKey })
    $controls = New-Object System.Collections.ArrayList
    $truncated = $false
    $modal = $false
    try { $modal = [bool]([System.Windows.Automation.WindowPattern]$RootElement.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Current.IsModal } catch {}
    while ($queue.Count -gt 0) {
        $item = $queue.Dequeue()
        $element = $item.element
        $depth = [int]$item.depth
        if ($depth -gt 0) {
            if ($controls.Count -ge $MaxControls) { $truncated = $true; break }
            $null = $controls.Add((Get-ControlRow $element $handle $item.path $item.containerKey))
        }
        if ($depth -ge 12) { continue }
        try {
            $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($element)
            while ($null -ne $child) {
                $c = $child.Current
                $pathPart = @($item.path) + @((([string]$c.AutomationId) + '|' + [string]$c.ControlType.ProgrammaticName + '|' + [string]$c.ClassName))
                $containerKey = $item.containerKey
                if ($c.ControlType.ProgrammaticName -eq 'ControlType.Window') {
                    $isDialog = $false
                    try { $isDialog = [bool]([System.Windows.Automation.WindowPattern]$child.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Current.IsModal } catch {}
                    if ($isDialog -or $c.ClassName -match 'QDialog|QMessageBox' -or $c.AutomationId -match 'MessageBox') {
                        $runtime = Get-RuntimeIdText $child
                        if (-not $runtime) { $runtime = ($pathPart -join '/') }
                        $containerKey = 'dialog:' + $runtime
                    }
                }
                $queue.Enqueue(@{ element=$child; depth=$depth + 1; path=$pathPart; containerKey=$containerKey })
                $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child)
            }
        } catch { $truncated = $true; break }
    }
    return @{
        handle = $handle.ToInt64()
        rootContainerKey = $rootKey
        className = [string]$RootElement.Current.ClassName
        title = [string]$RootElement.Current.Name
        isMain = $IsMain
        isModal = $modal
        ownerHandle = ([FmcadUiWindow]::GetWindow($handle, 4)).ToInt64()
        controls = @($controls.ToArray())
        truncated = $truncated
    }
}

function Get-Snapshot($Request) {
    $pidValue = [int]$Request.processId
    try { $process = Get-Process -Id $pidValue -ErrorAction Stop }
    catch { return @{ status='unavailable'; unavailableEvidence=@('Fusion process not found') } }
    if ($process.ProcessName -ne 'Fusion360') {
        return @{ status='unsupported'; unavailableEvidence=@('Target process is not Fusion360') }
    }
    $startTicks = [string]$process.StartTime.ToUniversalTime().Ticks
    if ($Request.expectedProcessStartTicks -and $startTicks -ne [string]$Request.expectedProcessStartTicks) {
        return @{ status='identity_mismatch'; processId=$pidValue; processStartTicks=$startTicks;
            unavailableEvidence=@('PID start time changed') }
    }
    $mainHandle = [IntPtr]$process.MainWindowHandle
    $childrenCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pidValue)
    $topWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $childrenCondition)
    $roots = @()
    if ($mainHandle -ne [IntPtr]::Zero) {
        $main = [System.Windows.Automation.AutomationElement]::FromHandle($mainHandle)
        if ($null -ne $main -and $main.Current.ProcessId -eq $pidValue) { $roots += @{element=$main; main=$true} }
    }
    foreach ($window in $topWindows) {
        $handle = [IntPtr]$window.Current.NativeWindowHandle
        if ($handle -eq [IntPtr]::Zero) { continue }
        if ($roots | Where-Object { $_.element.Current.NativeWindowHandle -eq $handle }) { continue }
        if ($mainHandle -eq [IntPtr]::Zero -or (Get-OwnerChain $handle $mainHandle)) {
            $roots += @{element=$window; main=($handle -eq $mainHandle)}
        }
    }
    $mainMatches = @($roots | Where-Object { $_.main })
    if ($mainMatches.Count -ne 1) {
        return @{ status=if ($mainMatches.Count -gt 1) {'ambiguous'} else {'unavailable'};
            processId=$pidValue; processStartTicks=$startTicks; mainWindowHandle=$mainHandle.ToInt64();
            unavailableEvidence=@('Unique process-owned Fusion window unavailable') }
    }
    if ($Request.expectedMainWindowHandle -and $mainHandle.ToInt64() -ne [long]$Request.expectedMainWindowHandle) {
        return @{ status='identity_mismatch'; processId=$pidValue; processStartTicks=$startTicks;
            mainWindowHandle=$mainHandle.ToInt64(); unavailableEvidence=@('Fusion main window handle changed') }
    }
    $limit = [int]$Request.maxControls
    if ($limit -lt 1 -or $limit -gt 512) { $limit = 256 }
    $windows = @()
    $remaining = $limit
    foreach ($root in $roots) {
        if ($windows.Count -ge 16) { break }
        $row = Get-WindowTree $root.element $root.main $remaining
        $windows += $row
        $remaining -= $row.controls.Count
        if ($remaining -le 0) { break }
    }
    $allTruncated = $remaining -le 0 -or @($windows | Where-Object { $_.truncated }).Count -gt 0
    $locale = [System.Globalization.CultureInfo]::CurrentUICulture.Name
    return @{ status='ready'; processId=$pidValue; processStartTicks=$startTicks;
        mainWindowHandle=$mainHandle.ToInt64(); osBuild=[Environment]::OSVersion.Version.ToString();
        locale=$locale; windows=$windows; truncated=$allTruncated; unavailableEvidence=@() }
}

function Compare-Control($Control, $Wanted) {
    if ([long]$Control.windowHandle -ne [long]$Wanted.windowHandle) { return $false }
    if ([string]$Control.runtimeId -ne [string]$Wanted.runtimeId) { return $false }
    if ([string]$Control.automationId -cne [string]$Wanted.automationId) { return $false }
    if ([string]$Control.name -cne [string]$Wanted.name) { return $false }
    if ([string]$Control.controlType -cne [string]$Wanted.controlType) { return $false }
    if ([string]$Control.className -cne [string]$Wanted.className) { return $false }
    if ([string]$Control.containerKey -cne [string]$Wanted.containerKey) { return $false }
    if ((@($Control.parentPath) -join '\') -cne (@($Wanted.parentPath) -join '\')) { return $false }
    return $true
}

function Invoke-ObservedControl($Request) {
    $expectedAction = switch ($Request.intent) {
        'confirmRequestedUpdate' { 'confirm' }
        'confirmRequestedSave' { 'confirm' }
        'cancelUncommittedCommand' { 'cancel' }
        'dismissKnownInfo' { 'dismiss' }
        default { $null }
    }
    if (-not $Request.requestId -or -not $Request.lease -or
        $Request.lease.requestId -cne $Request.requestId -or
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$Request.lease.expiresAt -or
        -not $Request.expectedIdentity -or
        $Request.lease.target.name -cne $Request.expectedIdentity.name -or
        $Request.lease.target.creationId -cne $Request.expectedIdentity.creationId -or
        $Request.lease.target.fileId -cne $Request.expectedIdentity.fileId -or
        [string]$Request.lease.target.commandId -cne [string]$Request.expectedIdentity.commandId -or
        -not $expectedAction -or $Request.action -cne $expectedAction -or
        -not $Request.profile -or $Request.profile.intent -cne $Request.intent -or
        $Request.profile.action -cne $Request.action) {
        return @{status='blocked';actionSubmitted=$false;operationOutcome='notEvaluated';
            unavailableEvidence=@('host action request lease, intent, target or action binding is invalid')}
    }
    if ($Request.lifecycleFile) {
        try { $lifecycleStarted = Write-WatcherLifecycle $Request 'running' $null }
        catch { return @{status='blocked';actionSubmitted=$false;operationOutcome='notEvaluated';
            unavailableEvidence=@('durable continuation lifecycle receipt could not be started')} }
        if (-not $lifecycleStarted) {
            return @{status='blocked';actionSubmitted=$false;operationOutcome='notEvaluated';
                unavailableEvidence=@('durable continuation lifecycle identity mismatch')}
        }
    }
    $snapshot = Get-Snapshot $Request
    if ($snapshot.status -ne 'ready') {
        return @{ status=$snapshot.status; actionSubmitted=$false; unavailableEvidence=$snapshot.unavailableEvidence }
    }
    if ($snapshot.truncated) { return @{ status='blocked'; actionSubmitted=$false; unavailableEvidence=@('UIA subtree was truncated') } }
    $window = @($snapshot.windows | Where-Object { [long]$_.handle -eq [long]$Request.windowHandle })
    if ($window.Count -ne 1) { return @{ status='stale'; actionSubmitted=$false; unavailableEvidence=@('Observed window is no longer unique') } }
    $matches = @($window[0].controls | Where-Object { Compare-Control $_ $Request.control })
    if ($matches.Count -ne 1) {
        return @{ status=if ($matches.Count -gt 1) {'ambiguous'} else {'notFound'}; actionSubmitted=$false;
            candidates=@($matches | ForEach-Object { @{name=$_.name;automationId=$_.automationId;controlType=$_.controlType} }) }
    }
    $control = $matches[0]
    if ($control.controlType -ne 'Button' -or -not $control.enabled -or $control.offscreen -or -not $control.invokeAvailable) {
        return @{ status='blocked'; actionSubmitted=$false; unavailableEvidence=@('Observed control is not a fresh enabled visible Invoke button') }
    }
    $profile = $Request.profile
    if ($null -ne $profile) {
        $dialogControls = @($window[0].controls | Where-Object { $_.containerKey -ceq $Request.control.containerKey })
        foreach ($markerId in @($profile.titleAutomationId, $profile.messageAutomationId) | Where-Object { $_ }) {
            if (-not @($dialogControls | Where-Object { $_.automationId -ceq $markerId }).Count) {
                return @{ status='stale'; actionSubmitted=$false; unavailableEvidence=@('Qualified dialog markers changed') }
            }
        }
    }
    $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$Request.processId)))
    $freshMatches = @()
    foreach ($root in $elements) {
        if ([long]$root.Current.NativeWindowHandle -ne [long]$Request.windowHandle) { continue }
        $rootKey = 'root:' + [long]$Request.windowHandle
        $queue = New-Object System.Collections.Queue
        $queue.Enqueue(@{ element=$root; depth=0; path=@(); containerKey=$rootKey })
        while ($queue.Count -gt 0) {
            $item = $queue.Dequeue(); $current = $item.element; $depth = [int]$item.depth
            if ($depth -gt 0) {
                $row = Get-ControlRow $current ([IntPtr]$Request.windowHandle) $item.path $item.containerKey
                if (Compare-Control $row $Request.control) { $freshMatches += $current }
            }
            if ($depth -ge 12) { continue }
            try {
                $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($current)
                while ($null -ne $child) {
                    $c = $child.Current
                    $pathPart = @($item.path) + @((([string]$c.AutomationId) + '|' + [string]$c.ControlType.ProgrammaticName + '|' + [string]$c.ClassName))
                    $containerKey = $item.containerKey
                    if ($c.ControlType.ProgrammaticName -eq 'ControlType.Window') {
                        $isDialog = $false
                        try { $isDialog = [bool]([System.Windows.Automation.WindowPattern]$child.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Current.IsModal } catch {}
                        if ($isDialog -or $c.ClassName -match 'QDialog|QMessageBox' -or $c.AutomationId -match 'MessageBox') {
                            $runtime = Get-RuntimeIdText $child; if (-not $runtime) { $runtime = ($pathPart -join '/') }
                            $containerKey = 'dialog:' + $runtime
                        }
                    }
                    $queue.Enqueue(@{ element=$child; depth=$depth + 1; path=$pathPart; containerKey=$containerKey })
                    $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child)
                }
            } catch { break }
        }
    }
    if ($freshMatches.Count -ne 1) { return @{ status=if ($freshMatches.Count) {'ambiguous'} else {'stale'};
        actionSubmitted=$false; unavailableEvidence=@('Fresh observed control is not unique') } }
    $element = $freshMatches[0]
    $started = $false
    try {
        $started = $true
        ([System.Windows.Automation.InvokePattern]$element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    } catch {
        return @{ status='unknown'; actionSubmitted=if ($started) {$null} else {$false};
            unavailableEvidence=@('Invoke outcome is uncertain; do not retry') }
    }
    try { $after = Get-Snapshot $Request }
    catch {
        return @{ status='actionSubmitted'; actionSubmitted=$true; dialogClosed=$null;
            operationOutcome='notEvaluated'; processStartTicks=$snapshot.processStartTicks;
            mainWindowHandle=$snapshot.mainWindowHandle;
            unavailableEvidence=@('Invoke returned but post-action UIA inspection failed; do not replay') }
    }
    $dialogPresent = $false
    foreach ($afterWindow in @($after.windows | Where-Object { [long]$_.handle -eq [long]$Request.windowHandle })) {
        $scope = @($afterWindow.controls | Where-Object { $_.containerKey -ceq $Request.control.containerKey })
        if ($Request.profile -and $Request.profile.titleAutomationId -and $Request.profile.messageAutomationId) {
            $hasTitle = @($scope | Where-Object { $_.automationId -ceq $Request.profile.titleAutomationId }).Count -gt 0
            $hasMessage = @($scope | Where-Object { $_.automationId -ceq $Request.profile.messageAutomationId }).Count -gt 0
            if ($hasTitle -and $hasMessage) { $dialogPresent = $true }
        } elseif ($Request.profile -and $Request.profile.buttonAutomationId) {
            $dialogPresent = @($scope | Where-Object { $_.automationId -ceq $Request.profile.buttonAutomationId }).Count -gt 0
        } elseif ($scope.Count -gt 0) {
            $dialogPresent = @($scope | Where-Object { $_.runtimeId -join '.' -eq ($Request.control.runtimeId -join '.') -and
                $_.automationId -ceq $Request.control.automationId -and $_.controlType -ceq $Request.control.controlType }).Count -gt 0
        }
    }
    $closed = $after.status -eq 'ready' -and -not $dialogPresent
    return @{ status='actionSubmitted'; actionSubmitted=$true; dialogClosed=$closed;
        operationOutcome='notEvaluated'; processStartTicks=$snapshot.processStartTicks;
        mainWindowHandle=$snapshot.mainWindowHandle; unavailableEvidence=@() }
}

function Find-ProfileButtons($Snapshot, $Request) {
    $profile = $Request.profile
    $matches = @()
    foreach ($window in $Snapshot.windows) {
        $groups = @($window.controls | Group-Object containerKey)
        foreach ($group in $groups) {
            $controls = @($group.Group)
            if ($profile.dialogClass -and $window.className -notlike ('*' + $profile.dialogClass + '*') -and
                -not @($controls | Where-Object { $_.className -like ('*' + $profile.dialogClass + '*') -or
                    @($_.parentPath | Where-Object { $_ -like ('*' + $profile.dialogClass + '*') }).Count }).Count) { continue }
            if ($profile.titleAutomationId -and @($controls | Where-Object { $_.automationId -ceq $profile.titleAutomationId }).Count -ne 1) { continue }
            if ($profile.messageAutomationId -and @($controls | Where-Object { $_.automationId -ceq $profile.messageAutomationId }).Count -ne 1) { continue }
            $language = ($Snapshot.locale -split '-')[0]
            $localized = $null
            if ($profile.localized) { $localized = $profile.localized.$language }
            if ($localized -and $localized.title -and
                -not @($controls | Where-Object { $_.automationId -ceq $profile.titleAutomationId -and $_.name -ceq $localized.title }).Count) { continue }
            if ($localized -and $localized.message -and
                -not @($controls | Where-Object { $_.automationId -ceq $profile.messageAutomationId -and $_.name -like ('*' + $localized.message + '*') }).Count) { continue }
            $buttons = @($controls | Where-Object { $_.automationId -ceq $profile.buttonAutomationId -and
                $_.controlType -eq 'Button' -and $_.enabled -and -not $_.offscreen -and $_.invokeAvailable })
            if ($localized -and $localized.button) { $buttons = @($buttons | Where-Object { $_.name -ceq $localized.button }) }
            if (-not $localized -or -not $localized.button) {
                $buttons = @($buttons | Where-Object { $_.semanticRole -ceq $profile.action })
            }
            foreach ($button in $buttons) { $matches += @{ window=$window; control=$button } }
        }
    }
    return $matches
}

function Same-WatcherTarget($Left, $Right) {
    return $Left.name -ceq $Right.name -and $Left.creationId -ceq $Right.creationId -and
        $Left.fileId -ceq $Right.fileId -and [string]$Left.commandId -ceq [string]$Right.commandId
}

function Get-TextSha256([string]$Value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))).Replace('-', '').ToLowerInvariant()) }
    finally { $sha.Dispose() }
}

function WatcherProcessMatches($Candidate, $Request) {
    $baseMatch = $Candidate.requestId -ceq $Request.requestId -and
        $Candidate.lease.requestId -ceq $Request.leaseBinding.requestId -and
        (Get-TextSha256 ([string]$Candidate.lease.id)) -ceq $Request.leaseBinding.idHash -and
        $Candidate.lease.operationId -ceq $Request.leaseBinding.operationId -and
        $Candidate.intent -ceq $Request.intent -and
        $Candidate.profile.profileId -ceq $Request.profileId -and
        (Same-WatcherTarget $Candidate.lease.target $Request.leaseBinding.target) -and
        (Same-WatcherTarget $Candidate.expectedIdentity $Request.expectedIdentity)
    if (-not $baseMatch) { return $false }
    if ($Request.lifecycleRecord -and
        [string]$Candidate.lifecycleId -cne [string]$Request.lifecycleId) { return $false }
    $life = $Request.lifecycleRecord
    if ($life -and $life.fusionProcess) {
        if ([int]$Candidate.processId -ne [int]$life.fusionProcess.processId -or
            [string]$Candidate.expectedProcessStartTicks -cne [string]$life.fusionProcess.processStartTicks -or
            [long]$Candidate.expectedMainWindowHandle -ne [long]$life.fusionProcess.mainWindowHandle) { return $false }
    }
    return $true
}

function WatcherProcessStatus($Request) {
    if ($Request.lifecycleFile -and (Test-Path -LiteralPath $Request.lifecycleFile)) {
        try {
            $record = Get-Content -LiteralPath $Request.lifecycleFile -Raw | ConvertFrom-Json
        } catch {
            return @{status='unknown';actionSubmitted=$null;operationOutcome='unknown';
                unavailableEvidence=@('private watcher lifecycle receipt is unreadable')}
        }
        if ($record.lifecycleId -cne $Request.lifecycleId -or $record.requestId -cne $Request.requestId -or
            $record.leaseHash -cne $Request.leaseHash -or $record.intent -cne $Request.intent -or
            $record.profileId -cne $Request.profileId -or
            -not (Same-WatcherTarget $record.target $Request.expectedIdentity)) {
            return @{status='blocked';actionSubmitted=$false;operationOutcome='unknown';
                unavailableEvidence=@('private watcher lifecycle identity does not match exact request')}
        }
        if ($record.state -ceq 'finished') {
            $hostStatus = 'notRequested'
            if ($Request.checkHostProcess) {
                $hostStatus = 'unknown'
                if ($record.hostProcess.processId -and $record.hostProcess.startTimeTicks) {
                    try {
                        $process = Get-Process -Id ([int]$record.hostProcess.processId) -ErrorAction Stop
                        $currentTicks = [string]$process.StartTime.ToUniversalTime().Ticks
                        if ($currentTicks -ceq [string]$record.hostProcess.startTimeTicks -and
                            $process.ProcessName -match '^(powershell|pwsh)$') { $hostStatus = 'runningAfterReceipt' }
                        else { $hostStatus = 'pidReusedOrDifferentProcess' }
                    } catch { $hostStatus = 'notRunning' }
                }
            }
            return @{status='terminal';actionSubmitted=$record.result.actionSubmitted;
                dialogClosed=$record.result.dialogClosed;operationOutcome=$record.result.operationOutcome;
                watcherState='finished';watcherResult=$record.result;hostProcess=$record.hostProcess;
                hostProcessStatus=$hostStatus;unavailableEvidence=@()}
        }
    }

    $watcherMatches = New-Object System.Collections.ArrayList
    $unreadable = New-Object System.Collections.ArrayList
    try { $processes = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'") }
    catch { return @{status='unknown';actionSubmitted=$null;operationOutcome='unknown';
        unavailableEvidence=@('host process table could not be read') } }
    foreach ($process in $processes) {
        $line = [string]$process.CommandLine
        if (-not $line) { $null = $unreadable.Add([int]$process.ProcessId); continue }
        if ($line -notmatch '(?i)ui_dialog\.ps1' -or
            $line -notmatch '(?i)(?:^|\s)-Mode\s+"?watch"?(?:\s|$)') { continue }
        $argument = [regex]::Match($line, '(?i)(?:^|\s)-RequestBase64\s+(?:"(?<quoted>[A-Za-z0-9+/=]+)"|(?<plain>[A-Za-z0-9+/=]+))(?:\s|$)')
        if (-not $argument.Success) { $null = $unreadable.Add([int]$process.ProcessId); continue }
        $encoded = if ($argument.Groups['quoted'].Success) { $argument.Groups['quoted'].Value } else { $argument.Groups['plain'].Value }
        try {
            $payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
        } catch { $null = $unreadable.Add([int]$process.ProcessId); continue }
        if (-not (WatcherProcessMatches $payload $Request)) { continue }
        try {
            $hostProcess = Get-Process -Id ([int]$process.ProcessId) -ErrorAction Stop
            $startTicks = [string]$hostProcess.StartTime.ToUniversalTime().Ticks
        } catch { $null = $unreadable.Add([int]$process.ProcessId); continue }
        $recordedHost = $Request.lifecycleRecord.hostProcess
        if ($recordedHost.processId -and [int]$recordedHost.processId -ne [int]$process.ProcessId) {
            $null = $unreadable.Add([int]$process.ProcessId); continue
        }
        if ($recordedHost.startTimeTicks -and [string]$recordedHost.startTimeTicks -cne $startTicks) {
            $null = $unreadable.Add([int]$process.ProcessId); continue
        }
        $null = $watcherMatches.Add(@{processId=[int]$process.ProcessId;startTimeTicks=$startTicks;
            executablePath=[string]$process.ExecutablePath;profileId=[string]$payload.profile.profileId;
            fusionProcessId=$payload.processId;fusionProcessStartTicks=$payload.expectedProcessStartTicks;
            fusionMainWindowHandle=$payload.expectedMainWindowHandle})
    }
    if ($watcherMatches.Count -gt 1) {
        return @{status='ambiguous';actionSubmitted=$null;operationOutcome='unknown';
            candidates=@($watcherMatches.ToArray());unavailableEvidence=@()}
    }
    if ($watcherMatches.Count -eq 1) {
        return @{status='running';actionSubmitted=$null;operationOutcome='notEvaluated';
            requestId=$Request.requestId;process=$watcherMatches[0];unavailableEvidence=@()}
    }
    if ($unreadable.Count -gt 0) {
        return @{status='unknown';actionSubmitted=$null;operationOutcome='unknown';
            unavailableEvidence=@('PowerShell process identity was incomplete; exact watcher absence not established')}
    }
    return @{status='notRunning';actionSubmitted=$null;operationOutcome='unknown';requestId=$Request.requestId;
        unavailableEvidence=@('no exact watcher process is running; this is not a terminal Fusion-operation receipt')}
}

function Invoke-WatcherStatus($Request) {
    if (-not $Request.leaseBinding -or
        $Request.leaseBinding.requestId -cne $Request.requestId -or
        $Request.leaseBinding.target.name -cne $Request.expectedIdentity.name -or
        $Request.leaseBinding.target.creationId -cne $Request.expectedIdentity.creationId -or
        $Request.leaseBinding.target.fileId -cne $Request.expectedIdentity.fileId -or
        -not $Request.leaseBinding.idHash -or -not $Request.leaseBinding.operationId -or
        (-not $Request.expectedIdentity.creationId -and -not $Request.expectedIdentity.fileId) -or
        -not $Request.requestId -or -not $Request.profileId -or -not $Request.intent) {
        return @{status='blocked';actionSubmitted=$false;operationOutcome='unknown';
            unavailableEvidence=@('status query request, lease and exact target binding do not match')}
    }
    return WatcherProcessStatus $Request
}

function Invoke-Watcher($Request) {
    if ($Request.lease.requestId -cne $Request.requestId -or
        $Request.lease.target.name -cne $Request.expectedIdentity.name -or
        $Request.lease.target.creationId -cne $Request.expectedIdentity.creationId -or
        $Request.lease.target.fileId -cne $Request.expectedIdentity.fileId -or
        -not $Request.expectedIdentity.name -or
        (-not $Request.expectedIdentity.creationId -and -not $Request.expectedIdentity.fileId)) {
        Emit-Watcher $Request @{status='blocked';actionSubmitted=$false;operationOutcome='notEvaluated';unavailableEvidence=@('watcher request, lease and pinned document identity do not match')}; return
    }
    if ($Request.lifecycleFile) {
        try { $lifecycleStarted = Write-WatcherLifecycle $Request 'running' $null }
        catch { Emit @{status='blocked';actionSubmitted=$false;operationOutcome='notEvaluated';unavailableEvidence=@('durable watcher lifecycle start receipt failed')}; return }
        if (-not $lifecycleStarted) {
            Emit @{status='blocked';actionSubmitted=$false;operationOutcome='notEvaluated';unavailableEvidence=@('durable watcher lifecycle identity did not match')}; return
        }
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Min([Math]::Max(1,[int]$Request.timeBudgetMs),120000))
    $readyEmitted = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$Request.lease.expiresAt) {
            Emit-Watcher $Request @{status='blocked';actionSubmitted=$false;operationOutcome='notEvaluated';unavailableEvidence=@('watcher lease expired before UI action')}; return
        }
        try { $snapshot = Get-Snapshot $Request }
        catch { Start-Sleep -Milliseconds 100; continue }
        if ($snapshot.status -ne 'ready') { Emit-Watcher $Request @{status=$snapshot.status;actionSubmitted=$false;operationOutcome='notEvaluated';unavailableEvidence=$snapshot.unavailableEvidence}; return }
        if (-not $readyEmitted) {
            [Console]::Out.WriteLine('FMCAD_UI_WATCHER_READY ' + (@{requestId=$Request.requestId;lifecycleId=$Request.lifecycleId} | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
            $readyEmitted = $true
        }
        if ($Request.completionFile -and (Test-Path -LiteralPath $Request.completionFile)) {
            Emit-Watcher $Request @{status='nothingToDo';actionSubmitted=$false;operationOutcome='notEvaluated';unavailableEvidence=@()}; return
        }
        # A one-shot private watcher invokes only one exact qualified profile.
        # It runs UIAutomation only; the owning SDK caller remains responsible for
        # pumping adsk.doEvents on Fusion's main thread while its native command waits.
        try { $matches = @(Find-ProfileButtons $snapshot $Request) }
        catch { Start-Sleep -Milliseconds 100; continue }
        if ($matches.Count -gt 1) { Emit-Watcher $Request @{status='ambiguous';actionSubmitted=$false;operationOutcome='notEvaluated';candidates=@($matches.Count)}; return }
        if ($matches.Count -eq 1) {
            $actionRequest = @{}
            foreach ($property in $Request.PSObject.Properties) { $actionRequest[$property.Name] = $property.Value }
            $actionRequest.windowHandle = $matches[0].window.handle
            $actionRequest.control = $matches[0].control
            $result = Invoke-ObservedControl $actionRequest
            Emit-Watcher $Request $result; return
        }
        Start-Sleep -Milliseconds 100
    }
    Emit-Watcher $Request @{status='unknown';actionSubmitted=$null;operationOutcome='notEvaluated';unavailableEvidence=@('one-shot watcher budget elapsed; Fusion command was not cancelled')}
}

try {
    $requestText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64))
    $request = $requestText | ConvertFrom-Json
    if ($Mode -eq 'inspect') { Emit (Get-Snapshot $request); exit 0 }
    if ($Mode -eq 'respond') {
        $response = Invoke-ObservedControl $request
        if ($request.lifecycleFile) { Emit-Watcher $request $response } else { Emit $response }
        exit 0
    }
    if ($Mode -eq 'watch-status') { Emit-WatcherStatus (Invoke-WatcherStatus $request); exit 0 }
    Invoke-Watcher $request
    exit 0
} catch {
    if ($Mode -eq 'watch-status') {
        Emit-WatcherStatus @{status='unknown';actionSubmitted=$null;operationOutcome='unknown';
            unavailableEvidence=@('read-only Windows process status query failed: ' + $_.Exception.GetType().Name)}
        exit 1
    }
    if ($Mode -eq 'watch' -and $null -ne $request) {
        try { Write-WatcherLifecycle $request 'finished' @{status='unknown';actionSubmitted=$null;
            operationOutcome='notEvaluated';unavailableEvidence=@('watcher helper terminated with an unhandled host error')} } catch {}
    }
    Emit @{status='blocked';actionSubmitted=$false;unavailableEvidence=@('UIAutomation adapter error: ' + $_.Exception.GetType().Name)}
    exit 1
}
