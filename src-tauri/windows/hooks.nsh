; Registers Notepadly for text and Markdown files the way Windows expects, so it appears
; under "Open with" and in Settings > Apps > Default apps, without taking over any file
; type: whatever app the user already opens a type with stays the default.
;
;   .ext\OpenWithProgids       puts Notepadly in that type's "Open with" menu
;   Applications\notepadly.exe the app's name and the types it supports
;   Notepadly.File             the command that opens a file (with its icon)
;   RegisteredApplications     lists Notepadly in Default apps
;
; Per-user install, so SHCTX is HKEY_CURRENT_USER.

!define NP_PROGID "Notepadly.File"
!define NP_CAPS "Software\Notepadly\Capabilities"
!define NP_APPKEY "Software\Classes\Applications\${MAINBINARYNAME}.exe"

!macro NP_ADD_EXT EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${NP_PROGID}" ""
  WriteRegStr SHCTX "${NP_APPKEY}\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHCTX "${NP_CAPS}\FileAssociations" ".${EXT}" "${NP_PROGID}"
!macroend

!macro NP_REMOVE_EXT EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${NP_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}"
!macroend

; Every type is listed once here and used by both install and uninstall.
!macro NP_EACH_EXT MACRO
  !insertmacro ${MACRO} "txt"
  !insertmacro ${MACRO} "text"
  !insertmacro ${MACRO} "md"
  !insertmacro ${MACRO} "markdown"
  !insertmacro ${MACRO} "mdown"
  !insertmacro ${MACRO} "mkd"
  !insertmacro ${MACRO} "mdx"
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
  !insertmacro ${MACRO} "html"
  !insertmacro ${MACRO} "htm"
  !insertmacro ${MACRO} "css"
  !insertmacro ${MACRO} "js"
  !insertmacro ${MACRO} "ts"
  !insertmacro ${MACRO} "py"
  !insertmacro ${MACRO} "ps1"
  !insertmacro ${MACRO} "bat"
  !insertmacro ${MACRO} "cmd"
  !insertmacro ${MACRO} "sh"
  !insertmacro ${MACRO} "sql"
  !insertmacro ${MACRO} "srt"
  !insertmacro ${MACRO} "nfo"
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

  WriteRegStr SHCTX "Software\Classes\${NP_PROGID}" "" "Text Document"
  ; Files keep the standard Windows text-document icon, even when Notepadly opens them by default.
  WriteRegExpandStr SHCTX "Software\Classes\${NP_PROGID}\DefaultIcon" "" "%SystemRoot%\System32\imageres.dll,-102"
  WriteRegStr SHCTX "Software\Classes\${NP_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "${NP_APPKEY}" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegExpandStr SHCTX "${NP_APPKEY}\DefaultIcon" "" "%SystemRoot%\System32\imageres.dll,-102"
  WriteRegStr SHCTX "${NP_APPKEY}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "${NP_CAPS}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${NP_CAPS}" "ApplicationDescription" "Notepad with a live Markdown editor."
  WriteRegStr SHCTX "${NP_CAPS}" "ApplicationIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${NP_CAPS}"

  !insertmacro NP_EACH_EXT NP_ADD_EXT
  ; Tell Explorer the associations changed so "Open with" updates at once.
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An update reinstalls straight away, so keep everything in place.
  ${If} $UpdateMode <> 1
    !insertmacro NP_EACH_EXT NP_REMOVE_EXT
    DeleteRegKey SHCTX "Software\Classes\${NP_PROGID}"
    DeleteRegKey SHCTX "${NP_APPKEY}"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
    DeleteRegKey SHCTX "Software\Notepadly"
    System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
  ${EndIf}
!macroend
