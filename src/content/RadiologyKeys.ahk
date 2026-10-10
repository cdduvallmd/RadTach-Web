#Requires AutoHotkey v2.0
#SingleInstance Force

; Key map from "AHK Key List 10-10-2026". Each key brings its target app to the
; front (if it isn't already), then sends the output. If the app isn't running,
; the key does nothing.

PS := "ahk_exe Nuance.PowerScribe.360.exe"
VS := "ahk_exe vsclient.exe"

; Brings win to the front. Returns false if it isn't running or didn't activate.
Activate(win) {
    if !WinExist(win)
        return false
    if WinActive(win)
        return true
    WinActivate win
    return WinWaitActive(win, , 1) != 0
}

SendTo(win, keys) {
    if !Activate(win)
        return false
    Send keys
    return true
}

; One pass of PowerScribe's Find/Replace dialog (Ctrl+H).
FindReplace(find, replace, escapes := 3) {
    Send "^h"
    Sleep 100
    Send "{Text}" find
    Send "{Tab}"
    Send "{Text}" replace
    Send "{Tab 3}{Enter}{Escape " escapes "}"
}

; ---------- PowerScribe ----------
F13::SendTo(PS, "{Space}")         ; Spacebar
F14::SendTo(PS, "{Backspace}")     ; Backspace
F15::SendTo(PS, "!u")              ; Uppercase selected
F16:: {                            ; Number selected (Alt+M, then N)
    if SendTo(PS, "!m") {
        Sleep 100
        Send "n"
    }
}
F17::SendTo(PS, "{Enter}")         ; Enter
F18::SendTo(PS, "^z")              ; Undo
F19::SendTo(PS, "^y")              ; Redo
F20::SendTo(PS, "{Tab}")           ; Next line
F21::SendTo(PS, "+{Tab}")          ; Previous line
F22::SendTo(PS, "{F4}")            ; Toggle microphone
F23::SendTo(PS, "{F12}")           ; Sign exam
F24::SendTo(PS, "!{End}")          ; Go to end of document
+F13::SendTo(PS, ".")              ; Period
+F14::SendTo(PS, ",")              ; Comma
+F15::SendTo(PS, "{F9}")           ; Draft exam (remote)
+F16::SendTo(PS, "!l")             ; Lowercase selected text

; ---------- Visage ----------
+F17::SendTo(VS, ".")              ; Next marked image (remote)
+F18::SendTo(VS, ",")              ; Prior marked image (remote)
+F19::SendTo(VS, "d")              ; Measure tool
+F20::SendTo(VS, "j")              ; ROI tool (remote)
+F21::SendTo(VS, "w")              ; Ratio tool (remote)
+F22::SendTo(VS, "g")              ; Circle marker (remote)
+F23::SendTo(VS, "c")              ; Arrow marker (remote)
+F24::SendTo(VS, "a")              ; Sync all same study (remote)
!F13::SendTo(VS, "z")              ; Sync with different study (remote)
!F14::SendTo(VS, "s")              ; Stack mode (remote)
!F15::SendTo(VS, "q")              ; Find point in all planes (remote)
!F16::SendTo(VS, "f")              ; Reset image to 100% (remote)
!F17::SendTo(VS, "{F9}")           ; Reset slice orientation MPR (remote)
!F18::SendTo(VS, "0")              ; Reset to original W/L
!F19::SendTo(VS, "1")              ; CT bone window
!F20::SendTo(VS, "2")              ; CT liver window
!F21::SendTo(VS, "3")              ; CT lung window
!F22::SendTo(VS, "4")              ; CT brain window
!F23::SendTo(VS, "5")              ; CT angio window
!F24::SendTo(VS, "6")              ; CT soft tissue neck
^F13::SendTo(VS, "7")              ; CT body window
^F14::SendTo(VS, "8")              ; CTA PE window
^F15::SendTo(VS, "9")              ; CT dental

; Ctrl+F17 through Ctrl+F24: unassigned.

; ---------- PowerScribe cleanup (Ctrl+F16) ----------
^F16:: {
    if !Activate(PS)
        return
    FindReplace("..", ".")
    FindReplace("  ", " ", 2)
    FindReplace("  ", " ", 2)      ; second pass catches runs of 3-4 spaces
    FindReplace(" .", ".")
}
