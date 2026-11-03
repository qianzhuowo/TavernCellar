; Cellar Studio NSIS hooks (included by electron-builder, see electron-builder.yml).
;
; The default workspace lives in "$INSTDIR\workspace" (desktop/main.cjs). electron-builder's uninstaller removes the
; whole install folder, and an upgrade runs the old uninstaller first, so the user's workspace would be deleted.
; Remove only what the installer put there and keep "workspace" (and anything else the user stored here).
!macro customRemoveFiles
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  ; Removed only when nothing of the user's is left in it.
  RMDir "$INSTDIR"
!macroend
