; Dark theme for the parts of the Modern UI that NSIS lets us colour:
; welcome page, finish page and the header strip of every page.
!define MUI_BGCOLOR "1B1D22"
!define MUI_TEXTCOLOR "FFFFFF"
!define MUI_INSTFILESPAGE_COLORS "E6E6E6 1B1D22"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

; Close a running copy before installing/uninstalling so files are not locked.
!macro customInit
  nsExec::Exec 'taskkill /IM "Astral Engine.exe"'
  Sleep 800
!macroend

; Full-height dark welcome page with the sidebar artwork.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Astral Engine"
  !define MUI_WELCOMEPAGE_TEXT "Live wallpapers for Windows: Steam Workshop scenes, videos, web wallpapers, desktop widgets and Rainmeter skins.$\r$\n$\r$\nYou can choose where to install it on the next pages.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ---------------------------------------------------------------------------------------------
; Finish page: white option text on the dark background, plus extra options (all ticked):
;   Launch Astral Engine, Create a desktop shortcut, Start with Windows.
; Windows 10/11 don't let installers pin apps to the taskbar or Start (Microsoft removed that
; ability on purpose), so the app shows how to pin it on first launch instead.
; Themed checkboxes ignore text colours, so drop the theme on each one and colour it ourselves.
!macro AstralDarkCheckbox HWND
  StrCpy $R9 ${HWND}
  System::Call 'uxtheme::SetWindowTheme(p $R9, w " ", w " ")'
  SetCtlColors ${HWND} "FFFFFF" "1B1D22"
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "Astral Engine is ready"
  !define MUI_FINISHPAGE_TEXT "Astral Engine has been installed on your computer.$\r$\n$\r$\nTip: to pin it, right-click its icon on the taskbar or in the Start menu and choose Pin."
  !define MUI_FINISHPAGE_TEXT_LARGE
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Astral Engine"
  !define MUI_FINISHPAGE_RUN_FUNCTION "AstralStartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW AstralFinishShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE AstralFinishLeave
  !insertmacro MUI_PAGE_FINISH

  ; Callbacks are defined after the page so the MUI variables they use are already declared.
  Var AstralDesk
  Var AstralBoot

  Function AstralStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function AstralFinishShow
    !insertmacro AstralDarkCheckbox $mui.FinishPage.Run
    ; Extra options under "Launch Astral Engine" (dialog units, same column as the MUI checkbox)
    ${NSD_CreateCheckbox} 120u 128u 195u 10u "Create a desktop shortcut"
    Pop $AstralDesk
    ${NSD_Check} $AstralDesk
    !insertmacro AstralDarkCheckbox $AstralDesk
    ${NSD_CreateCheckbox} 120u 146u 195u 10u "Start Astral Engine with Windows"
    Pop $AstralBoot
    ${NSD_Check} $AstralBoot
    !insertmacro AstralDarkCheckbox $AstralBoot
  FunctionEnd

  Function AstralFinishLeave
    ${NSD_GetState} $AstralDesk $0
    ${if} $0 != ${BST_CHECKED}
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${endif}
    ; The app reads this once on its next start and applies it to its own "Start with Windows" setting.
    ${NSD_GetState} $AstralBoot $0
    ${if} $0 == ${BST_CHECKED}
      WriteRegDWORD HKCU "Software\Astral Engine" "InstallStartWithWindows" 1
    ${else}
      WriteRegDWORD HKCU "Software\Astral Engine" "InstallStartWithWindows" 0
    ${endif}
  FunctionEnd

!macroend

!macro customUnInstall
  ; A Rainmeter that Astral installed (one-click install) lives outside the app folder so updates
  ; keep it; remove it only on a real uninstall.
  ${ifNot} ${isUpdated}
    IfFileExists "$LOCALAPPDATA\Astral Engine\Rainmeter\Rainmeter.exe" 0 astral_no_rm
      nsExec::Exec '"$LOCALAPPDATA\Astral Engine\Rainmeter\Rainmeter.exe" !Quit'
      Sleep 1500
      RMDir /r "$LOCALAPPDATA\Astral Engine\Rainmeter"
    astral_no_rm:
    RMDir "$LOCALAPPDATA\Astral Engine"
  ${endIf}
  DeleteRegValue HKCU "Software\Astral Engine" "InstallStartWithWindows"
  DeleteRegKey /ifempty HKCU "Software\Astral Engine"
!macroend
