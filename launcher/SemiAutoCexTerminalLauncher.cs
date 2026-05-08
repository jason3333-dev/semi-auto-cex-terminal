using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

internal static class SemiAutoCexTerminalLauncher
{
    private static Process serverProcess;

    private static int Main()
    {
        try
        {
            return Run();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Launcher error: " + ex.GetType().Name + ": " + ex.Message);
            StopServer();
            WaitBeforeExit();
            return 1;
        }
    }

    private static int Run()
    {
        Console.Title = "Semi-Auto CEX Terminal";
        Console.WriteLine("Semi-Auto CEX Terminal launcher");

        string appRoot = ResolveAppRoot();
        if (appRoot == null)
        {
            Console.Error.WriteLine("App root was not found. Keep the app folder next to this exe.");
            WaitBeforeExit();
            return 1;
        }

        string node = ResolveNode(appRoot);
        if (node == null)
        {
            Console.Error.WriteLine("Node.js 20+ was not found. Install Node.js or place node.exe in runtime\\node.exe.");
            WaitBeforeExit();
            return 1;
        }

        string dataDir = ResolveDataDir();
        string sessionEnvPath = EnsureSessionEnv(dataDir, appRoot);
        int port = ReadConfiguredPort(appRoot, sessionEnvPath);
        string url = "http://127.0.0.1:" + port + "/";

        Console.WriteLine("App root: " + appRoot);
        Console.WriteLine("Data dir: " + dataDir);
        LogEnvFileStatus("Base env", Path.Combine(appRoot, ".env"));
        LogEnvFileStatus("Session env", sessionEnvPath);
        Console.WriteLine("Configured port: " + port);

        AppDomain.CurrentDomain.ProcessExit += delegate { StopServer(); };
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs args)
        {
            args.Cancel = true;
            StopServer();
            Environment.Exit(0);
        };

        try
        {
            serverProcess = StartServer(appRoot, node, sessionEnvPath);
            Console.WriteLine("Server process: " + serverProcess.Id);
            Console.WriteLine("Waiting for " + url);

            if (!WaitForServer(url + "api/session", 15000))
            {
                Console.Error.WriteLine("Server did not become ready in time.");
                StopServer();
                WaitBeforeExit();
                return 1;
            }

            Console.WriteLine("Opening browser: " + url);
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            Console.WriteLine("Close this window to stop the local server.");

            serverProcess.WaitForExit();
            return serverProcess.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            StopServer();
            WaitBeforeExit();
            return 1;
        }
    }

    private static string ResolveAppRoot()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string[] candidates = new[]
        {
            Path.Combine(exeDir, "app"),
            exeDir,
            Path.GetFullPath(Path.Combine(exeDir, "..", "app")),
            Path.GetFullPath(Path.Combine(exeDir, "..")),
            Path.Combine(Directory.GetCurrentDirectory(), "app"),
            Directory.GetCurrentDirectory(),
            Path.GetFullPath(Path.Combine(exeDir, "..", ".."))
        };

        foreach (string candidate in candidates)
        {
            if (File.Exists(Path.Combine(candidate, "src", "server.js")))
            {
                return Path.GetFullPath(candidate);
            }
        }

        return null;
    }

    private static string ResolveNode(string appRoot)
    {
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string[] candidates = new[]
        {
            Path.Combine(exeDir, "runtime", "node.exe"),
            Path.Combine(Directory.GetCurrentDirectory(), "runtime", "node.exe"),
            Path.Combine(appRoot, "runtime", "node.exe"),
            Path.Combine(userProfile, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node.exe")
        };

        foreach (string candidate in candidates)
        {
            if (IsUsableNode(candidate)) return candidate;
        }

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            string candidate = Path.Combine(dir.Trim(), "node.exe");
            if (IsUsableNode(candidate)) return candidate;
        }

        return null;
    }

    private static bool IsUsableNode(string path)
    {
        if (!File.Exists(path)) return false;

        try
        {
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = path,
                Arguments = "--version",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using (Process process = Process.Start(info))
            {
                string output = process.StandardOutput.ReadToEnd().Trim();
                process.WaitForExit(3000);
                if (process.ExitCode != 0 || !output.StartsWith("v")) return false;
                string majorText = output.Substring(1).Split('.')[0];
                int major;
                return int.TryParse(majorText, out major) && major >= 20;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void LogEnvFileStatus(string label, string path)
    {
        if (!File.Exists(path))
        {
            Console.WriteLine(label + ": missing (" + Path.GetFileName(path) + ")");
            return;
        }
        Dictionary<string, string> entries = ReadEnvFile(path);
        Console.WriteLine(label + ": detected " + Path.GetFileName(path) + " (" + entries.Count + " keys)");
    }

    private static string ResolveDataDir()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            localAppData = AppDomain.CurrentDomain.BaseDirectory;
        }
        return Path.Combine(localAppData, "SemiAutoCexTerminal");
    }

    private static string EnsureSessionEnv(string dataDir, string appRoot)
    {
        string projectSessionEnvPath = Path.Combine(appRoot, ".env.session");
        if (File.Exists(projectSessionEnvPath)) return projectSessionEnvPath;

        Directory.CreateDirectory(dataDir);
        string sessionEnvPath = Path.Combine(dataDir, ".env.session");
        if (File.Exists(sessionEnvPath)) return sessionEnvPath;

        string examplePath = Path.Combine(appRoot, ".env.session.example");
        if (File.Exists(examplePath))
        {
            File.Copy(examplePath, sessionEnvPath);
        }
        else
        {
            File.WriteAllText(sessionEnvPath, "SESSION_EXCHANGE_ID=mememax-orderly\r\nTRADING_MODE=dry-run\r\n", Encoding.UTF8);
        }
        Console.WriteLine("Created session env template: " + sessionEnvPath);
        return sessionEnvPath;
    }

    private static int ReadConfiguredPort(string appRoot, string sessionEnvPath)
    {
        int port = 8787;
        port = ReadPortFromEntries(ReadEnvFile(Path.Combine(appRoot, ".env")), port);
        port = ReadPortFromEntries(ReadEnvFile(sessionEnvPath), port);
        return port;
    }

    private static int ReadPortFromEntries(Dictionary<string, string> entries, int fallback)
    {
        string value;
        if (!entries.TryGetValue("PORT", out value)) return fallback;
        int port;
        if (int.TryParse(value, out port) && port > 0 && port < 65536) return port;
        return fallback;
    }

    private static Dictionary<string, string> ReadEnvFile(string path)
    {
        Dictionary<string, string> entries = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return entries;

        string[] lines = ReadEnvText(path).Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
        foreach (string rawLine in lines)
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            int equals = line.IndexOf('=');
            if (equals <= 0) continue;
            string key = line.Substring(0, equals).Trim().TrimStart('\uFEFF');
            string value = ParseEnvValue(line.Substring(equals + 1));
            if (key.Length > 0) entries[key] = value;
        }

        return entries;
    }

    private static string ReadEnvText(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        {
            return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        }
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        {
            return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        }
        return Encoding.UTF8.GetString(bytes);
    }

    private static string ParseEnvValue(string value)
    {
        string trimmed = value.Trim();
        if (trimmed.Length >= 2)
        {
            char first = trimmed[0];
            char last = trimmed[trimmed.Length - 1];
            if ((first == '"' && last == '"') || (first == '\'' && last == '\''))
            {
                return trimmed.Substring(1, trimmed.Length - 2);
            }
        }
        return trimmed;
    }

    private static string QuoteArg(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static Process StartServer(string appRoot, string node, string sessionEnvPath)
    {
        ProcessStartInfo info = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "src/server.js --base-env " + QuoteArg(Path.Combine(appRoot, ".env")) + " --session-env " + QuoteArg(sessionEnvPath),
            WorkingDirectory = appRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = false
        };

        Process process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            if (args.Data != null) Console.WriteLine(args.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            if (args.Data != null) Console.Error.WriteLine(args.Data);
        };

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static bool WaitForServer(string url, int timeoutMs)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            if (serverProcess != null && serverProcess.HasExited) return false;

            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 1000;
                request.ReadWriteTimeout = 1000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 500) return true;
                }
            }
            catch
            {
                Thread.Sleep(250);
            }
        }

        return false;
    }

    private static void StopServer()
    {
        try
        {
            if (serverProcess != null && !serverProcess.HasExited)
            {
                Console.WriteLine("Stopping local server...");
                serverProcess.Kill();
                serverProcess.WaitForExit(3000);
            }
        }
        catch
        {
            // Process may already be gone.
        }
    }

    private static void WaitBeforeExit()
    {
        Console.WriteLine("Press Enter to close.");
        Console.ReadLine();
    }
}
