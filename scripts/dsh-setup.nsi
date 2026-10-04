; dsh-setup.nsi — DSH-X 的 NSIS 安装程序。
;
; 为什么从 Inno Setup 换成 NSIS：这一版要把内置的 WebView2 固定版本运行时（约 240 MB
; 的 CAB，解开 400+ MB）随包发出去。NSIS 对「一大坨文件 + 少数几个精确控制的步骤」
; 更直接：文件用 File /r 一次收进去，部署顺序靠 Section 表达，不需要绕 Inno 的
; [Files] 通配与 [Code] 回调。
;
; 安装布局：
;   {app}\           启动器本体（DSH.exe、node\、public\、scripts 等）
;   {app}\webview2\  内置的 WebView2 固定版本运行时（DSH.exe 启动时指过去）
;   {app}\core\      dsh 本体（离线载荷）
;   {app}\packages\  内置插件
;
; ★ 两种安装范围，由用户在向导第二页选（和多数 Windows 软件一样）：
;
;   仅为我安装   →  $LOCALAPPDATA\Programs\DSH-X，写 HKCU，**不需要管理员**
;   为所有用户安装 →  $PROGRAMFILES64\DSH-X，写 HKLM，需要管理员（会弹 UAC）
;
;   这套由 NSIS 自带的 MultiUser.nsh 实现：它负责提权、把 $INSTDIR 与
;   注册表根（SHELL_CONTEXT）在两种模式间切好，卸载器也按安装时的模式走。
;   用户数据（%APPDATA%\DSH、~/.dsh）两种模式下一模一样，卸载都不动它们。
;   {app}\corepack\  pnpm 缓存
; 用户数据一律不在这里：配置在 %APPDATA%\DSH，会话在 %DSH_HOME%（默认 ~/.dsh）。
; 卸载只删自己装的东西，这两处原样保留。

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

;; ---- 版本信息（由构建脚本用 /D 传进来） ----
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_NAME
  !define APP_NAME "DSH-X"
!endif
!ifndef PUBLISHER
  !define PUBLISHER "yyh"
!endif
;; 收进安装包的目录：release\DSH\ 的产物
!ifndef STAGE_DIR
  !define STAGE_DIR "..\release\DSH"
!endif
;; 内置的 WebView2 固定版本运行时目录（可空：不带运行时也能装，DSH.exe 会回落系统那份）
!ifndef WEBVIEW2_DIR
  !define WEBVIEW2_DIR ""
!endif
;; 卸载时用来「只结束安装目录里的进程」的脚本（原因见 Uninstall 段的说明）
!ifndef STOP_SCRIPT
  !define STOP_SCRIPT "${__FILEDIR__}\stop-installed.ps1"
!endif

Name "${APP_NAME}"
OutFile "..\release\DSH-Setup.exe"
SetCompressor /SOLID lzma

;; ---- 单用户 / 全机器：交给 NSIS 自带的 MultiUser ----
;;
;; MULTIUSER_INSTALLMODE_COMMANDLINE 让 /AllUsers 与 /CurrentUser 也能从命令行指定
;;（静默安装、脚本批量部署要用）；不带参数时向导里选。
!define MULTIUSER_EXECUTIONLEVEL Highest
!define MULTIUSER_MUI
!define MULTIUSER_INSTALLMODE_COMMANDLINE
!define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "Software\${APP_NAME}"
!define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "InstallMode"
!include "MultiUser.nsh"

;; ★ 这里**故意不定义** MULTIUSER_INSTALLMODE_INSTDIR / _INSTDIR_REGISTRY_*。
;;
;;   那两个宏的作用是「由 MultiUser 在 .onInit 里替你把 $INSTDIR 定成按范围算出来的默认值」，
;;   而它赋值时不区分「用户已经指定过目录」—— 实测 /S /CurrentUser /D=D:\somewhere 会被它
;;   覆盖回 %LOCALAPPDATA%\Programs\<AppName>，退出码还是 0，看起来像装成功了，
;;   其实装到别处（最小复现里 /D 完全无效）。命令行指定目录、以及向导里的目录页，
;;   都得由我们自己在 .onInit 里「只在没指定时才给默认值」。

;; 默认「仅为我安装」：不弹 UAC、装到用户目录，这是我们一贯的默认，
;; 也是多数用户想要的（不需要管理员就能装完）。
!define MULTIUSER_INSTALLMODE_DEFAULT CURRENT_USER

RequestExecutionLevel user

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 ${PUBLISHER}"

;; ---- 界面 ----
!define MUI_ABORTWARNING
!define MUI_ICON "..\assets\dsh.ico"
!define MUI_UNICON "..\assets\dsh.ico"
!define MUI_WELCOMEPAGE_TITLE "${APP_NAME} 安装向导"
!define MUI_WELCOMEPAGE_TEXT "这个安装程序会把 ${APP_NAME} 装到本机，并带上它自己的 Node 运行时、dsh 本体、内置插件与 WebView2 运行时。$\r$\n$\r$\n全程不需要联网；配置与会话留在你的用户目录里，卸载不会动它们。"

!insertmacro MUI_PAGE_WELCOME

;; 「仅为我安装 / 为所有用户安装」——和多数 Windows 软件一样的选择页。
;; MultiUser.nsh 会按选择决定 $INSTDIR 与是否需要管理员。
!insertmacro MULTIUSER_PAGE_INSTALLMODE

!insertmacro MUI_PAGE_DIRECTORY

;; 快捷方式选项（桌面 / 开始菜单），两项各自可选。
;; 用 components 页而不是自定义页：MUI 自带、能记住上次的选择，也不需要写回调。
!define MUI_COMPONENTSPAGE_NODESC
!insertmacro MUI_PAGE_COMPONENTS

!insertmacro MUI_PAGE_INSTFILES

;; 完成页：默认勾选「运行」，与 Inno 那边的行为保持一致
!define MUI_FINISHPAGE_RUN "$INSTDIR\DSH.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

;; ---- MultiUser 的两个入口 ----
;;
;; .onInit 必须在**任何**用到 $INSTDIR / SHELL_CONTEXT 的代码之前跑：它读命令行参数
;; 或注册表里记着的上次选择，定下这次是「仅为我」还是「为所有用户」，并把 $INSTDIR 与
;; 注册表根相应换好。少了它，选「为所有用户」也只会装到用户目录。
;; 默认安装目录：按安装范围算，**只在用户没指定时**才用。
;;
;; 判据是 $INSTDIR 是否为空：命令行 /D= 会让 NSIS 在 .onInit 之前就把它填好，
;; 向导里用户在目录页改的也是它（那是 .onInit 之后的事，所以这里不会打架）。
;; 这个默认值要放在 MULTIUSER_INIT 之后：那一步才定下这次是 CurrentUser 还是 AllUsers。
Function .onInit
  !insertmacro MULTIUSER_INIT
  ${If} $INSTDIR == ""
    ${If} $MultiUser.InstallMode == "AllUsers"
      StrCpy $INSTDIR "$PROGRAMFILES64\${APP_NAME}"
    ${Else}
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_NAME}"
    ${EndIf}
  ${EndIf}
FunctionEnd

;; 卸载器同样要初始化，否则它不知道当初装在哪、该读哪个注册表根。
Function un.onInit
  !insertmacro MULTIUSER_UNINIT
FunctionEnd
;; ---- 主安装段 ----
Section "DSH-X" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ;; 1) 启动器本体 + 离线载荷（core/ packages/ corepack/ node/ …）。
  ;;
  ;;    这里不带 /x：WebView2 运行时**不在 stage 里**（打包脚本刻意没放，见 pack.mjs 的
  ;;    assemble），由下面第 2 步从 WEBVIEW2_DIR 单独收，保证同一个 557 MB 的运行时
  ;;    只进包一次。
  ;;
  ;;    为什么不用 /x 排掉 stage 里那份：实测 /x 在 /r 递归时**不作用于子目录内容**，
  ;;    /x "webview2" 与 /x "webview2\*" 都排不掉（迷你复现里日志照样 Descending 进去），
  ;;    两份都进包、Install data 冲到 1.22 GB。与其和它的语义较劲，不如让它只有一个来源。
  DetailPrint "正在写入程序文件…"
  File /r "${STAGE_DIR}\*.*"

  ;; 2) 内置的 WebView2 固定版本运行时。
  ;;
  ;;    官方给固定版本发的是一份 .cab（实测 243.5 MB，解开 557.4 MB / 168 个文件），
  ;;    里面是 msedgewebview2.exe 加一堆 DLL。装机上展开一次即可，之后启动只读它。
  ;;    CAB 里多一层 Microsoft.WebView2.FixedVersionRuntime.<版本>.x64\ 目录 ——
  ;;    那一层由打包脚本剥掉（收载荷时就摊平），安装程序这边只管往里解。
  ;;    DSH.exe 启动时把 WEBVIEW2_BROWSER_EXECUTABLE_FOLDER 指到 $INSTDIR\webview2，
  ;;    WebView2 加载器就认这一份，完全不碰系统里那份 Evergreen。
  ;;
  ;;    这样做的好处在离线场景：Win10 旧镜像、LTSC、被精简过的系统上未必预装
  ;;    Evergreen，缺了它内嵌窗口建不出来、界面只能退回系统浏览器。
  !if "${WEBVIEW2_DIR}" != ""
    !echo "WEBVIEW2_DIR = ${WEBVIEW2_DIR}"
    !echo "WEBVIEW2 exe 路径 = ${WEBVIEW2_DIR}\msedgewebview2.exe"
    !if /FILEEXISTS "${WEBVIEW2_DIR}\msedgewebview2.exe"
      !echo "FILEEXISTS 判定：是（走 File /r 目录分支）"
      ;; 已经是解开的目录：直接拷（开发/调试时更省事）
      DetailPrint "正在布置 WebView2 运行时…"
      SetOutPath "$INSTDIR\webview2"
      File /r "${WEBVIEW2_DIR}\*.*"
    !else
      !echo "FILEEXISTS 判定：否（走 expand CAB 分支）"
      ;; 直接给了 .cab：先落到临时目录再展开。
      ;;
      ;; 注意 CAB 里套了一层 Microsoft.WebView2.FixedVersionRuntime.<版本>.<arch>\ ——
      ;; 所以先解到临时目录，再把里层内容搬到 webview2\ 下，最后删掉临时目录。
      ;; 不这么做的话 exe 会落在 $INSTDIR\webview2\Microsoft.WebView2...\，而 DSH.exe 找的是
      ;; $INSTDIR\webview2\msedgewebview2.exe，等于白装。
      ;;
      ;; （打包脚本平时会先摊平再交给这里，走的是上面那个分支；这条路径留给
      ;;  「直接把官方 CAB 丢进来」的用法，是它该有的健壮性。）
      InitPluginsDir
      DetailPrint "正在展开 WebView2 运行时（约 557 MB，需要一会儿）…"
      File "/oname=$PLUGINSDIR\wv2.cab" "${WEBVIEW2_DIR}"
      nsExec::ExecToLog '"$SYSDIR\expand.exe" -F:* "$PLUGINSDIR\wv2.cab" "$PLUGINSDIR\wv2"'
      Pop $0
      ${If} $0 != 0
        DetailPrint "WebView2 运行时展开失败（expand 退出码 $0）；程序仍会尝试使用系统已装的那份"
      ${Else}
        CreateDirectory "$INSTDIR\webview2"
        ;; 里层那个版本目录名带版本号，用 FindFirst 找它（NSIS 没有通配符遍历目录的原生算子）
        FindFirst $1 $2 "$PLUGINSDIR\wv2\Microsoft.WebView2.FixedVersionRuntime.*"
        ${If} $2 != ""
          CopyFiles /SILENT "$PLUGINSDIR\wv2\$2\*.*" "$INSTDIR\webview2"
        ${Else}
          ;; 没有那一层（别的来源、或已经摊平过）：整个目录搬过去
          CopyFiles /SILENT "$PLUGINSDIR\wv2\*.*" "$INSTDIR\webview2"
        ${EndIf}
        FindClose $1
        RMDir /r "$PLUGINSDIR\wv2"
      ${EndIf}
    !endif
  !else
    DetailPrint "这一份安装包不带 WebView2 运行时，将使用系统已安装的那份"
  !endif

  ;; 3) 卸载器 + 卸载时用的辅助脚本 + 注册表（让「应用和功能」认识它）
  ;;
  ;;    stop-installed.ps1 放在安装目录里而不是只解到临时目录：卸载器可能在任何时候
  ;;    被运行（用户在「应用和功能」里点卸载），那时 $PLUGINSDIR 早已不存在。
  SetOutPath "$INSTDIR"
  File "/oname=stop-installed.ps1" "${STOP_SCRIPT}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ;; 注册表根用 SHELL_CONTEXT 而不是写死 HKCU：MultiUser.nsh 会按安装范围把它指向
  ;; HKCU（仅为我）或 HKLM（为所有用户），两种模式下「应用和功能」都能正确显示。
  WriteRegStr SHELL_CONTEXT "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "Software\${APP_NAME}" "InstallMode" "$MultiUser.InstallMode"
  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH-X"
  WriteRegStr SHELL_CONTEXT "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr SHELL_CONTEXT "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr SHELL_CONTEXT "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr SHELL_CONTEXT "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\DSH.exe"
  WriteRegStr SHELL_CONTEXT "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr SHELL_CONTEXT "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  ;; 没有修改/修复功能，别让系统显示那两个按钮
  WriteRegDWORD SHELL_CONTEXT "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD SHELL_CONTEXT "${UNINST_KEY}" "NoRepair" 1

  ;; 记下装了多少，卸载时「应用和功能」能显示体积
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHELL_CONTEXT "${UNINST_KEY}" "EstimatedSize" "$0"

  ;; 4) 安装语言（快捷方式在下面的可选段里）
  ${If} $LANGUAGE == 2052
    FileOpen $9 "$INSTDIR\lang.txt" w
    FileWrite $9 "zh"
    FileClose $9
  ${Else}
    FileOpen $9 "$INSTDIR\lang.txt" w
    FileWrite $9 "en"
    FileClose $9
  ${EndIf}
SectionEnd

;; ---- 快捷方式（两个各自可选） ----
;;
;; 用 Section 而不是自定义复选框：MUI 的 components 页会自动列出它们、记住上次选择，
;; 卸载时也能按「这个段装了什么」来清理。
;;
;; ★ 落在哪儿跟着安装范围走（$MultiUser.InstallMode 由 MultiUser.nsh 定好）：
;;
;;   仅为我安装     →  $SMPROGRAMS / $DESKTOP（当前用户的开始菜单与桌面）
;;   为所有用户安装 →  **所有用户的公共位置**（公共开始菜单 / 公共桌面）
;;
;;   ★ 写法不是 $COMMONPROGRAMS / $COMMONDESKTOP —— 那两个变量在 NSIS 里**根本不存在**
;;     （实测编译期只给 "unknown variable/constant ... detected, ignoring"，然后把它当
;;     字面量拼进路径，装完快捷方式落在了一个叫 "COMMONPROGRAMS" 的目录里，等于没装）。
;;
;;     正确做法是 SetShellVarContext：它把 $SMPROGRAMS / $DESKTOP 的**解析目标**整体切到
;;     公共位置，后续所有用到它们的地方自动跟着走，不需要分别写两套变量名。
;;
;;   为什么不一律用当前用户的位置：管理员装给全机器时，别的用户登录后桌面上什么都没有，
;;   那不是「为所有用户安装」该有的样子。反过来，仅为我安装时**不能**写公共位置 ——
;;   那需要管理员权限，而我们默认免 UAC。
;;
;;   两个 Section 各自 SetShellVarContext 一次：它是运行时状态，而 Section 的选中状态
;;   由用户在 components 页决定，不能指望另一个 Section 先跑过。
Section "开始菜单快捷方式" SecStartMenu
  ${If} $MultiUser.InstallMode == "AllUsers"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\DSH.exe" "" "$INSTDIR\DSH.exe" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  SetShellVarContext current
SectionEnd

Section "桌面快捷方式" SecDesktop
  ${If} $MultiUser.InstallMode == "AllUsers"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\DSH.exe" "" "$INSTDIR\DSH.exe" 0
  SetShellVarContext current
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "启动器本机与随包的运行时、dsh 本体、内置插件（约 1.2 GB）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} "在开始菜单里放一个启动入口和一个卸载入口。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "在桌面放一个启动快捷方式。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

;; ---- 卸载 ----
Section "Uninstall"
  ;; 先把进程停掉：正在跑的 exe 删不掉，留着会弹「文件被占用」。
  ;;
  ;; ★ 只结束「可执行文件出自 $INSTDIR」的进程，绝不按镜像名无差别杀。
  ;;   教训：早先写的是 `taskkill /IM node.exe /F`，结果把用户机器上**所有** node
  ;;   进程都杀了 —— 那里面有他自己的开发服务器、其它项目的构建，以及正在用的
  ;;   dsh 本身。卸载一个程序却弄挂别人一堆活，是绝不能有的行为。
  ;;
  ;;   现在按 ExecutablePath 前缀筛：只有从本安装目录起来的 DSH.exe / node.exe /
  ;;   msedgewebview2.exe 才动。别的 node 进程一个都不碰。
  ;;
  ;;   具体筛选交给随包的 stop-installed.ps1 —— 为什么不用内联 PowerShell：
  ;;   NSIS 会把 `$p`、`$_` 当成它自己的变量展开成空串，把脚本悄悄改坏，
  ;;   而编译期只给 warnings（实测踩到过）。写成文件就绕开了整层转义。
  ;;
  ;;   这里再释放一份到 $PLUGINSDIR，保证「只跑卸载器」也有得用（安装段也放了一份）。
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=stop-installed.ps1" "${STOP_SCRIPT}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-installed.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  DetailPrint "已结束安装目录里的进程（powershell 退出码 $0）"
  Sleep 800

  ;; 快捷方式：**两处都删**（当前用户的 + 所有用户的公共位置）。
  ;;
  ;; 为什么不按 $MultiUser.InstallMode 只删一侧：安装范围可能和当初不一样了 ——
  ;; 用户先「仅为我」装过、后来「为所有用户」又装一次，或者反过来；也可能从别的账户
  ;; 卸载（那时当前用户视图里没有公共项的快照）。Delete / RMDir 对不存在的目标是安全的
  ;; （返回失败但不弹错），所以多删一次没有代价，漏删却会留下死链接。
  ;;
  ;; ★ 用 SetShellVarContext 切两轮，而不是写 $COMMONPROGRAMS / $COMMONDESKTOP ——
  ;;   那两个变量不存在（编译期只报警告、当字面量拼进路径，删的是个假目录）。
  ;;   顺序：先 all（公共），再 current（回到当前用户，避免影响后面的清理）。
  SetShellVarContext all
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  SetShellVarContext current
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$INSTDIR\stop-installed.ps1"
  ;; 程序本体（webview2/ 单独删，它在某些机器上文件多且带只读位）
  RMDir /r "$INSTDIR\webview2"
  RMDir /r "$INSTDIR"

  ;; 同安装段：SHELL_CONTEXT 由 MultiUser 的 un.onInit 按当初的安装范围指向 HKCU 或 HKLM。
  DeleteRegKey SHELL_CONTEXT "${UNINST_KEY}"
  DeleteRegKey SHELL_CONTEXT "Software\${APP_NAME}"

  ;; 用户数据一概不动：配置在 %APPDATA%\DSH，会话在 %DSH_HOME%（默认 ~/.dsh）。
  ;; 卸载程序只删自己装的东西 —— 重装之后接着用。这是一键安装器那一版定下的规矩。
SectionEnd
