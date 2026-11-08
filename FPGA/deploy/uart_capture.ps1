# Capture the board UART (115200 8N1) to deploy\uart.log. Usage: powershell -File uart_capture.ps1 [seconds]
param([int]$Seconds = 75)
$log = Join-Path $PSScriptRoot "uart.log"
$dev = Get-CimInstance Win32_PnPEntity -Filter "Name LIKE 'USB Serial Port%'" | Select-Object -First 1
"device: $($dev.Name)" | Out-File $log -Encoding ascii
if ($dev.Name -match '\((COM\d+)\)') { $port = $Matches[1] } else { "no USB Serial Port found; ports: $([System.IO.Ports.SerialPort]::GetPortNames())" | Out-File $log -Append -Encoding ascii; exit 1 }
"using $port" | Out-File $log -Append -Encoding ascii
$sp = New-Object System.IO.Ports.SerialPort $port, 115200, 'None', 8, 'One'
$sp.ReadTimeout = 200
$sp.Open()
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
    $s = $sp.ReadExisting()
    if ($s) { $s | Out-File $log -Append -Encoding ascii -NoNewline }
    Start-Sleep -Milliseconds 100
}
$sp.Close()
"`nUART_DONE" | Out-File $log -Append -Encoding ascii
