@echo off
rem The `cockpit` command: Cockpit puts this folder on the PATH of its window's terminals.
node "%~dp0..\dist\cockpit.js" %*
