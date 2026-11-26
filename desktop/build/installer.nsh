; Kortes installer additions (electron-builder includes build/installer.nsh).
;
; The app is ~29 thousand files (most of them the bundled Python). The stock
; installer removes an older version file by file and copies the new one with a
; frozen progress bar, so an update looked stuck for minutes. Here:
;  - after the running app is closed, the old version's resources (the bulk of the
;    files) are renamed aside in one step and deleted in the background;
;  - uninstalling renames the whole folder aside the same way (from this version on);
;  - the page says what is happening and how long it takes.
; A rename that fails (a file still in use) changes nothing: the stock steps run.

; The stock check below needs these; the template loads them only when
; customCheckAppRunning is not defined.
!include "getProcessInfo.nsh"
Var pid

; Delete, in the background and hidden, every "<install dir>.antigo-*" folder left
; by this or an earlier run (a reboot mid-delete leaves one behind).
!macro kortesDeleteOldFolders
  ExecShell "" "$SYSDIR\cmd.exe" '/c for /d %d in ("$INSTDIR.antigo-*") do rd /s /q "%d"' SW_HIDE
!macroend

!macro kortesMoveOldResources
  Push $0
  Push $1
  ${If} ${FileExists} "$INSTDIR\resources\*.*"
    System::Call 'kernel32::GetTickCount()i.r0'
    StrCpy $1 "$INSTDIR.antigo-$0"
    ClearErrors
    Rename "$INSTDIR\resources" "$1"
  ${EndIf}
  !insertmacro kortesDeleteOldFolders
  Pop $1
  Pop $0
!macroend

; Runs where the stock "is the app running?" check runs: before the old version is
; removed. It keeps that check and then clears the way.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ; An update is started by the app, whose working folder is the install folder
    ; (the shortcut's "Start in"), and this installer inherits it. A process sitting
    ; in $INSTDIR keeps the old version's uninstaller from renaming it (1.0.6 on:
    ; customRemoveFiles), which then fails forever with "can't close the app". Leave it
    ; before anything else; the old uninstaller and the background deletes inherit it.
    SetOutPath $TEMP
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${Silent}
      !insertmacro MUI_HEADER_TEXT "Instalando o Kortes" "Leva de 1 a 3 minutos. Pode deixar esta janela aberta."
      SetDetailsPrint textonly
      DetailPrint "Preparando a instalação..."
    ${EndIf}
    !insertmacro kortesMoveOldResources
    ${IfNot} ${Silent}
      DetailPrint "Copiando os arquivos do Kortes (são muitos, pode parecer parado por um tempo)..."
      ; The status line keeps this text while the files are copied.
      SetDetailsPrint none
    ${EndIf}
  !endif
!macroend

; Uninstall (and the old-version step of a future update): one rename instead of
; deleting the files one by one.
!macro customRemoveFiles
  SetOutPath $TEMP
  Push $0
  Push $1
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $1 "$INSTDIR.antigo-$0"
  ClearErrors
  Rename "$INSTDIR" "$1"
  ${If} ${Errors}
    ${If} ${isUpdated}
      ; Same as the stock step: a file in use stops the update, nothing removed.
      Abort `Can't rename "$INSTDIR" to "$1".`
    ${EndIf}
    RMDir /r $INSTDIR
  ${Else}
    ExecShell "" "$SYSDIR\cmd.exe" '/c rd /s /q "$1"' SW_HIDE
  ${EndIf}
  Pop $1
  Pop $0
!macroend
