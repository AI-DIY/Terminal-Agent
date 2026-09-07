!macro customInstall
  ReadEnvStr $0 "USERPROFILE"
  StrCmp $0 "" done_config
  StrCpy $1 "$0\.terminal-agent"
  StrCpy $4 "$0\.ta\user-config"
  IfFileExists "$1\user-config" done_config
  ; Leave the legacy file in place so the app can migrate it into the
  ; canonical location on first launch.  Creating a fresh canonical file here
  ; would otherwise hide the user's existing configuration.
  IfFileExists "$4" done_config
  CreateDirectory "$1"
  GetTempFileName $2 "$1"
  FileOpen $3 "$2" w
  IfErrors cleanup_temp
  ClearErrors
  FileWrite $3 '{"version":1,"sso":{"enabled":true,"loginPageUrl":"","platformUrlMatcher":{"mode":"exact","value":""},"userInfoUrlMatcher":{"mode":"exact","value":""},"employeeIdField":"","nameField":""}}'
  IfErrors close_temp
  FileClose $3
  System::Call 'kernel32::MoveFileEx(t r2, t "$1\user-config", i 0) i.r4'
  StrCmp $4 0 cleanup_temp
  Goto done_config
close_temp:
  FileClose $3
cleanup_temp:
  Delete "$2"
done_config:
  WriteRegStr HKCU "Software\Terminal-Agent" "InstallPath" "$INSTDIR"
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Terminal-Agent" "InstallPath"
  StrCmp $0 "$INSTDIR" 0 done
  DeleteRegValue HKCU "Software\Terminal-Agent" "InstallPath"
  DeleteRegKey /ifempty HKCU "Software\Terminal-Agent"
done:
!macroend
