# Notepadly: mukammal bug aur edge-case report

**Tareekh:** 10 November 2026 · **Code:** `main` ka commit `c578712` · **Kul masail:** 70 (8 critical, 16 high, 22 medium, 16 low, 8 Windows par check karne wale)

## Yeh analysis kaise hua

- Poora code padha gaya: Rust backend (`src-tauri/src`), state/loader (`src/state`, `src/lib`), editor engine (`src/editor`), aur tamam UI components.
- `npm run typecheck` aur `npm test` chalaye: dono pass (30 tests).
- Asli frontend ko Chromium mein ek nakli (fake) Tauri backend ke saath chalaya gaya aur har shak wale bug ko keyboard/mouse se repro kiya gaya.
- 900 random keystrokes/format commands ka "monkey test" `sample.md` par chalaya: koi exception ya crash nahi aaya.

**Had (limit):** yeh container Linux hai. Rust code sirf Windows par compile hota hai, is liye Rust wale bugs code padh kar nikale gaye hain, chala kar nahi. WebView2 ke khaas behaviour (clipboard, drag-drop, context menu) bhi yahan check nahi ho sakte; woh alag section mein hain.

Har bug ke saath status likha hai:

| Nishaan | Matlab |
| --- | --- |
| ✅ | Browser mein chala kar confirm hua |
| 📖 | Code padh kar mila (logic saaf hai, lekin chala kar nahi dekha) |
| ⚠️ | Windows par asli app mein verify karna zaroori hai |

---

## Sab se pehle yeh 10 theek karein

| # | Bug | Kyun pehle |
| --- | --- | --- |
| C1 | Save As bina extension ke doosri file chupke se overwrite karta hai | Data loss |
| C2 | Replace all loading ke dauran sirf aadhi file badalta hai | Chupke se ghalat natija |
| C3 | Bari file disk par badal jaye to edits kahin save nahi hote | Kaam phans jata hai |
| C4 | Message dialog ke baad tab/window kabhi band nahi hoti | App atak jati hai |
| C5 | Main window pehle band ho to session wapas nahi aata | Unsaved notes "ghayab" |
| C6 | ANSI file mein Urdu/Unicode save par `?` ban jata hai | Data loss |
| C8 | Tab badalte waqt typing pichhli tab mein chali jati hai | Ghalat file badalti hai |
| H1 | Table cell mein Ctrl+B `****text` bana deta hai | Roz ka feature toota hai |
| H2 | Left/Right arrow table, maths, diagram par atak jata hai | Keyboard navigation tooti hai |
| H9 | Print screen jaisa nahi hota, comments bhi chhap jate hain | README ke khilaf |

---

## CRITICAL: data loss ya app ka atak jana

### C1. Save As bina extension wali file ka naam badal kar doosri file overwrite kar deta hai ✅
- **Kya hota hai:** Save As mein "All files" chun kar naam `LICENSE` likhein. App khud `.md` (ya `.txt`) jor kar `LICENSE.md` par likh deti hai. Agar `LICENSE.md` pehle se maujood ho to woh **bina poochhe overwrite** ho jati hai, kyun ke Windows dialog ne sirf `LICENSE` ke liye check kiya tha.
- **Test:** `LICENSE.md` mein "IMPORTANT EXISTING CONTENT" tha, Save As `C:\d\LICENSE` → file ka content "hello" ho gaya.
- **Saath ke masail:** `.gitignore` → `.gitignore.txt` ban jata hai. `Makefile`, `LICENSE`, `hosts` jaisi bina extension wali file kabhi Save As nahi ho sakti.
- **Wajah:** `src/state/actions.ts:383` (`withDefaultExtension`) aur `src/state/logic.ts:198`. `extOf(".gitignore")` khali string deta hai.
- **Fix:** user ka chuna hua path waise hi rakhein. Extension sirf tab jorein jab dialog ka filter Markdown/Text ho, aur jorne ke baad file maujood ho to dobara poochhein.

### C2. "Replace all" file load hone se pehle chale to sirf load shuda hissa badalta hai ✅
- **Kya hota hai:** bari file (2 MB se zyada) khol kar foran Ctrl+H → Replace all dabayein. Sirf utna text badalta hai jitna us waqt memory mein tha. Baqi file baad mein load hoti hai aur waisi ki waisi rehti hai. Koi warning nahi.
- **Test:** 5.4 MB file, 150,000 "foo". Replace all ke baad: 7,521 badle, **142,479 reh gaye**.
- **Wajah:** `src/components/FindBar.tsx:176`. `openFind` full load shuru karta hai lekin Replace all us ka intezar nahi karta.
- **Fix:** Replace/Replace all se pehle `await actions.ensureFullyLoaded(activeId)`; load ke dauran button disabled rakhein.

### C3. Aadhi load hui bari file disk par badal jaye to edits kahin bhi save nahi hote ✅
- **Kya hota hai:** bari file mein edit karein, koi doosra program file badal de (log file, sync tool). Ab:
  1. Save → "File changed on disk ... use Save as to keep your text under another name."
  2. Save as → "This file changed on disk while only part of it was loaded. Reload it to continue."
  3. "Keep mine" dabane ke baad bhi yahi hota hai.
- Yani app khud jo raasta batati hai (Save as) woh band hai. Sirf Reload bachta hai, jis se edits khatam ho jate hain.
- **Wajah:** `src/lib/loader.ts:219` (`LoadBlockedError`) aur `:457` (partial tab ka purana stamp).
- **Fix:** Save As ke liye loaded text + **nayi** file ka tail likhne ki ijazat dein, ya kam az kam "sirf load shuda text ko nayi file mein save karein" ka option dein. Message bhi sahi karein.

### C4. Confirm dialog ke upar message aa jaye to tab aur window kabhi band nahi hoti ✅
- **Kya hota hai:** "Do you want to save changes?" khula ho aur usi waqt koi error message aa jaye (maslan pichhla slow save fail ho, ya background load fail ho). Message confirm dialog ki jagah le leta hai, lekin confirm ka promise kabhi resolve nahi hota.
- **Natija:** us tab ka X kuch nahi karta. Agar yeh window band karte waqt hua ho to `closeInProgress` hamesha `true` rehta hai aur **window band hi nahi hoti** (sirf Task Manager).
- **Test:** dono halaat repro hue: tab close dobara dabane par koi dialog nahi, window close ke 2 aur try par kuch nahi hua.
- **Wajah:** `src/state/store.ts:149` `showMessage` seedha `dialog` set karta hai. `actions.showDialog` yeh case sambhalta hai, `showMessage` nahi.
- **Fix:** `showMessage` mein pehle pending `confirm-close` ko `cancel` se resolve karein (ya messages ki queue banayein).

### C5. Main window pehle band ho to agli dafa session wapas nahi aata 📖
- **Kya hota hai (background mode on, jo default hai):** 2 windows kholein. Pehle **main** window band karein, phir doosri. Doosri window background mein chhup jati hai. Ab Notepadly dobara kholein: khali "Untitled" milta hai, pichhle tabs aur unsaved notes nahi aate.
- **Wajah:** session sirf `main` label wali window restore karti hai. Main window destroy ho chuki hai, aur `src-tauri/src/lib.rs:242` koi bhi bachi hui window jaga deta hai. Woh window `isMainWindow = false` hai, is liye na restore karti hai na drafts likhti hai (`src/state/actions.ts:489`, `:515`).
- Notes disk par maujood rehte hain aur PC restart ke baad wapas aate hain, lekin tab tak user ko lagta hai sab ghayab ho gaya. Is dauran likhe gaye naye notes ka draft bhi nahi banta.
- **Fix:** jab koi window na bache ya main na ho to nayi `main` window banayein; ya background mein jane wali aakhri window ko main ka role dein.

### C6. ANSI encoding mein save karte waqt Urdu/Unicode chupke se `?` ban jata hai 📖
- **Kya hota hai:** file ANSI detect ho (ya status bar se ANSI chunein), us mein Urdu, emoji ya koi aisa harf likhein jo code page mein nahi. Save par har aisa harf `?` ban jata hai. Koi warning nahi, aur tab "saved" dikhti hai.
- **Khatarnak rasta:** UTF-8 file mein pehle 256 KB ke andar ek bhi kharab byte ho to poori file ANSI maan li jati hai. Phir us mein Urdu likh kar save karein to woh hamesha ke liye `????` ho jata hai.
- **Wajah:** `src-tauri/src/files.rs:491` (`Unmappable(_) => out.push(b'?')`).
- **Fix:** save se pehle check karein; unmappable harf hon to user se poochhein ("UTF-8 mein save karein?").

### C7. Encoding sirf pehle 256 KB se pehchani jati hai 📖
- **Kya hota hai:** ANSI file jis ka pehla non-ASCII harf 256 KB ke baad aaye, UTF-8 maan li jati hai. Baad ke chunks mein woh bytes `U+FFFD` (�) ban jate hain. Save karne par load shuda hisse ke woh bytes hamesha ke liye kharab ho jate hain.
- **Wajah:** `src-tauri/src/files.rs:174` `detect_encoding` sirf pehli window dekhta hai; baad ke chunks `from_utf8_lossy` se decode hote hain.
- **Fix:** baad ke chunk mein invalid UTF-8 mile to tab ko ANSI mein dobara load karein, ya kam az kam save rok kar warning dein.

### C8. Tab badalte waqt typing pichhli tab ki file mein chali jati hai ✅
- **Kya hota hai:** aisi tab par click karein jo abhi load nahi hui (session se restore, hibernated, ya slow/network drive). Tab strip foran nayi tab ko active dikhati hai, lekin editor mein load hone tak **pichhli file** rehti hai. Is dauran jo likhein woh pichhli file mein jata hai aur woh dirty ho jati hai.
- **Test:** `a.txt` par click (1.5 s ki read delay), "TYPED" likha → `b.txt` ka text "TYPEDBBB file" ho gaya, `a.txt` saaf.
- **Wajah:** `src/state/actions.ts:227-238`. `activeId` pehle set hota hai, `engine.activate` load ke baad.
- **Fix:** load ke dauran editor ko read-only/khali state par rakhein, ya `activeId` tab badlein jab doc tayyar ho.

---

## HIGH: bare feature tootay hue ya ghalat natija

### H1. Table cell mein Ctrl+B / Ctrl+I / Bold button `****text` bana deta hai ✅
- Cell mein "apple" select kar ke Ctrl+B → document mein `| ****apple | 2 |`.
- **Wajah:** `src/lib/shortcuts.ts:144` global handler (capture phase) pehle chalta hai aur editor ki chhupi hui selection (cell ka shuru) par bold lagata hai. Table widget ka apna Ctrl+B code (`widgets.ts:451`) kabhi chalta hi nahi.
- **Fix:** global handler mein table cell (`contenteditable="plaintext-only"`) ko pehchan kar widget ko handle karne dein.

### H2. Left/Right arrow rendered table, maths block aur Mermaid diagram par atak jata hai ✅
- **Kya hota hai:** table ke neeche wali line ke shuru se Left arrow dabayein. Cursor chhupe hue source mein ek ek harf chalta hai aur nazar nahi aata.
- **Test:** 2 row ki chhoti table paar karne ke liye **58 dafa** Left arrow dabana para. Bare Mermaid diagram ke liye sainkron dafa.
- Is dauran cursor ki state aur screen ka caret alag jagah hote hain (state 16 par, type kiya hua harf 22 par gaya).
- **Wajah:** `src/editor/livePreview/block.ts` replace decorations ke liye `EditorView.atomicRanges` nahi deta.
- **Fix:** block widgets ke ranges ko `atomicRanges` mein dein. Saath hi keyboard se table/maths ke andar jane ka tareeqa dein (abhi sirf mouse click se mumkin hai).

### H3. Document ke bilkul shuru mein table ho to Up arrow ke baad typing bikhar jati hai ✅
- Header cell mein Up arrow → "abc" type karein. "a" table ke neeche chala gaya (aur table ki nayi row ban gaya), "b" document ke aakhir mein, "c" ghayab.
- **Wajah:** `src/editor/livePreview/widgets.ts:393` `anchor = Math.max(0, start - 1)`; position 0 table ke replaced range ke andar hai.
- **Fix:** table doc ke shuru mein ho to pehle ek khali line insert karein, phir cursor wahan rakhein.

### H4. Khali line par table insert karein to neeche wala paragraph table ki row ban jata hai ✅
- `first`, khali line, `second paragraph`. Khali line par 2×2 table insert → "second paragraph" table ki teesri row.
- **Wajah:** `src/editor/commands.ts:312` `suffix`: khali line par hon aur neeche text ho to table ke baad khali line nahi jorta.
- **Fix:** agli line khali na ho to hamesha `\n` jorein.

### H5. Blockquote/callout ke andar wali table par table commands table ko kharab kar dete hain ✅
- `> | a | b |` wali table mein "Insert row below" → har row `| > | a | b |` ban gayi aur table quote se bahar nikal gayi.
- **Wajah:** `src/editor/commands.ts:221` `locateTable` line ke shuru se parse karta hai, `> ` samet.
- **Saath:** list, quote ya callout ke andar table, Mermaid, block maths aur `---` render hi nahi hote (`block.ts:143` sirf top-level blocks dekhta hai), jab ke toolbar "Edit table" enabled dikhata hai.
- **Fix:** nested tables ke liye quote/indent prefix alag kar ke parse karein, ya nested table par commands disable karein.

### H6. Ek lambi line (20,000+ characters) poore document ka live preview hamesha ke liye band kar deti hai ✅
- Base64 image (`![](data:image/png;base64,...)`) ya koi minified line paste karein. Poora document raw Markdown ban jata hai.
- Status bar phir bhi **"Formatted"** kehta hai aur toolbar dikhta rehta hai. Line delete ya Undo karne par bhi wapas nahi aata; file band kar ke dobara kholni parti hai.
- **Wajah:** `src/editor/index.ts:323` `checkDegrade`; `degraded` flag "sticky" hai.
- **Fix:** lambi line hat jaye to preview wapas chalu karein; status bar mein wajah dikhayein; behtar yeh ke sirf us line ko skip karein.

### H7. File delete ho kar dobara ban jaye to saaf tab "unsaved" ban jati hai ✅
- `git checkout`, OneDrive sync, ya woh editors jo "delete + rename" se save karte hain. Tab pehle "deleted" flag hoti hai aur dirty ban jati hai, phir file wapas aane par "This file changed on disk" bar aati hai aur band karte waqt "save changes?" poochha jata hai, halan ke user ne kuch nahi likha.
- **Wajah:** `src/lib/loader.ts:590` `flag-deleted` par `forceDirty`; phir `decideExternal` dirty tab ko reload nahi karta.
- **Fix:** agar user ne khud edit nahi kiya (`editSeq` wahi hai) to file wapas aane par chupke se reload karein aur dirty hata dein.

### H8. Har typing ke waqfe par poora document draft mein dobara likha jata hai ✅
- 1.59 MB ki dirty file mein har "x" ke baad 1.59 MB ka draft likha gaya (4 keystrokes = 4 poore writes). 100 MB file mein yeh har 800 ms par 100 MB ka IPC + disk write hai.
- Spec kehta hai "no work proportional to document length per keystroke".
- **Wajah:** `src/lib/loader.ts:729`. Save bhi poora text IPC se bhejta hai.
- **Fix:** bari files ke liye lamba debounce, ya sirf tabdeeli (diff/patch) likhein, ya idle time mein likhein.

### H9. Print screen jaisa nahi hota, aur comments bhi chhap jate hain ✅
- README aur Help kehte hain comments "left out of printing". Asal mein `%% secret comment %%` chhapta hai.
- Print mein yeh sab **raw** aata hai: `$E=mc^2$`, `$$...$$`, Mermaid (code ki tarah), callout (`[!warning]`), `==highlight==`, `[[wikilink]]`, `#tag`. Front matter `<hr>` aur `<h2>title: x</h2>` ban jata hai.
- **Wajah:** `src/lib/print.ts:134` sirf `marked` (plain GFM) istemal karta hai.
- **Fix:** print se pehle `%%...%%` aur front matter nikalein; KaTeX/Mermaid/callouts ko print HTML mein render karein.

### H10. Find ka "x of y" counter ghalat hota hai ✅
1. Cursor kahin aur le ja kar Next dabayein: line 40 ke match par counter **"3 of 50"** dikhata hai (sirf +1 karta hai).
2. F3 / Shift+F3 se match badalta hai lekin counter bilkul update nahi hota.
3. 10,000 ya zyada matches: "1 of 10000", phir Next par **"0 of 10000"**. "10000+" hona chahiye.
- **Wajah:** `src/editor/find.ts:197`; `src/lib/shortcuts.ts:123` natija FindBar ko nahi deta; `FindBar.tsx:93` `FIND_COUNT_LIMIT` istemal nahi karta.

### H11. Table, block maths aur Mermaid ke andar ke Find matches nazar nahi aate ✅
- Table mein "pear" dhoondein: counter "1 of 1", lekin screen par koi highlight nahi. Lagta hai Find ne kuch nahi kiya. Replace phir bhi andhe mein kaam karta hai.
- **Wajah:** yeh blocks widget se replace hain; mark decorations un ke andar nahi dikhte.
- **Fix:** match widget ke andar ho to source khol dein ya cell ko highlight karein.

### H12. Settings aur Recent list windows ke darmiyan sync nahi hoti 📖
- Ek window mein theme/font/startup badlein to doosri khuli window mein nahi badalta.
- Har window poora settings object likhti hai, is liye purani window ki agli tabdeeli pehli window ki settings **mita deti hai**. Recent files ka bhi yahi haal.
- **Wajah:** `src/state/store.ts:111`; `storage` event ka koi listener nahi.

### H13. "Update automatically" band karne se download shuda update nahi rukta 📖
- Update download ho chuka ho ("ready") aur user setting off kar de, to bhi band karte waqt install ho jata hai.
- **Wajah:** `src-tauri/src/autoupdate.rs:208` `install_if_ready` `enabled` check nahi karta.

### H14. Mixed line endings wali file save par poori badal jati hai 📖
- File mein CRLF aur LF dono hon to save par **har** line pehli line wale style mein likhi jati hai. Git diff mein poori file badli hui dikhti hai. Koi warning nahi; status bar sirf pehli line ka style dikhata hai.
- **Wajah:** `src-tauri/src/files.rs:458` `encode_text`.

### H15. Jis folder mein nayi file banane ki ijazat nahi wahan save fail hota hai 📖
- File khud writable ho lekin folder mein temp file na ban sake (kuch ACLs, root folders, kuch network shares) to save "Access is denied" deta hai, halan ke seedha likhna mumkin tha.
- **Wajah:** `src-tauri/src/files.rs:644`. In-place fallback sirf replace fail hone par hai, temp file banne mein fail hone par nahi.

### H16. Band app ke dauran delete hui file restore par khali "unsaved" tab ban jati hai ✅
- Session mein `gone.md` tha, file delete ho gayi. Start par: khali document, dirty dot, "deleted" bar. "Keep mine" + Save → disk par **khali file** ban jati hai. Band karte waqt khali document ke liye "save changes?" poochha jata hai.
- **Wajah:** `src/lib/loader.ts:397` `materialiseOrFlag`.
- **Fix:** aisi tab ko dirty na karein; "file nahi mili, tab band karein?" poochhein.

---

## MEDIUM

### M1. Table cell mein Ctrl+A poora document select kar leta hai ✅
Focus cell mein rehta hai, cell ka text select nahi hota, status bar "68 of 68 characters" dikhata hai. Wajah: `src/lib/shortcuts.ts:131`; table cell "native input" nahi mani jati.

### M2. Table cell mein F5, Ctrl+K aur Edit > Paste cell ke shuru mein insert karte hain ✅
Caret cell ke aakhir mein tha, F5 → `| 11:50 AM 11/10/2026apple |` (yeh test hua). Code ke mutabiq Ctrl+K aur Edit > Paste bhi isi jagah insert karte hain, aur Edit > Copy/Cut cell ki selection nahi dekhte (disabled rehte hain).

### M3. Ctrl+M ke baad Tab key editor se bahar chali jati hai ✅
Ghalti se Ctrl+M dab jaye to Tab focus ko status bar par le jata hai aur typing kahin nahi jati. Koi ishara nahi ke mode badla. Wajah: `src/editor/index.ts:212` CodeMirror ka `toggleTabFocusMode` default keymap mein reh gaya. `Ctrl+/`, `Alt+Arrow`, `Ctrl+[`/`]`, `Ctrl+Shift+K` bhi chhupe hue chalu hain.

### M4. Heading / Bold kai lines par ghalat Markdown banate hain ✅
- Sab select kar ke H2 → `## ` khali lines par bhi, aur `## - item`, `## > quote`.
- Do paragraphs select kar ke Bold → `**one\n\ntwo**`, jo bold nahi banta.
- Wajah: `src/editor/commands.ts:108` aur `:44`.

### M5. Aakhri table row se neeche jane par document "unsaved" ho jata hai ✅
Document ke aakhir mein table ho to Down arrow ya Escape ek newline jorta hai aur tab dirty ho jati hai. Wajah: `widgets.ts:387`.

### M6. Save As kisi aur khuli tab ke path par → ek hi file ki do tabs ✅
Dono tabs mein `a.txt`; ek mein save karein to doosri STALE/reload mein phansti hai.

### M7. Links jo ghalat khulte hain ✅
| Link | Kya hota hai |
| --- | --- |
| `[x](report.pdf)`, `[x](photo.png)` | PDF/image ke bytes **text tab** mein kachra ban kar khulte hain |
| `[[v1.2 notes]]` | `.md` nahi jurta → "Could not open file" |
| `[x](C%23 guide.md)`, `a%26b.md` | `%23`, `%26` decode nahi hote → file nahi milti |
| `[x](file:///C:/notes/a.md)` | kuch nahi hota |
| `[x](sub/)` | `sub\.md` kholne ki koshish |
| `[x](/docs/a.md)` | document ke folder se relative maana jata hai |
Wajah: `src/state/logic.ts:145-161` (`decodeURI` reserved characters decode nahi karta).

### M8. `.mdx` installer mein Markdown hai lekin app mein plain text ✅
`src-tauri/windows/hooks.nsh` `.mdx` ko main Markdown type banata hai; `src/state/logic.ts:117` mein `.mdx` nahi. Open/Save filters mein bhi nahi.

### M9. Startup ke dauran doosri file kholne ka event zaya ho sakta hai 📖
`open-paths` listener `openHere(pending)` ke **baad** lagta hai (`src/state/actions.ts:689-690`), jab ke Rust window ko pehle hi "ready" maan leta hai. Is waqfe mein Explorer se kholi gayi file chupke se nahi khulti. Close handler bhi der se lagta hai.

### M10. "Open in a new window" setting ke ajeeb natije 📖
- Explorer se file kholein: nayi window banti hai **aur** main window bhi samne aa jati hai (background se jaagne par khali/purani session wali window bhi dikhti hai).
- Khali window mein File > Open bhi nayi window kholta hai aur khali window reh jati hai.
- Wikilink click bhi nayi window kholta hai.
- Doosri window mein khuli file ka pata nahi chalta, is liye ek file do windows mein khul sakti hai.

### M11. Command line se nayi file ka naam dein to kuch nahi hota 📖
`notepadly newfile.txt` (file maujood nahi) → khali Untitled. Notepad poochhta hai "create a new file?". App chalu ho aur dobara launch karein to sirf purani window focus hoti hai, nayi tab/window nahi. `-` se shuru hone wale file names bhi nahi khulte. Wajah: `src-tauri/src/lib.rs:229`.

### M12. Hibernation Undo history mita deta hai 📖
1 MB se bari saaf tab 60 second inactive rahe to us ka editor state gira diya jata hai. Wapas aane par Ctrl+Z kuch nahi karta, callout fold state bhi reset. Wajah: `src/lib/loader.ts:634`.

### M13. Poori file wale kaam bari files par memory bhar dete hain 📖
Find, Replace, Select all, Ctrl+End, Print, Save As, Go to line, aur EOL/encoding badalna poori file RAM mein laate hain. Cancel ka koi tareeqa nahi. Taqreeban 500 MB se bari file par `getText()` JS string limit se fail hoga. Print 100 MB par `marked.parse` main thread ko jaam kar dega.

### M14. Bari file mein Find har keystroke par poori file scan karta hai 📖
`recount` aur `firstFrom` synchronous hain (sirf 120 ms debounce). Kam matches wali 100 MB file mein har harf par UI ruk sakta hai. Wajah: `src/editor/find.ts:107`.

### M15. Encoding ghalat pehchani jaye to theek karne ka koi tareeqa nahi 📖
- BOM ke baghair UTF-16 file UTF-8 maan li jati hai (har harf ke beech NUL).
- Status bar se encoding badalna sirf **save** par asar karta hai; file dobara decode nahi hoti ("Reopen with encoding" nahi hai).
- Binary file text ki tarah khulti hai aur save karne par kharab ho jati hai, koi warning nahi.
- Sirf code pages 874, 932, 936, 949, 950, 1250-1258 support hain; baqi sab (maslan 866) windows-1252 maan liye jate hain.

### M16. Edit > Cut clipboard fail hone par bhi text delete kar deta hai 📖
`src/editor/index.ts:611`: `writeText` ka intezar nahi. `paste()` (`:623`) mein koi error handling nahi; fail ho to chupke se kuch nahi hota.

### M17. "Exit" app band nahi karta, aur ghalat window bach sakti hai 📖
Background mode on ho to File > Exit sirf window chhupata hai. Kai windows hon to race hoti hai: kabhi main window destroy ho jati hai aur doosri bachti hai (phir C5 wala masla).

### M18. Doosri windows session aur size yaad nahi rakhtin 📖
Sirf `main` window session/drafts likhti hai aur size/position yaad rakhti hai (`src-tauri/src/lib.rs:285`). Doosri window ke tabs agli dafa nahi aate; har nayi window 1280×800 par khulti hai.

### M19. Formatting toggle sab tabs badal deta hai; `.txt` kabhi Formatted nahi ho sakti 📖
- View > Formatting off/on karne se "Markdown syntax" chuni hui tabs ka intikhab kho jata hai.
- Untitled (Formatted) note ko `.txt` naam se save karein to mode Plain ho jata hai aur status bar se wapas nahi aa sakta. `.txt`, `.log` wagaira mein Markdown likha ho to dekhne ka koi tareeqa nahi.

### M20. File kholne ke error message mein ghalat naam, aur Recent saaf nahi hota 📖
`src/state/actions.ts:320` hamesha list ki **aakhri** file ka naam likhta hai. Fail hui file Recent mein rehti hai kyun ke entry "name: error" hoti hai aur path se match nahi karti.

### M21. Find bar khuli ho aur be-load tab par jayein to F3 "No results" deta hai 📖
Find purani tab ke doc par chalta hai, phir `engine.activate` session clear kar deta hai. Query dobara likhne tak Next kaam nahi karta.

### M22. Restore par file parhi na ja sake to khali document milta hai 📖
File kisi aur program ne lock ki ho to tab khali khulti hai (partial, offset 0). Is mein likh kar save karein to likha hua text asli file ke **shuru mein jur** jata hai. Data nahi jata, lekin screen aur disk mel nahi khate.

---

## LOW: chhote bugs aur ghalat pehchan

| # | Masla | Status |
| --- | --- | --- |
| L1 | `$HOME/$USER` maths ban jata hai ("Use HOME/USER for paths" dikhta hai) | ✅ |
| L2 | `#fff`, `#1a2b3c` jaise colour codes tag pill ban jate hain | ✅ |
| L3 | `if a==b or c==d` mein "b or c" highlight ho jata hai aur `==` chhup jate hain | ✅ |
| L4 | Time/Date (F5) hamesha US format `3:05 PM 11/10/2026`, system locale nahi | ✅ |
| L5 | "characters" UTF-16 units ginta hai (emoji = 2). Partial dirty file ka total purana rehta hai | 📖 |
| L6 | Font list mein ghalat families ("Montserrat Extra"), "Inter" hamesha dikhta hai chahe install na ho | 📖 |
| L7 | 400 undo steps ke baad "undo se saved state par wapas" dirty dot nahi hatata (`index.ts:57`) | 📖 |
| L8 | Table cell renderer: `2 * 3 * 4` italic ban jata hai; `_x_`, maths, images, wikilinks cell mein render nahi hote | 📖 |
| L9 | Bina padding wali table (`\|a\|b\|`) ke cell ke aakhir mein `\` likhein to agla cell is mein mil jata hai | 📖 |
| L10 | Table commands header se zyada cells wali row ke fazool cells delete kar dete hain | 📖 |
| L11 | Band na hua `$$` / `%%` 5,000 lines tak, aur band na hua front matter 1,000 lines tak styling badal deta hai | 📖 |
| L12 | Block maths, comment block aur footnote definition sirf top level par; list/quote/callout ke andar nahi | 📖 |
| L13 | Ctrl+click links sirf Formatted mode mein; Markdown syntax aur Plain mein nahi | 📖 |
| L14 | Remote images khud load hoti hain (privacy/tracking). `http://` aur `file://` images nahi dikhtin | 📖 |
| L15 | Find box mein Ctrl+B / Ctrl+I / Ctrl+K / F5 document par asar karte hain | 📖 |
| L16 | Drafts folder kabhi saaf nahi hota: kharab `session.json` ya crash ke baad draft files hamesha pari rehti hain; draft parhne mein error ho to draft delete ho jata hai | 📖 |

Mazeed chhoti baatein: khali nested list item par Enter outdent nahi karta, poora item hata deta hai; Tab se indent karne par numbering theek nahi hoti; `pathsEqual` `..`, 8.3 names ya UNC/mapped drive ko nahi pehchanta (ek file do tabs mein); Ctrl+wheel/pinch har event par 10% zoom; partial file par galat "changed" message jab file asal mein delete hui ho (3 second mein khud theek).

---

## ⚠️ Windows par asli app mein check karne wali cheezein

Yeh code se mumkin lagte hain lekin WebView2 par chala kar dekhna zaroori hai.

| # | Shak | Kyun |
| --- | --- | --- |
| W1 | Editor mein select kiya hua text mouse se drag kar ke move nahi hota | `tauri.conf.json` mein `dragDropEnabled: true`; Tauri Windows par is se HTML5 drag-drop band kar deta hai |
| W2 | Edit > Paste pehli dafa permission popup dikhata hai ya kuch nahi karta | `navigator.clipboard.readText()`; clipboard access enable nahi kiya gaya |
| W3 | Rendered table border, maths, diagram, image ya checkbox par right-click → WebView2 ka page menu ("Refresh", "Back", "Save as") | `shortcuts.ts:62` `.cm-content` ke andar sab ko text surface manta hai. "Refresh" unsaved kaam gira sakta hai |
| W4 | Settings/Help ya dialog khula ho to F3 WebView2 ka apna Find bar khol deta hai | F3 suppressed list mein nahi (`shortcuts.ts:45`) |
| W5 | Maximize button par hover se Windows 11 Snap Layouts nahi aata | Custom caption buttons |
| W6 | "Autocorrect" setting ka koi asar nahi | `autocorrect` attribute Chromium mein kaam nahi karta |
| W7 | Kai MB ki ek hi line wali file (minified JSON) word wrap ke saath bohat sust | CodeMirror lambi lines par kamzor hai; yahan naap nahi saka |
| W8 | 260 characters se lambe path, FAT/exFAT USB aur network share par save | `ReplaceFileW` ko raw path diya jata hai (`files.rs:545`) |

---

## Edge cases: kis haal mein app kya karti hai

| Haalat | App kya karti hai | Theek? |
| --- | --- | --- |
| Khali file | Khulti hai, UTF-8 + CRLF maan leti hai | ✅ |
| 127 MB file | Pehle 256 KB foran, baqi scroll par | ✅ (C2, C3, M13 dekhein) |
| File kisi aur ne badli, tab saaf | Chupke se reload, scroll barqarar, Undo history khatam | ✅ |
| File badli, tab dirty | Bar: Reload / Keep mine. Save STALE deta hai jab tak Keep mine na dabayein | ✅ |
| File delete hui | Bar + tab dirty. Wapas aa jaye to H7 | ⚠️ |
| File rename hui | "deleted" samjhi jati hai | Qabil-e-qabool |
| Read-only file | Typing ho jati hai, Save par "Access is denied". Pehle se koi ishara nahi | Kamzor |
| File kisi ne exclusive lock ki | Kholne par "Could not open file"; save par error, asli file mehfooz | ✅ |
| Disk full / save ke beech crash | Temp file fail, asli file mehfooz | ✅ |
| Network drive toot gayi | Stat error nazar-andaz, koi ghalat flag nahi | ✅ |
| Window focus mein nahi | Disk ki tabdeeli tab tak nahi dikhti jab tak focus na aaye (side-by-side log dekhna mumkin nahi) | Design, lekin ghair mutawaqqa |
| Ek file do windows mein | Doosra save STALE | ✅ |
| Folder drop karna | "Could not open file" | ✅ |
| Binary file | Kachra text; save par kharab | M15 |
| Sirf CR line endings | Support hai ("Macintosh (CR)") | ✅ |
| Urdu/RTL text | Line `dir="auto"` se sahi; table cells mein RTL alignment nahi | Adhoora |
| Akeli aakhri tab band karna | Window band (background mein chhup jati hai) | Notepad jaisa |
| App crash / kill | Aakhri 800 ms ke ilawa drafts mehfooz (sirf main window) | ✅ |
| Kharab `session.json` | Nayi session; purane drafts yateem (L16) | Kamzor |
| Typing start hote hi (pehle ~200 ms) | Session restore se pehle likha hua kho sakta hai | Chhota risk |

---

## Kya theek mila

- Typecheck saaf, 30 unit tests pass.
- 900 random keystrokes aur format commands par koi exception nahi.
- File lock na karne ka design, STALE check aur temp-file se safe save soch samajh kar bana hai.
- Print ka HTML sanitizer `<script>` aur `onerror` hata deta hai; KaTeX `trust: false` aur Mermaid `securityLevel: "strict"` hain; table cell renderer HTML escape karta hai. Document se script chalane ka koi rasta nahi mila.
- Draft IDs path traversal se mehfooz hain (`store.rs`).
