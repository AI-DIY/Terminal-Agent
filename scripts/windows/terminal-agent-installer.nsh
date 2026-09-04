!macro customInstall
  ReadEnvStr $0 "USERPROFILE"
  StrCmp $0 "" done_config
  StrCpy $1 "$0\.ta"
  CreateDirectory "$1"
  IfFileExists "$1\user-config" done_config
  FileOpen $2 "$1\user-config" w
  IfErrors done_config
  FileWrite $2 '{"version":1,"sso":{"enabled":true,"loginPageUrl":"","platformUrlMatcher":{"mode":"exact","value":""},"userInfoUrlMatcher":{"mode":"exact","value":""},"employeeIdField":"","nameField":""}}'
  FileClose $2
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
