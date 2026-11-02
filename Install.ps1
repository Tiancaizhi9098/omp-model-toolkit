[CmdletBinding()]
param([string]$OmpPath)

$ErrorActionPreference = 'Stop'
if (-not $OmpPath) {
    $ompCommand = Get-Command omp -ErrorAction SilentlyContinue
    if ($ompCommand) { $OmpPath = $ompCommand.Source }
    else {
        $bunOmp = Join-Path $env:USERPROFILE '.bun\bin\omp.exe'
        if (Test-Path -LiteralPath $bunOmp -PathType Leaf) { $OmpPath = $bunOmp }
    }
}
if (-not $OmpPath) { throw 'omp was not found. Pass -OmpPath with your omp executable.' }

function Invoke-OmpChecked {
    param([string[]]$OmpArgs)
    $result = (& $OmpPath @OmpArgs 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $result -match 'Failed to (link|enable|disable)|Error:') {
        throw "omp $($OmpArgs -join ' ') failed: $result"
    }
    return $result
}

$versionText = Invoke-OmpChecked @('--version')
$match = [regex]::Match($versionText, '\d+\.\d+\.\d+')
if (-not $match.Success) { throw "Cannot identify the omp version: $versionText" }
$ompVersion = [version]$match.Value
if ($ompVersion -lt [version]'18.15.0' -or $ompVersion -ge [version]'19.0.0') {
    throw "Requires OMP 18.15.0 through 18.x (tested: 18.15.0). Found: $ompVersion"
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'src\index.ts') -PathType Leaf)) {
    throw 'Extract or clone the complete package before installing.'
}

$installed = Invoke-OmpChecked @('plugin', 'list', '--json') | ConvertFrom-Json
Invoke-OmpChecked @('plugin', 'link', $PSScriptRoot)
foreach ($legacyName in @('omp-model-allowlist', 'omp-model-append-system')) {
    $legacy = @($installed.npm | Where-Object { $_.name -eq $legacyName -and $_.enabled })
    if ($legacy.Count -gt 0) { Invoke-OmpChecked @('plugin', 'disable', $legacyName) }
}
Invoke-OmpChecked @('plugin', 'enable', 'omp-model-toolkit')
Write-Output 'Done. Existing model choices and prompt bindings are preserved.'
Write-Output 'Keep this folder in place. Restart OMP, then use /allowed-models and /model-prompts.'
