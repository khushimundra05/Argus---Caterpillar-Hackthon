# Launches the CV/ML service and the web app in two new PowerShell windows.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\cv-service'; .\.venv\Scripts\python -m uvicorn main:app --port 8001"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\web'; npm run dev"
Start-Sleep -Seconds 8
Start-Process "http://localhost:3000"
