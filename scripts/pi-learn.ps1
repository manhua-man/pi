# Fork learning wrapper: default -nc (no AGENTS.md / CLAUDE.md auto-load).
# Opt in: .\scripts\pi-learn.ps1 -WithContext -p "question"
param(
    [switch]$WithContext,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Remaining
)

$Root = Split-Path $PSScriptRoot -Parent
$tsx = Join-Path $Root "node_modules\.bin\tsx.cmd"
$cli = Join-Path $Root "packages\coding-agent\src\cli.ts"
$tsconfig = Join-Path $Root "tsconfig.json"

$args = @()
if (-not $WithContext) {
    $args += "-nc"
}
if ($Remaining) {
    $args += $Remaining
}

& $tsx --tsconfig $tsconfig $cli @args
exit $LASTEXITCODE