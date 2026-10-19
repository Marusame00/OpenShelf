@echo off
setlocal
cd /d "%~dp0"
title OpenShelf - Stop

echo Finding OpenShelf on its port (force close ^+ free the memory it used)...
echo.

powershell -NoProfile -Command "$port = 8090; if (Test-Path 'openshelf.config.json') { try { $c = Get-Content 'openshelf.config.json' -Raw | ConvertFrom-Json; if ($c.port) { $port = [int]$c.port } } catch {} }; $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne $PID } | Select-Object -First 1; if ($conn) { $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.Name -like 'node*') { Stop-Process -Id $p.Id -Force; Write-Host ('Force-closed node (PID ' + $p.Id + ') - its memory has been released.') } else { Write-Host ('Port ' + $port + ' is held by ' + $p.Name + ' (PID ' + $p.Id + ') - not touched.') } } else { Write-Host 'Nothing is listening on the OpenShelf port - server is not running.' }"

echo.
echo Done.
endlocal
