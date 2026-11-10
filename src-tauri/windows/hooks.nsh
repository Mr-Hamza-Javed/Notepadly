; Registers Notepadly with Windows without changing how any file opens.
;
; Text and Markdown files (.txt, .md ...):
;   .ext\OpenWithProgids        Notepadly is offered right in their "Open with" menu
; Other plain-text data files (.log, .json, .ini, .csv ...):
;   listed only as types Notepadly *can* open, so it shows under
;   "Open with > Choose another app" and in Settings > Default apps, where the user
;   may make it the default if they want to.
;
; Never anything that runs (.bat, .cmd, .ps1, .js, .py ...): when a type has no app the
; user picked, Windows opens it with its built-in handler (for .bat, it runs it), and
; adding an OpenWithProgids entry makes Windows ask "How do you want to open this
; file?" instead. Version 0.1.2 did that; the clean-up below removes it.
;
;   Applications\notepadly.exe the app's name and the types it supports
;   Notepadly.File             the command that opens a file, and its icon
;   RegisteredApplications     lists Notepadly in Default apps
;
; Per-user install, so SHCTX is HKEY_CURRENT_USER.

!define NP_PROGID "Notepadly.File"
!define NP_CAPS "Software\Notepadly\Capabilities"
!define NP_APPKEY "Software\Classes\Applications\${MAINBINARYNAME}.exe"

; Can open it, and the user may choose Notepadly for it (no prompt, nothing changes).
!macro NP_ADD_SUPPORTED EXT
  WriteRegStr SHCTX "${NP_APPKEY}\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHCTX "${NP_CAPS}\FileAssociations" ".${EXT}" "${NP_PROGID}"
!macroend

; Text and Markdown: also offered straight in the "Open with" menu.
!macro NP_ADD_MAIN EXT
  !insertmacro NP_ADD_SUPPORTED "${EXT}"
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${NP_PROGID}" ""
!macroend

; Takes Notepadly out of a type's "Open with" menu, leaving other apps' entries alone.
!macro NP_REMOVE_OPENWITH EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${NP_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}"
!macroend

!macro NP_MAIN_TYPES MACRO
  !insertmacro ${MACRO} "txt"
  !insertmacro ${MACRO} "md"
  !insertmacro ${MACRO} "markdown"
  !insertmacro ${MACRO} "mdown"
  !insertmacro ${MACRO} "mkd"
  !insertmacro ${MACRO} "mdx"
!macroend

!macro NP_OTHER_TYPES MACRO
  !insertmacro ${MACRO} "text"
  !insertmacro ${MACRO} "log"
  !insertmacro ${MACRO} "ini"
  !insertmacro ${MACRO} "cfg"
  !insertmacro ${MACRO} "conf"
  !insertmacro ${MACRO} "json"
  !insertmacro ${MACRO} "jsonc"
  !insertmacro ${MACRO} "xml"
  !insertmacro ${MACRO} "csv"
  !insertmacro ${MACRO} "tsv"
  !insertmacro ${MACRO} "yml"
  !insertmacro ${MACRO} "yaml"
  !insertmacro ${MACRO} "toml"
  !insertmacro ${MACRO} "css"
  !insertmacro ${MACRO} "sql"
  !insertmacro ${MACRO} "srt"
  !insertmacro ${MACRO} "nfo"
!macroend

; Types 0.1.2 registered that must never carry Notepadly: they run or have their own app.
!macro NP_RUNNABLE_TYPES MACRO
  !insertmacro ${MACRO} "bat"
  !insertmacro ${MACRO} "cmd"
  !insertmacro ${MACRO} "ps1"
  !insertmacro ${MACRO} "js"
  !insertmacro ${MACRO} "ts"
  !insertmacro ${MACRO} "py"
  !insertmacro ${MACRO} "sh"
  !insertmacro ${MACRO} "html"
  !insertmacro ${MACRO} "htm"
!macroend

!macro NP_FORGET_TYPE EXT
  !insertmacro NP_REMOVE_OPENWITH "${EXT}"
  DeleteRegValue SHCTX "${NP_APPKEY}\SupportedTypes" ".${EXT}"
  DeleteRegValue SHCTX "${NP_CAPS}\FileAssociations" ".${EXT}"
!macroend

; Version 0.1.1 used Tauri's built-in association, which pointed .txt and the Markdown
; types at its own "Text document" / "Markdown document" classes. Undo that so Windows'
; normal handling of those types comes back.
!macro NP_CLEAN_OLD EXT CLASS
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $R0 == "${CLASS}"
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${CLASS}_backup"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro NP_CLEAN_OLD "txt" "Text document"
  !insertmacro NP_CLEAN_OLD "md" "Markdown document"
  !insertmacro NP_CLEAN_OLD "markdown" "Markdown document"
  !insertmacro NP_CLEAN_OLD "mdown" "Markdown document"
  !insertmacro NP_CLEAN_OLD "mkd" "Markdown document"
  DeleteRegKey SHCTX "Software\Classes\Text document"
  DeleteRegKey SHCTX "Software\Classes\Markdown document"
  ; 0.1.2 put Notepadly in the "Open with" menu of every type, which made Windows ask
  ; how to open .bat, .cmd and others instead of running them.
  !insertmacro NP_RUNNABLE_TYPES NP_FORGET_TYPE
  !insertmacro NP_OTHER_TYPES NP_REMOVE_OPENWITH

  WriteRegStr SHCTX "Software\Classes\${NP_PROGID}" "" "Text Document"
  ; Fallback icon; on start the app switches it to the icon Notepad uses on this PC.
  WriteRegExpandStr SHCTX "Software\Classes\${NP_PROGID}\DefaultIcon" "" "%SystemRoot%\System32\imageres.dll,-102"
  WriteRegStr SHCTX "Software\Classes\${NP_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "${NP_APPKEY}" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegExpandStr SHCTX "${NP_APPKEY}\DefaultIcon" "" "%SystemRoot%\System32\imageres.dll,-102"
  WriteRegStr SHCTX "${NP_APPKEY}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "${NP_CAPS}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${NP_CAPS}" "ApplicationDescription" "Notepad with a live Markdown editor."
  WriteRegStr SHCTX "${NP_CAPS}" "ApplicationIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${NP_CAPS}"

  !insertmacro NP_MAIN_TYPES NP_ADD_MAIN
  !insertmacro NP_OTHER_TYPES NP_ADD_SUPPORTED
  ; Tell Explorer the associations changed so "Open with" updates at once.
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An update reinstalls straight away, so keep everything in place.
  ${If} $UpdateMode <> 1
    !insertmacro NP_MAIN_TYPES NP_REMOVE_OPENWITH
    !insertmacro NP_OTHER_TYPES NP_REMOVE_OPENWITH
    !insertmacro NP_RUNNABLE_TYPES NP_REMOVE_OPENWITH
    DeleteRegKey SHCTX "Software\Classes\${NP_PROGID}"
    DeleteRegKey SHCTX "${NP_APPKEY}"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
    DeleteRegKey SHCTX "Software\Notepadly"
    System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
  ${EndIf}
!macroend
