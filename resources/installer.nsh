; Uninstall takes RedLog's shell enrolments back out before the files go.
;
; Install leaves lines in places the uninstaller does not own: the PowerShell
; profiles dot-source ~/.redlog\shell-hook.ps1, and a WSL distro's rc sources
; the hook inside this install directory. The uninstaller keeps ~/.redlog, so
; without this every new PowerShell window loaded a hook for an app that was
; gone, and every WSL shell tried to source a file that no longer existed.
;
; The removal is the app's own (hooks-manager / wsl-manager), run once with
; --remove-hooks. Skipped when the uninstall is part of an upgrade: the new
; version installs into the same place and the enrolments stay valid.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing RedLog shell hooks"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-hooks'
  ${endIf}
!macroend
