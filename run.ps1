#!/usr/bin/env pwsh
# 从源码启动（开发用）
#
# 不再设 $ErrorActionPreference='Stop'：以前一旦 npm 报错，脚本立刻结束、窗口跟着关掉，
# 看起来就像"闪一下什么都没发生"。现在失败会把错误留在窗口里。
Set-Location -LiteralPath $PSScriptRoot
npm start
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "启动失败，退出码 $LASTEXITCODE" -ForegroundColor Red
    Read-Host "按回车关闭"
}
