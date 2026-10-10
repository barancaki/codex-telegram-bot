param(
    [ValidateSet('Start', 'Stop', 'Status', 'Setup', 'Shortcuts', 'SelfTest')]
    [string]$Action = 'Status',
    [string]$Workspace,
    [string]$DevelopmentRoot,
    [switch]$Notify
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $root 'src/index.ts'
$runtime = Join-Path $root 'logs/manual'
$stateFile = Join-Path $runtime 'instance.json'

function Test-Identity($process, $cim, $state) {
    return $process.StartTime.ToUniversalTime().Ticks -eq [long]$state.startedTicks -and
        $process.Path -eq $state.executable -and $cim.Name -eq 'node.exe' -and
        $cim.CommandLine.Contains('"' + $entry + '"')
}

function Get-Owner {
    if (!(Test-Path -LiteralPath $stateFile)) { return $null }
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($state.pid -le 0 -or $state.pid -gt [int]::MaxValue) { throw 'Invalid instance state; no process was stopped.' }
    $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if (!$process) { return $null }
    try {
        $null = $process.Handle # Hold the handle so a recycled PID cannot become our target.
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
        if (!$cim -or !(Test-Identity $process $cim $state)) {
            $process.Dispose()
            throw 'Instance identity changed; no process was stopped. Check logs/manual/instance.json.'
        }
        return $process
    } catch { $process.Dispose(); throw }
}

function Stop-OwnedTree($process) {
    $children = @()
    try {
        $created = $process.StartTime.ToUniversalTime()
        # Keep the parent's handle through the second scan to exclude PID reuse.
        if (!$process.HasExited) { $process.Kill() }
        $process.WaitForExit(5000) | Out-Null
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)")) {
            $descendant = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            if (!$descendant) { continue }
            try {
                $null = $descendant.Handle
                if ($descendant.StartTime.ToUniversalTime() -lt $created -or
                    [Math]::Abs($descendant.StartTime.ToUniversalTime().Ticks - $child.CreationDate.ToUniversalTime().Ticks) -gt 10) {
                    $descendant.Dispose()
                    continue
                }
                $children += $descendant
            } catch { $descendant.Dispose(); throw }
        }
        foreach ($childProcess in $children) { Stop-OwnedTree $childProcess }
    } finally {
        foreach ($childProcess in $children) { $childProcess.Dispose() }
    }
}

function Set-EnvValue([string]$content, [string]$key, [string]$value) {
    if ($value -match "[\r\n']") { throw 'Configuration values cannot contain newlines or single quotes.' }
    $line = $key + "='" + $value + "'"
    $pattern = '(?m)^' + [regex]::Escape($key) + '=.*$'
    if ([regex]::IsMatch($content, $pattern)) {
        return [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $line })
    }
    return $content.TrimEnd() + "`r`n" + $line + "`r`n"
}

$mutexName = 'Local\CodexTelegramManual-' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($root)).Replace('/', '_')
$mutex = New-Object Threading.Mutex($false, $mutexName)
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Another Start/Stop/Setup is already in progress.' }
    switch ($Action) {
        'Start' {
            $owner = Get-Owner
            if ($owner) { $owner.Dispose(); Write-Output 'Bot is already running.'; break }
            if (!(Test-Path -LiteralPath (Join-Path $root '.env'))) { throw 'Run the Codex Telegram Setup shortcut first (token and your numeric Telegram user ID).' }
            $env:CODEX_TG_DIR = $root
            $env:CODEX_TRUST_ALL_TOOLS = 'false'
            $env:AUTO_UPDATE = 'false'
            $env:ACP_AUTO_RESTART = 'false'
            $env:SCHEDULED_TASKS = 'false'
            $env:CODEX_TG_SINGLE_INSTANCE = 'true'
            $env:LOG_DIR = $runtime
            $env:LOG_FILE = Join-Path $runtime 'bot.log'
            $env:DATA_DIR = Join-Path $root 'data/manual'
            $node = (Get-Command node.exe -ErrorAction Stop).Source
            Push-Location $root
            try {
                & $node --import tsx (Join-Path $PSScriptRoot 'check-config.ts')
                if ($LASTEXITCODE -ne 0) { throw 'Configuration is incomplete. Run Setup; ALLOWED_USERS must be your numeric Telegram user ID.' }
                New-Item -ItemType Directory -Path $runtime -Force | Out-Null
                $process = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', ('"' + $entry + '"'), '--instance', ('"' + $root + '"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'stdout.log') -RedirectStandardError (Join-Path $runtime 'stderr.log') -PassThru
                $null = $process.Handle
                @{ pid = $process.Id; startedTicks = $process.StartTime.ToUniversalTime().Ticks; executable = $node } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
                Start-Sleep -Milliseconds 1200
                if ($process.HasExited) { throw ('Startup failed. See ' + (Join-Path $runtime 'stderr.log')) }
                $process.Dispose()
                Write-Output ('Bot started manually. Logs: ' + $runtime)
            } finally { Pop-Location }
        }
        'Stop' {
            $owner = Get-Owner
            if (!$owner) { Write-Output 'Bot is already stopped.'; break }
            try { Stop-OwnedTree $owner } finally { $owner.Dispose() }
            Remove-Item -LiteralPath $stateFile -Force
            Write-Output 'Bot and its owned child processes stopped.'
        }
        'Status' {
            $owner = Get-Owner
            if ($owner) { Write-Output ('Running: PID ' + $owner.Id); $owner.Dispose() }
            else { Write-Output 'Stopped.' }
        }
        'Setup' {
            $owner = Get-Owner
            if ($owner) { $owner.Dispose(); throw 'Stop the bot before editing configuration.' }
            $envPath = Join-Path $root '.env'
            $content = if (Test-Path -LiteralPath $envPath) { Get-Content -LiteralPath $envPath -Raw } else { Get-Content -LiteralPath (Join-Path $root '.env.example') -Raw }
            $secret = Read-Host 'BotFather token (masked; blank keeps existing token)' -AsSecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
            try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim() }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secret.Dispose() }
            if ($token) {
                if ($token -notmatch '^\d+:[A-Za-z0-9_-]+$') { throw 'Invalid token format.' }
                $content = Set-EnvValue $content 'TELEGRAM_BOT_TOKEN' $token
            }
            $token = $null
            $ids = Read-Host 'Your numeric Telegram user ID (comma-separated IDs allowed; blank keeps existing)'
            if ($ids) {
                if ($ids -notmatch '^[1-9]\d*(\s*,\s*[1-9]\d*)*$') { throw 'Use positive numeric Telegram user IDs, not usernames or the bot ID.' }
                $content = Set-EnvValue $content 'ALLOWED_USERS' $ids
            }
            if ($Workspace) { $content = Set-EnvValue $content 'CODEX_WORKSPACE' $Workspace }
            if ($DevelopmentRoot -and $Workspace) { $content = Set-EnvValue $content 'PROJECT_ROOTS' ($DevelopmentRoot + ',' + $Workspace) }
            foreach ($key in @('AUTO_UPDATE', 'ACP_AUTO_RESTART', 'SCHEDULED_TASKS', 'CODEX_TRUST_ALL_TOOLS')) {
                $content = Set-EnvValue $content $key 'false'
            }
            [IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
            Write-Output 'Local .env saved. The bot was not started. Use Start when ready.'
        }
        'Shortcuts' {
            $desktop = [Environment]::GetFolderPath('DesktopDirectory')
            $shell = New-Object -ComObject WScript.Shell
            $labels = @{ Start = ('Ba' + [char]0x15F + 'lat'); Stop = 'Durdur'; Setup = 'Ayarlar' }
            foreach ($name in @('Start', 'Stop', 'Setup')) {
                $shortcut = $shell.CreateShortcut((Join-Path $desktop ('Codex Telegram ' + $labels[$name] + '.lnk')))
                $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
                $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $name
                if ($name -eq 'Setup') {
                    if ($Workspace) { $shortcut.Arguments += ' -Workspace "' + $Workspace + '"' }
                    if ($DevelopmentRoot) { $shortcut.Arguments += ' -DevelopmentRoot "' + $DevelopmentRoot + '"' }
                    $shortcut.Arguments = '-NoExit ' + $shortcut.Arguments
                    $shortcut.WindowStyle = 1
                } else { $shortcut.Arguments = '-WindowStyle Hidden ' + $shortcut.Arguments + ' -Notify'; $shortcut.WindowStyle = 7 }
                $shortcut.WorkingDirectory = $root
                $shortcut.Description = 'Manual ' + $name + '; no automatic startup.'
                $shortcut.Save()
            }
            Write-Output ('Shortcuts created on ' + $desktop)
        }
        'SelfTest' {
            $fake = @{ StartTime = [datetime]::UtcNow; Path = 'C:\node.exe' }
            $cim = @{ Name = 'node.exe'; CommandLine = 'node --import tsx "' + $entry + '"' }
            $state = @{ startedTicks = $fake.StartTime.Ticks; executable = $fake.Path }
            if (!(Test-Identity $fake $cim $state)) { throw 'Owned process rejected.' }
            $state.startedTicks++
            if (Test-Identity $fake $cim $state) { throw 'PID reuse accepted.' }
            $state.startedTicks--
            $cim.CommandLine = 'node "C:\unrelated\index.ts"'
            if (Test-Identity $fake $cim $state) { throw 'Unrelated worker accepted.' }
            $updated = Set-EnvValue "TELEGRAM_BOT_TOKEN=existing`nALLOWED_USERS=42`n" 'AUTO_UPDATE' 'false'
            if (!$updated.Contains('TELEGRAM_BOT_TOKEN=existing') -or !$updated.Contains("AUTO_UPDATE='false'")) { throw 'Environment preservation failed.' }
            Write-Output 'Manual lifecycle identity and secret-preservation self-check passed.'
        }
    }
} catch {
    if ($Notify) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex Telegram') | Out-Null
    }
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
