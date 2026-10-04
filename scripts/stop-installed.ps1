# stop-installed.ps1 — 结束「可执行文件出自指定安装目录」的进程。
#
# 为什么单独一个文件而不是内联在 NSIS 里：NSIS 会把 `$p`、`$_` 当成它自己的变量
# 展开成空串，把 PowerShell 代码悄悄改坏（编译期只给 warnings，运行期才发现）。
# 写成文件就完全绕开这一层。
#
# 为什么按目录筛而不是按镜像名：早先卸载脚本写的是 `taskkill /IM node.exe /F`，
# 那会把用户机器上**所有** node 进程都杀掉 —— 他自己的开发服务器、其它项目的构建、
# 以及正在用的 dsh 全在里面。卸载一个程序不该弄挂别人一堆活。
#
# 参数：安装目录。只有可执行文件路径落在这个目录下的进程才会被结束。
param([Parameter(Mandatory = $true)][string]$InstallDir)

# 尾部反斜杠先去掉再补一个：/D= 或用户手输可能带尾斜杠，不归一化会拼成两个，
# 前缀就永远匹配不上了。
$prefix = $InstallDir.TrimEnd([char]92) + [char]92
Write-Output "只结束可执行文件位于 ${prefix} 下的进程"

$killed = 0
Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($prefix.ToLower())
} | ForEach-Object {
    Write-Output ("  结束 " + $_.Name + " (PID " + $_.ProcessId + ")")
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
}
Write-Output "共结束 $killed 个进程"