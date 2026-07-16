@echo off
rem Launches Piece Defense on the Board (192.168.1.27) from this PC.
"%USERPROFILE%\.local\bin\board-connect.exe" launch aaeaf789-920d-46a5-a714-26f1043feb65
if errorlevel 1 (
  echo.
  echo Could not launch — is the Board on and connected to WiFi?
  pause
)
