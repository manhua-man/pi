# Fork learning wrapper: default -nc (no AGENTS.md / CLAUDE.md auto-load).
# Usage:
#   .\scripts\pi-learn.ps1 -- -p "question"     # print mode (note the --)
#   .\scripts\pi-learn.ps1 -- --print "question"
#   .\scripts\pi-learn.ps1 -WithContext -- -p "with AGENTS/CLAUDE"
param(
    [switch]$WithContext
)

$Root = Split-Path $PSScriptRoot -Parent
$tsx = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
$cli = Join-Path $Root "packages\coding-agent\src\cli.ts"
$tsconfig = Join-Path $Root "tsconfig.json"

$piArgs = @()
if ($args.Count -gt 0 -and $args[0] -eq '--') {
    if ($args.Count -gt 1) {
        $piArgs = $args[1..($args.Count - 1)]
    }
} else {
    $piArgs = @($args)
}

$invokeArgs = @()
if (-not $WithContext) {
    $invokeArgs += '-nc'
}
$invokeArgs += $piArgs

& node $tsx --tsconfig $tsconfig $cli @invokeArgs
exit $LASTEXITCODE