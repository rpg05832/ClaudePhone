' Starts the ClaudePhone agent without a window. Arguments pass through: --open opens the dashboard, --no-open does not.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
sh.CurrentDirectory = base & "\agent"
sh.Run """" & base & "\runtime\node.exe"" --no-warnings --use-system-ca """ & base & "\agent\dist\agent.mjs""" & args, 0, False
