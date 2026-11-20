# Read-only collector for the energy audit: CIM/WMI classes, registry values, event logs and process samples, printed
# as one JSON object. It changes nothing on the machine. Class names, registry values and event fields are
# language-independent, unlike powercfg's text (parsed in parse.mjs).
# Personal data stays here: command lines are reduced to flags, serial numbers are never read, paths are cut to a
# file name or to a category before they are printed.
# The JSON goes to -OutFile in UTF-8: the console's code page is left alone, and PowerShell decodes powercfg's
# output with that same OEM code page.
param([int]$SampleSeconds = 5, [Parameter(Mandatory = $true)][string]$OutFile)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$out = [ordered]@{ _ms = [ordered]@{} }
function Section([string]$name, [scriptblock]$body) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  try { $out[$name] = & $body } catch { $out[$name] = @{ error = $_.Exception.Message } }
  $out['_ms'][$name] = $t.ElapsedMilliseconds
}
# On failure TryGet emits nothing at all: a $null would count as one item in @(...) and run pipelines once.
function TryGet([scriptblock]$body) { try { & $body } catch { } }
# File name of the program a command line starts; nothing when it cannot be told apart from its arguments.
function Leaf([string]$path) {
  if (-not $path) { return $null }
  $m = [regex]::Match($path.Trim(), '^"?([^"]*?\.(exe|lnk|bat|cmd|ps1|vbs|dll|url|msc|com))(?=["\s]|$)', 'IgnoreCase')
  if (-not $m.Success) { return $null }
  return [regex]::Match($m.Groups[1].Value, '[^\\/]*$').Value
}

Section 'system' {
  $cs = Get-CimInstance Win32_ComputerSystem
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = @(Get-CimInstance Win32_Processor)
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  [ordered]@{
    manufacturer = $cs.Manufacturer
    model = $cs.Model
    pcSystemType = [int]$cs.PCSystemType
    chassisTypes = @((Get-CimInstance Win32_SystemEnclosure).ChassisTypes | ForEach-Object { [int]$_ })
    hypervisorPresent = [bool]$cs.HypervisorPresent
    cpu = $cpu[0].Name.Trim()
    cores = ($cpu | Measure-Object NumberOfCores -Sum).Sum
    logicalProcessors = [int]$cs.NumberOfLogicalProcessors
    ramGB = [Math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    freeRamGB = [Math]::Round($os.FreePhysicalMemory * 1KB / 1GB, 1)
    gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
      [ordered]@{ name = $_.Name; refreshHz = $_.CurrentRefreshRate; width = $_.CurrentHorizontalResolution; height = $_.CurrentVerticalResolution }
    })
    os = $os.Caption
    build = $os.BuildNumber
    uptimeHours = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    isAdmin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
}

# GetPwrCapabilities fills SYSTEM_POWER_CAPABILITIES (winnt.h): BOOLEAN fields at fixed offsets.
Section 'capabilities' {
  Add-Type -Namespace EnergyAudit -Name Power -MemberDefinition '[DllImport("powrprof.dll")] public static extern bool GetPwrCapabilities(byte[] caps);'
  $b = New-Object byte[] 128
  if (-not [EnergyAudit.Power]::GetPwrCapabilities($b)) { throw 'GetPwrCapabilities failed' }
  [ordered]@{
    powerButton = [bool]$b[0]; sleepButton = [bool]$b[1]; lidPresent = [bool]$b[2]
    s1 = [bool]$b[3]; s2 = [bool]$b[4]; s3 = [bool]$b[5]; s4 = [bool]$b[6]; s5 = [bool]$b[7]
    hiberFilePresent = [bool]$b[8]; thermalControl = [bool]$b[13]; processorThrottle = [bool]$b[14]
    fastStartup = [bool]$b[18]; wakeAlarm = [bool]$b[19]; aoac = [bool]$b[20]; aoacConnectivity = [bool]$b[23]
    batteriesPresent = [bool]$b[30]; batteriesShortTerm = [bool]$b[31]
  }
}

Section 'powerMode' {
  $k = TryGet { Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes' }
  $s = TryGet { Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' }
  [ordered]@{
    # powercfg prints the plan name in the OEM code page, which loses characters such as the trademark sign.
    activePlanName = TryGet { (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\$($k.ActivePowerScheme)").FriendlyName }
    overlayAc = $k.ActiveOverlayAcPowerScheme
    overlayDc = $k.ActiveOverlayDcPowerScheme
    hiberbootEnabled = $s.HiberbootEnabled
  }
}

Section 'powerStatus' {
  $null = [Windows.System.Power.PowerManager, Windows.System.Power, ContentType = WindowsRuntime]
  $pm = [Windows.System.Power.PowerManager]
  [ordered]@{
    energySaver = "$($pm::EnergySaverStatus)"
    battery = "$($pm::BatteryStatus)"
    supply = "$($pm::PowerSupplyStatus)"
    percent = $pm::RemainingChargePercent
    dischargeMinutes = TryGet { [Math]::Round($pm::RemainingDischargeTime.TotalMinutes) }
  }
}

Section 'battery' {
  $wmi = { param($c) TryGet { @(Get-CimInstance -Namespace root/wmi -ClassName $c) } }
  $static = & $wmi 'BatteryStaticData'
  $full = & $wmi 'BatteryFullChargedCapacity'
  $cycles = & $wmi 'BatteryCycleCount'
  $status = & $wmi 'BatteryStatus'
  @(Get-CimInstance Win32_Battery | ForEach-Object -Begin { $i = 0 } -Process {
    [ordered]@{
      chemistry = $_.Chemistry
      percent = $_.EstimatedChargeRemaining
      manufacturer = if ($static) { $static[$i].ManufactureName } else { $null }
      designMWh = if ($static) { $static[$i].DesignedCapacity } else { $null }
      fullMWh = if ($full) { $full[$i].FullChargedCapacity } else { $null }
      cycles = if ($cycles) { $cycles[$i].CycleCount } else { $null }
      remainingMWh = if ($status) { $status[$i].RemainingCapacity } else { $null }
      dischargeMW = if ($status) { $status[$i].DischargeRate } else { $null }
      chargeMW = if ($status) { $status[$i].ChargeRate } else { $null }
      onAc = if ($status) { [bool]$status[$i].PowerOnline } else { $null }
    }
    $i++
  })
}

# Two samples $SampleSeconds apart: CPU time and I/O deltas per process, plus the GPU engines' load at the end.
Section 'processes' {
  $snap = {
    $cpu = @{}; Get-Process | ForEach-Object { $cpu[$_.Id] = TryGet { $_.TotalProcessorTime.TotalSeconds } }
    $io = @{}; Get-CimInstance Win32_Process -Property ProcessId, ReadTransferCount, WriteTransferCount, OtherTransferCount | ForEach-Object {
      $io[[int]$_.ProcessId] = [double]$_.ReadTransferCount + [double]$_.WriteTransferCount + [double]$_.OtherTransferCount
    }
    # GPU engines: running time and its clock (raw counters), turned into a load over the same window below.
    $eng = @{}; TryGet { Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine } | Where-Object { $_.Name } | ForEach-Object {
      $eng[$_.Name] = @([double]$_.UtilizationPercentage, [double]$_.Timestamp_Sys100NS)
    }
    @{ cpu = $cpu; io = $io; eng = $eng; t = [Diagnostics.Stopwatch]::GetTimestamp() }
  }
  $a = & $snap
  Start-Sleep -Seconds $SampleSeconds
  $b = & $snap
  $secs = ($b.t - $a.t) / [Diagnostics.Stopwatch]::Frequency
  $gpu = @{}
  foreach ($name in $b.eng.Keys) {
    $m = [regex]::Match($name, 'pid_(\d+)_.*engtype_(\w+)')
    $e0 = $a.eng[$name]; $e1 = $b.eng[$name]
    if ($m.Success -and $e0 -and $e1 -and $e1[1] -gt $e0[1]) {
      $key = "$($m.Groups[1].Value)|$($m.Groups[2].Value)"
      $gpu[$key] = [double]$gpu[$key] + 100 * ($e1[0] - $e0[0]) / ($e1[1] - $e0[1])
    }
  }
  $gpuByPid = @{}
  foreach ($k in $gpu.Keys) { $p = [int]$k.Split('|')[0]; $gpuByPid[$p] = [Math]::Max([double]$gpuByPid[$p], $gpu[$k]) }
  $procs = @{}; Get-Process | ForEach-Object { $procs[$_.Id] = $_ }
  $info = @{}; Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine, ExecutablePath, SessionId | ForEach-Object { $info[[int]$_.ProcessId] = $_ }
  $hubPattern = 'claude|ai_box|ai-box|claude-hub|AI Box'
  $list = foreach ($id in $procs.Keys) {
    $p = $procs[$id]; $w = $info[[int]$id]
    $c0 = $a.cpu[$id]; $c1 = $b.cpu[$id]
    $i0 = $a.io[[int]$id]; $i1 = $b.io[[int]$id]
    $exe = if ($w) { $w.ExecutablePath } else { $null }
    [ordered]@{
      pid = [int]$id
      ppid = if ($w) { [int]$w.ParentProcessId } else { $null }
      name = $p.ProcessName
      session = $p.SessionId
      cpuSec = if ($c0 -ne $null -and $c1 -ne $null) { [Math]::Round($c1 - $c0, 3) } else { $null }
      totalCpuSec = if ($c1 -ne $null) { [Math]::Round($c1) } else { $null }
      wsMB = [Math]::Round($p.WorkingSet64 / 1MB, 1)
      privateMB = [Math]::Round($p.PrivateMemorySize64 / 1MB, 1)
      ioBytes = if ($i0 -ne $null -and $i1 -ne $null) { [Math]::Max(0, $i1 - $i0) } else { $null }
      gpuPct = $gpuByPid[[int]$id]
      hasWindow = $p.MainWindowHandle -ne [IntPtr]::Zero
      system = [bool]($exe -and $exe -like "$env:SystemRoot\*")
      hubLike = [bool](($w -and $w.CommandLine -match $hubPattern) -or $p.ProcessName -match '^claude$')
    }
  }
  [ordered]@{ seconds = [Math]::Round($secs, 2); list = @($list) }
}

Section 'startup' {
  $approved = @{}
  foreach ($root in 'HKCU:', 'HKLM:') {
    foreach ($sub in 'Run', 'Run32', 'StartupFolder') {
      $k = TryGet { Get-Item "$root\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\$sub" }
      if ($k) { foreach ($v in $k.GetValueNames()) { $bytes = $k.GetValue($v); if ($bytes -is [byte[]] -and $bytes.Length) { $approved["$root|$v"] = ($bytes[0] % 2) -eq 0 } } }
    }
  }
  $commands = @(Get-CimInstance Win32_StartupCommand | ForEach-Object {
    $root = if ($_.Location -like 'HKLM*' -or $_.Location -like 'Common*' -or $_.User -match 'Public|All Users') { 'HKLM:' } else { 'HKCU:' }
    $where = if ($_.Location -match 'Startup') { 'startup-folder' } elseif ($_.Location -match 'RunOnce') { 'runonce' } else { 'run' }
    $file = Leaf $_.Command
    $enabled = $approved["$root|$($_.Name)"]
    if ($enabled -eq $null) { $enabled = $approved["$root|$file"] }
    [ordered]@{ name = $_.Name; exe = $file; where = $where; scope = if ($root -eq 'HKLM:') { 'machine' } else { 'user' }; enabled = if ($enabled -eq $null) { $true } else { $enabled } }
  })
  $store = @(TryGet {
    Get-ChildItem 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData' |
      ForEach-Object { Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue } |
      Where-Object { $_.GetValue('State') -ne $null } |
      ForEach-Object { [ordered]@{ name = ($_.PSParentPath -split '\\')[-1] -replace '_[a-z0-9]{13}$', ''; task = $_.PSChildName; enabled = @(2, 4) -contains [int]$_.GetValue('State') } }
  })
  $tasks = @(Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' } | ForEach-Object {
    $t = $_
    $kinds = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task|Trigger$', '' })
    $logon = $kinds -contains 'Logon' -or $kinds -contains 'Boot'
    $wake = [bool]$t.Settings.WakeToRun
    $thirdParty = $t.TaskPath -notlike '\Microsoft\*'
    if (($logon -and $thirdParty) -or $wake) {
      [ordered]@{ name = $t.TaskName; path = $t.TaskPath; thirdParty = $thirdParty; triggers = $kinds; wakeToRun = $wake; exe = Leaf (@($t.Actions)[0].Execute) }
    }
  })
  $services = @(Get-CimInstance Win32_Service -Filter "StartMode='Auto'" | ForEach-Object {
    $exe = if ($_.PathName -match '^"([^"]+)"') { $Matches[1] } else { ($_.PathName -split ' ')[0] }
    $company = TryGet { (Get-Item -LiteralPath $exe).VersionInfo.CompanyName }
    if ($company -notmatch 'Microsoft' -and $exe -notlike "$env:SystemRoot\*") {
      [ordered]@{ name = $_.Name; display = $_.DisplayName; state = $_.State; delayed = [bool]$_.DelayedAutoStart; company = $company; exe = Leaf $exe }
    }
  })
  [ordered]@{ commands = $commands; store = $store; tasks = $tasks; services = $services }
}

Section 'wake' {
  $since = (Get-Date).AddDays(-14)
  $data = { param($e) $h = @{}; foreach ($d in ([xml]$e.ToXml()).Event.EventData.Data) { $h[$d.Name] = $d.'#text' }; $h }
  $wakes = @(TryGet { Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1; StartTime = $since } } | Where-Object { $_ } | ForEach-Object {
    $d = & $data $_
    # The message's last line names the wake source in the system language; the event data often leaves it empty.
    $lines = @($_.Message -split "`r?`n" | Where-Object { $_.Trim() })
    [ordered]@{
      at = $_.TimeCreated.ToString('s'); sleepTime = $d['SleepTime']; wakeTime = $d['WakeTime']
      sourceType = $d['WakeSourceType']; source = $d['WakeSourceText']; timerOwner = $d['WakeTimerOwner']
      message = if ($lines.Count) { $lines[-1].Trim() } else { $null }
    }
  })
  $count = { param($id) @(TryGet { Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = $id; StartTime = $since } }).Count }
  [ordered]@{
    days = 14
    wakes = $wakes
    sleeps = & $count 42
    resumes = & $count 107
    modernStandbyEnter = & $count 506
    modernStandbyExit = & $count 507
    unexpectedShutdowns = & $count 41
  }
}

Section 'network' {
  $pm = @{}
  TryGet { Get-NetAdapterPowerManagement } | Where-Object { $_ } | ForEach-Object { $pm[$_.Name] = $_ }
  @(Get-NetAdapter -Physical | ForEach-Object {
    $p = $pm[$_.Name]
    [ordered]@{
      description = $_.InterfaceDescription
      media = "$($_.PhysicalMediaType)"
      status = "$($_.Status)"
      speed = $_.LinkSpeed
      wakeOnMagicPacket = if ($p) { "$($p.WakeOnMagicPacket)" } else { $null }
      wakeOnPattern = if ($p) { "$($p.WakeOnPattern)" } else { $null }
      allowTurnOff = if ($p) { "$($p.AllowComputerToTurnOffDevice)" } else { $null }
    }
  })
}

Section 'radios' {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
  $type = [Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @([Windows.Devices.Radios.Radio]::GetRadiosAsync()))
  if (-not $task.Wait(5000)) { throw 'radio list timed out' }
  @($task.Result | Where-Object { $_ } | ForEach-Object { [ordered]@{ kind = "$($_.Kind)"; state = "$($_.State)" } })
}

Section 'display' {
  $b = TryGet { @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness) }
  [ordered]@{
    monitors = @(TryGet { Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams }).Count
    brightness = if ($b) { @($b | ForEach-Object { [int]$_.CurrentBrightness }) } else { @() }
    transparency = TryGet { (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize').EnableTransparency }
  }
}

Section 'background' {
  $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications'
  $apps = @(TryGet { Get-ChildItem $root })
  $off = @($apps | Where-Object { $_.GetValue('Disabled') -eq 1 -or $_.GetValue('DisabledByUser') -eq 1 }).Count
  [ordered]@{
    globalDisabled = TryGet { (Get-ItemProperty $root).GlobalUserDisabled }
    policy = TryGet { (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy').LetAppsRunInBackground }
    apps = $apps.Count
    disabled = $off
    gameDvr = TryGet { (Get-ItemProperty 'HKCU:\System\GameConfigStore').GameDVR_Enabled }
    appCapture = TryGet { (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR').AppCaptureEnabled }
    edgeStartupBoost = TryGet { (Get-ItemProperty 'HKCU:\Software\Policies\Microsoft\Edge').StartupBoostEnabled }
    edgeBackgroundMode = TryGet { (Get-ItemProperty 'HKCU:\Software\Policies\Microsoft\Edge').BackgroundModeEnabled }
  }
}

Section 'storage' {
  @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [ordered]@{ drive = $_.DeviceID; fs = $_.FileSystem; sizeGB = [Math]::Round($_.Size / 1GB, 1); freeGB = [Math]::Round($_.FreeSpace / 1GB, 1) }
  })
}

# Read-only powercfg switches only. The battery report is written to a private temporary folder, read, then removed.
function Pcfg([string[]]$a) {
  $ErrorActionPreference = 'Continue'
  $text = (& powercfg.exe @a 2>&1 | Out-String)
  [ordered]@{ status = $LASTEXITCODE; text = $text }
}
Section 'powercfg' {
  $r = [ordered]@{
    query = Pcfg @('/qh', 'SCHEME_CURRENT')
    states = Pcfg @('/a')
    lastWake = Pcfg @('/lastwake')
    wakeArmed = Pcfg @('/devicequery', 'wake_armed')
  }
  if ($out['system'].isAdmin) {
    $r.requests = Pcfg @('/requests')
    $r.wakeTimers = Pcfg @('/waketimers')
  }
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('energy-audit-' + [guid]::NewGuid().ToString('N'))
  try {
    $null = New-Item -ItemType Directory -Path $dir
    $file = Join-Path $dir 'battery.xml'
    $b = Pcfg @('/batteryreport', '/xml', '/output', $file)
    # The machine's name and the battery's serial number never leave this script.
    $xml = if (Test-Path $file) { [IO.File]::ReadAllText($file) -replace '<(SerialNumber|ComputerName)>[^<]*</(SerialNumber|ComputerName)>', '' } else { $null }
    $r.battery = [ordered]@{ status = $b.status; xml = $xml }
  } finally {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $r
}

[IO.File]::WriteAllText($OutFile, ($out | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding $false))
