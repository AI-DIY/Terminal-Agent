!macro customInstall
  WriteRegStr HKCU "Software\Terminal-Agent" "InstallPath" "$INSTDIR"
!macroend
