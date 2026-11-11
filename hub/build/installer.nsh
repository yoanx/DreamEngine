!macro customInstall
  CreateDirectory "$DOCUMENTS\DreamEngine"
  FileOpen $0 "$DOCUMENTS\DreamEngine\hub-path.txt" w
  FileWrite $0 "$INSTDIR\DreamEngine Hub.exe"
  FileClose $0

  DetailPrint "Installing DreamEngine CEP panel..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\install_dreamengine.ps1" -Source "$INSTDIR\resources\panel" -UpdateL1 -Quiet'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "DreamEngine Hub was installed, but the After Effects panel setup failed. Open Hub settings and rerun the installer."
  ${EndIf}
!macroend

!macro customUnInstall
  # electron-builder 在升级时也会执行卸载器。只有真正卸载才清理用户数据。
  ${ifNot} ${isUpdated}
    DetailPrint "Removing DreamEngine panel and user data..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\uninstall_dreamengine.ps1" -Quiet'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "DreamEngine was uninstalled, but some panel or user-data files could not be removed. Close After Effects and DreamEngine Hub, then remove them manually."
    ${EndIf}
  ${endIf}
!macroend
