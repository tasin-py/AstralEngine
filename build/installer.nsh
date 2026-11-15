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
