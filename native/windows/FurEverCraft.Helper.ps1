param([switch]$DryRun)
# FurEverCraft Windows helper bootstrap.
#
# The helper body lives in FurEverCraft.Helper.Core.cs and is loaded in-process through
# Add-Type. This file intentionally contains no input logic: keep it small, LF-only and
# byte-hashable. Windows PowerShell 5.1 / .NET Framework 4.8 is the fixed runtime.
$ErrorActionPreference = 'Stop'
$corePath = Join-Path $PSScriptRoot 'FurEverCraft.Helper.Core.cs'
if (-not (Test-Path -LiteralPath $corePath -PathType Leaf)) {
  [Console]::Error.WriteLine('helper-core-missing')
  exit 2
}
try {
  Add-Type -AssemblyName System.Web.Extensions
  Add-Type -AssemblyName System.Drawing
  $references = @(
    [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
    [System.Drawing.Bitmap].Assembly.Location
    'System.dll'
    'System.Core.dll'
  )
  Add-Type -Path $corePath -ReferencedAssemblies $references
} catch {
  [Console]::Error.WriteLine('helper-core-load-failed')
  exit 3
}
$exitCode = [FurEverCraft.Helper.Core]::Run([bool]$DryRun)
exit $exitCode
