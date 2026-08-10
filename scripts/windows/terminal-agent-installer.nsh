!macro customInstall
  WriteRegStr HKCU "Software\Terminal-Agent" "InstallPath" "$INSTDIR"
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Terminal-Agent" "InstallPath"
  StrCmp $0 "$INSTDIR" 0 done
  DeleteRegValue HKCU "Software\Terminal-Agent" "InstallPath"
  DeleteRegKey /ifempty HKCU "Software\Terminal-Agent"
done:
!macroend
