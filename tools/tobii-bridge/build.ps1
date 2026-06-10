param(
  [string]$SdkDir = $env:TOBII_TGI_SDK_DIR,
  [string]$OutDir = "$PSScriptRoot\bin"
)

$ErrorActionPreference = "Stop"

if (-not $SdkDir) {
  throw "Set TOBII_TGI_SDK_DIR to the Tobii Game Integration API SDK folder."
}

$SdkDir = (Resolve-Path -LiteralPath $SdkDir).Path
$Header = Get-ChildItem -LiteralPath $SdkDir -Recurse -Filter "tobii_gameintegration.h" | Select-Object -First 1
if (-not $Header) {
  throw "Could not find tobii_gameintegration.h under $SdkDir"
}

$Lib = Get-ChildItem -LiteralPath $SdkDir -Recurse -Filter "*.lib" |
  Where-Object { $_.Name -match "tobii.*game.*integration|gameintegration" -and $_.FullName -match "x64|64" } |
  Select-Object -First 1
if (-not $Lib) {
  $Lib = Get-ChildItem -LiteralPath $SdkDir -Recurse -Filter "*.lib" |
    Where-Object { $_.Name -match "tobii.*game.*integration|gameintegration" } |
    Select-Object -First 1
}
if (-not $Lib) {
  throw "Could not find Tobii Game Integration .lib under $SdkDir"
}

$Dlls = Get-ChildItem -LiteralPath $SdkDir -Recurse -Filter "*.dll" |
  Where-Object { $_.Name -match "tobii.*game.*integration|gameintegration" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$Source = "$PSScriptRoot\tobii-bridge.cpp"
$Exe = "$OutDir\tobii-bridge.exe"
$IncludeDir = $Header.DirectoryName
$LibDir = $Lib.DirectoryName

$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$Cl = (Get-Command cl.exe -ErrorAction SilentlyContinue)

if ($Cl) {
  & cl.exe /nologo /EHsc /std:c++17 /I"$IncludeDir" "$Source" /link /LIBPATH:"$LibDir" "$($Lib.Name)" /OUT:"$Exe"
} elseif (Test-Path -LiteralPath $VsWhere) {
  $VsInstall = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $VsInstall) {
    throw "Visual Studio C++ Build Tools were not found. Install Desktop development with C++."
  }
  $VsDevCmd = Join-Path $VsInstall "Common7\Tools\VsDevCmd.bat"
  $Command = "`"$VsDevCmd`" -arch=x64 && cl.exe /nologo /EHsc /std:c++17 /I`"$IncludeDir`" `"$Source`" /link /LIBPATH:`"$LibDir`" `"$($Lib.Name)`" /OUT:`"$Exe`""
  & cmd.exe /c $Command
} else {
  throw "cl.exe was not found. Install Visual Studio Build Tools with Desktop development with C++."
}

foreach ($Dll in $Dlls) {
  Copy-Item -LiteralPath $Dll.FullName -Destination $OutDir -Force
}

Write-Host "Built $Exe"
