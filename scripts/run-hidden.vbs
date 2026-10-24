' run-hidden.vbs - launch a command with no console window at all.
'
'   wscript.exe //nologo "D:\...\run-hidden.vbs" "C:\...\node.exe" "D:\...\revive.mjs"
'
' Why: when Task Scheduler starts a console program directly, the console window is
' created by the system before the program runs, so there is always a black box
' flash. WScript.Shell.Run with window style 0 never creates the window at all.
'
' Same file as memory-hub/scripts/run-hidden.vbs (kept local so this project does
' not depend on a sibling directory's layout).
'
' Keep this file ASCII-only: WSH reads .vbs as ANSI unless it has a BOM, and a
' mis-decoded non-ASCII byte can swallow the following quote.
Option Explicit

Dim shell, cmd, i, arg
If WScript.Arguments.Count = 0 Then WScript.Quit 2

Set shell = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If InStr(arg, " ") > 0 Then arg = """" & arg & """"
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & arg
Next

' 0 = hidden window, False = do not wait for the child to exit
shell.Run cmd, 0, False
