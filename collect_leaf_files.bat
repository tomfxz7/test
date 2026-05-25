@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem このバッチにD&Dされたフォルダ配下の「最下層フォルダ」にあるファイルを
rem このバッチと同じフォルダへコピーします。

set "DEST=%~dp0"

if "%~1"=="" (
    echo フォルダをこのバッチへドラッグ＆ドロップしてください。
    pause
    exit /b 1
)

:ARG_LOOP
if "%~1"=="" goto AFTER_ARGS

if exist "%~1\*" (
    call :PROCESS_ROOT "%~1"
) else (
    echo [SKIP] フォルダではないためスキップ: %~1
)
shift
goto ARG_LOOP

:AFTER_ARGS
echo.
echo 完了しました。
pause
exit /b 0

:PROCESS_ROOT
set "ROOT=%~1"
for /r "%ROOT%" %%D in (.) do (
    set "HAS_SUBDIR=0"
    for /d %%S in ("%%~fD\*") do set "HAS_SUBDIR=1"
    if "!HAS_SUBDIR!"=="0" (
        call :COPY_FILES "%%~fD"
    )
)
exit /b

:COPY_FILES
set "LEAF=%~1"
for %%F in ("%LEAF%\*") do (
    if not exist "%%~fF\" (
        call :COPY_ONE "%%~fF"
    )
)
exit /b

:COPY_ONE
set "SRC=%~1"
set "NAME=%~nx1"
set "TARGET=%DEST%%NAME%"

if not exist "%TARGET%" (
    copy /y "%SRC%" "%TARGET%" >nul
    echo [COPY] %SRC%
    exit /b
)

rem 同名ファイルがある場合は _1, _2 ... を付けて保存
set /a N=1
:RENAME_LOOP
set "BASENAME=%~n1"
set "EXT=%~x1"
set "TARGET=%DEST%%BASENAME%_!N!!EXT!"
if exist "%TARGET%" (
    set /a N+=1
    goto :RENAME_LOOP
)
copy /y "%SRC%" "%TARGET%" >nul
echo [COPY] %SRC% ^> %TARGET%
exit /b
