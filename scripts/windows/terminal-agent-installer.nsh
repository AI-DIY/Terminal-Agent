!macro customInstall
  ReadEnvStr $0 "USERPROFILE"
  StrCmp $0 "" done_config
  StrCpy $1 "$0\.terminal-agent"
  StrCpy $4 "$0\.terminal-agent\user-config"
  StrCpy $5 "$0\.ta\user-config"
  IfFileExists "$1\user-config.yml" done_config
  ; Leave either JSON migration source in place so the app can move it into
  ; the canonical YAML location on first launch. Creating a fresh file here
  ; would otherwise hide the user's existing configuration.
  IfFileExists "$4" done_config
  IfFileExists "$5" done_config
  CreateDirectory "$1"
  GetTempFileName $2 "$1"
  FileOpen $3 "$2" w
  IfErrors cleanup_temp
  ClearErrors
  FileWrite $3 '# Terminal-Agent 用户配置文件。请按需修改各字段的值。$\r$\n'
  FileWrite $3 '# 用户配置文件格式版本，请勿手动修改。$\r$\n'
  FileWrite $3 'version: 1$\r$\n'
  FileWrite $3 '# 单点登录配置。$\r$\n'
  FileWrite $3 'sso:$\r$\n'
  FileWrite $3 '  # 是否启用单点登录。$\r$\n'
  FileWrite $3 '  enabled: true$\r$\n'
  FileWrite $3 '  # 单点登录页面地址。$\r$\n'
  FileWrite $3 '  loginPageUrl: ""$\r$\n'
  FileWrite $3 '  # 平台请求地址匹配规则。$\r$\n'
  FileWrite $3 '  platformUrlMatcher:$\r$\n'
  FileWrite $3 '    # 平台地址匹配方式：exact、prefix 或 regex。$\r$\n'
  FileWrite $3 '    mode: exact$\r$\n'
  FileWrite $3 '    # 平台地址匹配内容。$\r$\n'
  FileWrite $3 '    value: ""$\r$\n'
  FileWrite $3 '  # 用户信息请求地址匹配规则。$\r$\n'
  FileWrite $3 '  userInfoUrlMatcher:$\r$\n'
  FileWrite $3 '    # 用户信息地址匹配方式：exact、prefix 或 regex。$\r$\n'
  FileWrite $3 '    mode: exact$\r$\n'
  FileWrite $3 '    # 用户信息地址匹配内容。$\r$\n'
  FileWrite $3 '    value: ""$\r$\n'
  FileWrite $3 '  # 用户信息响应中员工编号的字段路径。$\r$\n'
  FileWrite $3 '  employeeIdField: ""$\r$\n'
  FileWrite $3 '  # 用户信息响应中姓名的字段路径。$\r$\n'
  FileWrite $3 '  nameField: ""$\r$\n'
  IfErrors close_temp
  FileClose $3
  System::Call 'kernel32::MoveFileEx(t r2, t "$1\user-config.yml", i 0) i.r4'
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
