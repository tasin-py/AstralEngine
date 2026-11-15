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

; ---------------------------------------------------------------------------------------------
; Uninstaller: "Also uninstall Rainmeter" on the first page (unticked by default). Finds the Rainmeter
; that Astral installed (one-click install), a normal Rainmeter installation, or a portable Rainmeter
; kept inside the Astral folder (that one goes with the folder, so the box is ticked and locked).
!ifdef BUILD_UNINSTALLER
  Var AstralRmKind
  Var AstralRmPath
  Var AstralRmBox
  Var AstralRmChoice
!endif

!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.AstralUnWelcomeShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.AstralUnWelcomeLeave
  !insertmacro MUI_UNPAGE_WELCOME

  Function un.AstralFindRainmeter
    StrCpy $AstralRmKind ""
    StrCpy $AstralRmPath ""
    IfFileExists "$LOCALAPPDATA\Astral Engine\Rainmeter\Rainmeter.exe" 0 astral_try_reg
      StrCpy $AstralRmKind "managed"
      StrCpy $AstralRmPath "$LOCALAPPDATA\Astral Engine\Rainmeter"
      Return
    astral_try_reg:
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rainmeter" "UninstallString"
    StrCmp $0 "" 0 +2
      ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rainmeter" "UninstallString"
    StrCmp $0 "" astral_try_inapp
    ; "C:\...\uninst.exe" -> C:\...\uninst.exe
    StrCpy $1 $0 1
    StrCmp $1 '"' 0 astral_unquoted
      StrCpy $0 $0 "" 1
      StrCpy $2 0
      astral_q_loop:
        StrCpy $3 $0 1 $2
        StrCmp $3 "" astral_q_done
        StrCmp $3 '"' astral_q_done
        IntOp $2 $2 + 1
        Goto astral_q_loop
      astral_q_done:
      StrCpy $0 $0 $2
    astral_unquoted:
    IfFileExists "$0" 0 astral_try_inapp
      StrCpy $AstralRmKind "installed"
      StrCpy $AstralRmPath "$0"
      Return
    astral_try_inapp:
    IfFileExists "$INSTDIR\Rainmeter.exe" 0 +2
      StrCpy $AstralRmKind "inapp"
  FunctionEnd

  Function un.AstralUnWelcomeShow
    StrCpy $AstralRmChoice 0
    Call un.AstralFindRainmeter
    StrCmp $AstralRmKind "" astral_show_done
    ${NSD_CreateCheckbox} 120u 150u 195u 12u "Also uninstall Rainmeter"
    Pop $AstralRmBox
    !insertmacro AstralDarkCheckbox $AstralRmBox
    StrCmp $AstralRmKind "inapp" 0 astral_show_note
      ${NSD_Check} $AstralRmBox
      EnableWindow $AstralRmBox 0
      ${NSD_CreateLabel} 132u 164u 183u 20u "Rainmeter is inside the Astral Engine folder, so it is removed with it."
      Goto astral_show_label
    astral_show_note:
      ${NSD_CreateLabel} 132u 164u 183u 20u "Your skins in Documents\Rainmeter are kept."
    astral_show_label:
    Pop $0
    SetCtlColors $0 "BBBBBB" "1B1D22"
    astral_show_done:
  FunctionEnd

  Function un.AstralUnWelcomeLeave
    StrCmp $AstralRmKind "" 0 +3
      StrCpy $AstralRmChoice 0
      Return
    ${NSD_GetState} $AstralRmBox $AstralRmChoice
  FunctionEnd
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} $AstralRmChoice == ${BST_CHECKED}
    ${andIf} $AstralRmKind != "inapp"
      ; Close Rainmeter first so its files aren't in use.
      nsExec::Exec 'taskkill /IM Rainmeter.exe'
      Sleep 1500
      nsExec::Exec 'taskkill /F /IM Rainmeter.exe'
      ${if} $AstralRmKind == "managed"
        RMDir /r "$AstralRmPath"
      ${elseIf} $AstralRmKind == "installed"
        ; Run Rainmeter's own uninstaller silently and wait for it (_?= keeps it from detaching).
        ; It may ask for administrator permission.
        StrCpy $1 "$AstralRmPath"
        StrLen $2 $1
        astral_parent_loop:
          IntOp $2 $2 - 1
          IntCmp $2 0 astral_parent_done astral_parent_done
          StrCpy $3 $1 1 $2
          StrCmp $3 "\" 0 astral_parent_loop
        astral_parent_done:
        StrCpy $1 $1 $2
        ${StdUtils.ExecShellWaitEx} $2 $3 "$AstralRmPath" "open" "/S _?=$1"
        StrCmp $2 "ok" 0 +2
          ${StdUtils.WaitForProcEx} $4 $3
        Delete "$AstralRmPath"
        RMDir "$1"
      ${endIf}
    ${endIf}
    RMDir "$LOCALAPPDATA\Astral Engine"
  ${endIf}
  DeleteRegValue HKCU "Software\Astral Engine" "InstallStartWithWindows"
  DeleteRegKey /ifempty HKCU "Software\Astral Engine"
!macroend
