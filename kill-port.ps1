$conns = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  $conns | Select-Object -Unique OwningProcess | ForEach-Object {
    Write-Output ("Killing PID " + $_.OwningProcess)
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Output 'Port 5173 already free'
}
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Output 'Electron processes cleaned'
