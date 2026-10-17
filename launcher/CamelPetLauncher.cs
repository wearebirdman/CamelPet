// 骆驼桌宠 启动器
//
// 为什么需要它：
//   1) 某些受限 Windows 环境（被 CodexSandbox 之类的安全策略托管）里，Chromium 的沙箱
//      初始化会被拒绝，进程在 main.js 执行之前就以 0x80000003 崩溃 —— 表现为"双击没反应"。
//      在 JS 里 appendSwitch('no-sandbox') 太晚，必须由命令行传入。
//   2) 受限令牌可能写不进 %APPDATA%，Chromium 会因为建不出锁文件而静默退出。
//
// 所以这里做两件事，且只在必要时才做：
//   * 数据目录：优先 %APPDATA%\骆驼桌宠；不可写时退回程序目录下的 data\（便携模式）
//   * 启动：先按标准方式启动；只有检测到 0x80000003 才降级为 --no-sandbox 重试
//
// 编译成 winexe（GUI 子系统），双击不会闪黑框。

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class CamelPetLauncher
{
    // STATUS_BREAKPOINT：Chromium 沙箱初始化失败时的退出码
    private const int StatusBreakpoint = unchecked((int)0x80000003);

    /// <summary>Medium 完整性的 RID；低于它说明进程被降权了</summary>
    private const int MediumIntegrityRid = 8192;

    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    private static readonly string LogPath = Path.Combine(Root, "launcher.log");
    /// <summary>防止"重新拉起"无限循环的一次性标记</summary>
    private static readonly string RelaunchMarker = Path.Combine(Path.GetTempPath(), "camelpet-relaunch.guard");

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr tokenHandle, int infoClass, IntPtr info, int length, out int returnLength);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>
    /// 取当前进程的完整性级别（RID）。4000=Low，8000=Medium，12000=High。
    /// </summary>
    private static int CurrentIntegrityRid()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /* TOKEN_QUERY */, out token))
        {
            return -1;
        }
        try
        {
            int needed;
            GetTokenInformation(token, 25 /* TokenIntegrityLevel */, IntPtr.Zero, 0, out needed);
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                int written;
                if (!GetTokenInformation(token, 25, buffer, needed, out written))
                {
                    return -1;
                }
                // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes } }
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                byte subAuthorities = Marshal.ReadByte(sid, 1);
                return Marshal.ReadInt32(sid, 8 + (subAuthorities - 1) * 4);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(token);
        }
    }
    /// <summary>
    /// 打印当前进程的完整性级别。
    ///
    /// 这是排查"托盘不出来 / 开机项写不进去 / %APPDATA% 不可写"的第一现场：
    /// Low 完整性（RID 4096）下这三件事全部会被系统拒绝。实测踩过：
    /// 项目目录被沙箱打上 Low 标签后，从这里双击启动的进程也会被降成 Low。
    /// 处理办法是把目录标签改回 Medium：icacls "<目录>" /setintegritylevel Medium /T
    /// </summary>
    private static void LogIntegrity()
    {
        Log("当前完整性 RID=" + CurrentIntegrityRid() + "（4096=Low 8192=Medium）");
    }
    private static int Main(string[] args)
    {
        try
        {
            LogIntegrity();

            string appExe = LocateApp();
            if (appExe == null)
            {
                ShowError("找不到程序文件。\n\n请确认 app\\CamelPet.exe 与本启动器在同一目录下。");
                return 1;
            }

            string dataArgs = ResolveDataDirArgs();

            int code = Launch(appExe, dataArgs, false);
            if (code == StatusBreakpoint)
            {
                Log("首次启动检测到沙箱初始化失败（0x80000003），改用兼容参数重试");
                code = Launch(appExe, dataArgs, true);
            }

            if (code == StatusBreakpoint)
            {
                ShowError("程序启动失败：当前系统禁止了 Chromium 的沙箱初始化。\n\n"
                          + "详细信息已写入：" + LogPath);
                return code;
            }

            return code;
        }
        catch (Exception error)
        {
            Log("启动器异常：" + error);
            ShowError("启动失败：" + error.Message + "\n\n详细信息：" + LogPath);
            return 1;
        }
    }

    /// <summary>按优先级找真正的程序入口。</summary>
    private static string LocateApp()
    {
        string[] candidates =
        {
            // 安装包 / 便携目录：打包后真正的 Electron 入口被重命名为 CamelPetCore.exe，
            // 本启动器占用 CamelPet.exe，这样双击任何入口都会走"自检 + 必要时降级"。
            Path.Combine(Root, "CamelPetCore.exe"),
            Path.Combine(Root, "app", "CamelPet.exe"),
            Path.Combine(Root, "dist", "win-unpacked", "CamelPetCore.exe"),
            Path.Combine(Root, "dist", "win-unpacked", "CamelPet.exe"),
        };
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }
        return null;
    }

    /// <summary>
    /// 决定数据目录：能写 %APPDATA% 就用它（标准做法，卸载重装不丢），
    /// 写不了才退回程序目录下的 data\（受限令牌下的兜底）。
    /// </summary>
    private static string ResolveDataDirArgs()
    {
        // 便携版：electron-builder 会注入 PORTABLE_EXECUTABLE_DIR，
        // 数据存到"便携 exe 所在目录\data"，拷走整个 exe + data 就能带走设置。
        string portableRoot = Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_DIR");
        if (!string.IsNullOrEmpty(portableRoot))
        {
            string besideExe = Path.Combine(portableRoot, "data");
            if (IsWritable(besideExe))
            {
                Log("便携模式，数据目录：" + besideExe);
                return "--user-data-dir=\"" + besideExe + "\" ";
            }
        }

        string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string preferred = Path.Combine(roaming, "骆驼桌宠");
        if (IsWritable(preferred))
        {
            return string.Empty; // 用默认位置，不需要传参
        }

        string portable = Path.Combine(Root, "data");
        try
        {
            Directory.CreateDirectory(portable);
        }
        catch (Exception error)
        {
            Log("创建便携数据目录失败：" + error.Message);
        }
        Log("%APPDATA% 不可写，改用便携数据目录：" + portable);
        return "--user-data-dir=\"" + portable + "\" ";
    }

    private static bool IsWritable(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            string probe = Path.Combine(dir, ".write-test");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 启动程序并观察一小段时间：活下来就算成功（不阻塞），退出则把退出码带回去。
    /// </summary>
    private static int Launch(string appExe, string dataArgs, bool compat)
    {
        // 转发用户传给启动器的参数（Range 语法在 .NET Framework 的 csc 上编译不过）
        string[] provided = Environment.GetCommandLineArgs();
        string forwarded = provided.Length > 1
            ? string.Join(" ", provided, 1, provided.Length - 1)
            : string.Empty;

        string arguments = dataArgs
            + (compat ? "--no-sandbox " : string.Empty)
            + forwarded;

        ProcessStartInfo startInfo = new ProcessStartInfo(appExe, arguments)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(appExe),
        };

        // ELECTRON_RUN_AS_NODE 会让 Electron 退化成纯 Node，直接报 "bad option: --user-data-dir"
        // 并以 9 退出。某些开发终端 / 自动化环境会带这个变量，这里主动剥掉。
        try
        {
            startInfo.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        }
        catch
        {
            // 环境变量表不可用时忽略
        }

        Log((compat ? "兼容启动" : "标准启动") + "：" + appExe + " " + arguments);
        using (Process process = Process.Start(startInfo))
        {
            if (process == null)
            {
                return 1;
            }

            // 3.5 秒足够判断"起不来"，又不会让用户觉得双击后迟迟没反应
            if (process.WaitForExit(3500))
            {
                Log("进程已退出，退出码 " + process.ExitCode);
                return process.ExitCode;
            }
            Log("进程存活，启动成功");

            // 启动成功后**继续等待它退出**，而不是立刻返回。
            // 便携版（electron-builder portable）是个自解压外壳：它等本启动器退出后会清理
            // 临时解包目录——启动器要是先退了，正在运行的程序文件会被连锅端掉。
            // 安装版里这样也无害，只是多一个常驻的小进程（无窗口）。
            process.WaitForExit();
            Log("程序已退出，退出码 " + process.ExitCode);
            return process.ExitCode;
        }
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(
                LogPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine,
                Encoding.UTF8);
        }
        catch
        {
            // 日志写不进去不能影响启动
        }
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "骆驼桌宠", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
