# Start Microsoft Edge with the local DevTools endpoint used by the DSH
# `lab_browser` tool.
#
# Edge 136+ refuses --remote-debugging-port on the default profile, so this uses
# a dedicated automation profile that keeps its own WebVPN/CAS login. Log in once
# in the window that opens; later runs reuse the cookies.
param(
  [int]$Port = 9222,
  [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA "dsh-plugin-ibwedu-lab\edge-profile")
)

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { throw "Microsoft Edge not found at $edge" }

# A leftover background Edge from the same profile would swallow the launch.
Get-Process msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $edge } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Start-Process -FilePath $edge -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--no-first-run",
  "--no-default-browser-check",
  "https://vpn.usts.edu.cn/"
)

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3
    "Edge debugging endpoint is up on port $Port ($($pages.Count) target(s))"
    exit 0
  } catch { }
}
"Edge started with profile $ProfileDir, but the debugging endpoint is not answering on port $Port."
exit 2
