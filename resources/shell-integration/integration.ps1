# Zarya shell integration for Windows PowerShell 5.1 and PowerShell 7+.
# Emits OSC 133 (A/B/C/D) block marks, OSC 7 cwd reports and the Zarya
# private channel OSC 6973 (E = base64 command line + anti-spoofing nonce).
# Loaded via: powershell -NoExit -Command ". '<this file>'"

if ($Global:__ZaryaIntegrated) { return }
$Global:__ZaryaIntegrated = $true

$Global:__ZaryaState = @{
    LastHistoryId = -1
    Nonce         = $env:ZARYA_NONCE
}
# The nonce must not leak to child processes.
Remove-Item Env:ZARYA_NONCE -ErrorAction SilentlyContinue

$Global:__ZaryaEsc = [char]0x1b
$Global:__ZaryaBel = [char]0x07

function Global:__Zarya-ExitCode {
    if ($?) {
        if ($null -ne $LASTEXITCODE) { return $LASTEXITCODE }
        return 0
    }
    $lastEntry = Get-History -Count 1
    if ($Error.Count -gt 0 -and $lastEntry -and
        $Error[0].InvocationInfo -and
        $Error[0].InvocationInfo.HistoryId -eq $lastEntry.Id) {
        return 1
    }
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { return $LASTEXITCODE }
    return 1
}

function Global:__Zarya-CwdSeq {
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -ne 'FileSystem') { return '' }
    $p = $loc.ProviderPath -replace '\\', '/'
    if ($p -notmatch '^/') { $p = '/' + $p }
    # OSC 7 wants a file:// URL; keep it simple and percent-encode spaces only —
    # the terminal side decodes with decodeURI and tolerates unencoded unicode.
    $p = $p -replace ' ', '%20'
    return "$Global:__ZaryaEsc]7;file://localhost$p$Global:__ZaryaBel"
}

# Preserve a user-defined prompt if one exists.
if (Test-Path Function:\prompt) {
    $Global:__ZaryaOrigPrompt = $Function:prompt
}

function Global:prompt {
    $exitCode = __Zarya-ExitCode
    $lastEntry = Get-History -Count 1
    $historyId = if ($lastEntry) { $lastEntry.Id } else { -1 }

    $out = ''
    # D: finish mark for the previous command — only when one actually ran.
    if ($historyId -gt $Global:__ZaryaState.LastHistoryId -and $Global:__ZaryaState.LastHistoryId -ne -1) {
        $out += "$Global:__ZaryaEsc]133;D;$exitCode$Global:__ZaryaBel"
    } elseif ($Global:__ZaryaState.LastHistoryId -ne -1) {
        $out += "$Global:__ZaryaEsc]133;D$Global:__ZaryaBel"
    }
    $Global:__ZaryaState.LastHistoryId = $historyId

    $out += __Zarya-CwdSeq
    $out += "$Global:__ZaryaEsc]133;A$Global:__ZaryaBel"

    if ($Global:__ZaryaOrigPrompt) {
        try { $out += (& $Global:__ZaryaOrigPrompt | Out-String).TrimEnd("`r", "`n") }
        catch { $out += "PS $($ExecutionContext.SessionState.Path.CurrentLocation)> " }
    } else {
        $out += "PS $($ExecutionContext.SessionState.Path.CurrentLocation)$('>' * ($NestedPromptLevel + 1)) "
    }

    $out += "$Global:__ZaryaEsc]133;B$Global:__ZaryaBel"
    return $out
}

# C + E marks: PowerShell's only "about to execute" hook is the readline entrypoint.
if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
    Set-Item Function:Global:__ZaryaOrigReadLine -Value $Function:PSConsoleHostReadLine
    function Global:PSConsoleHostReadLine {
        $line = __ZaryaOrigReadLine
        if ($null -ne $line -and $line.Trim().Length -gt 0) {
            $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
            $nonce = $Global:__ZaryaState.Nonce
            [Console]::Out.Write("$Global:__ZaryaEsc]133;C$Global:__ZaryaBel")
            [Console]::Out.Write("$Global:__ZaryaEsc]6973;E;$b64;$nonce$Global:__ZaryaBel")
        }
        $line
    }
}
