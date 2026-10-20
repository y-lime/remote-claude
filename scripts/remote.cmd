@echo off
rem Wrapper to run remote.ps1 regardless of the execution policy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote.ps1" %*
