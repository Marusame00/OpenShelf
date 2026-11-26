// build/launcher.cs — OpenShelf.exe: a tiny tray launcher for the Node server.
//
// Compiled with the csc.exe that ships with .NET Framework 4.x, so building
// needs no SDK and no npm packages. It starts node.exe next to itself (or on
// PATH), waits for the HTTP port, opens the browser, and offers Open / Stop
// from a notification-area icon. No console window.
//
// Kept to C# 5 syntax on purpose: the in-box compiler is C# 5.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace OpenShelf
{
    internal static class Program
    {
        private const string MutexName = "OpenShelf.Launcher.SingleInstance";
        private const int DefaultPort = 8090;

        private static Process server;
        private static NotifyIcon tray;
        private static string appDir;
        private static int port;
        private static string logPath;

        [STAThread]
        private static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    // Already running: just bring the UI up.
                    OpenBrowser(ReadPort(AppDir()));
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                appDir = AppDir();
                port = ReadPort(appDir);
                logPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "OpenShelf", "logs", "server.log");

                BuildTray();

                if (PortOpen(port))
                {
                    // Something is already serving this port (an older start.bat
                    // window, say). Don't start a second server.
                    OpenBrowser(port);
                    Notify("OpenShelf is already running", "Opened http://localhost:" + port);
                }
                else if (!StartServer())
                {
                    return;
                }

                Application.ApplicationExit += delegate { StopServer(); };
                Application.Run();
            }
        }

        private static string AppDir()
        {
            return Path.GetDirectoryName(Application.ExecutablePath);
        }

        private static void BuildTray()
        {
            tray = new NotifyIcon();
            try
            {
                tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
                tray.Icon = SystemIcons.Application;
            }
            tray.Text = "OpenShelf";
            tray.Visible = true;

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open OpenShelf", null, delegate { OpenBrowser(port); });
            menu.Items.Add("Open app folder", null, delegate { ShellOpen(appDir); });
            menu.Items.Add("Open server log", null, delegate
            {
                if (File.Exists(logPath)) ShellOpen(logPath);
                else MessageBox.Show("No log yet.", "OpenShelf");
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Stop and exit", null, delegate { Application.Exit(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenBrowser(port); };
        }

        private static bool StartServer()
        {
            string node = FindNode();
            if (node == null)
            {
                MessageBox.Show(
                    "node.exe was not found next to OpenShelf.exe or on PATH.\n\n" +
                    "Use the installer, or the portable build (which includes node.exe).",
                    "OpenShelf", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            string serverJs = Path.Combine(appDir, "server.js");
            if (!File.Exists(serverJs))
            {
                MessageBox.Show("server.js is missing from " + appDir, "OpenShelf",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            string configPath = Path.Combine(appDir, "openshelf.config.json");
            string arguments = File.Exists(configPath)
                ? "\"" + serverJs + "\" --config \"" + configPath + "\""
                : "\"" + serverJs + "\"";

            var psi = new ProcessStartInfo(node, arguments);
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(logPath));
                var log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8);
                log.WriteLine("--- " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " start ---");
                log.AutoFlush = true;

                server = new Process();
                server.StartInfo = psi;
                server.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) { lock (log) { log.WriteLine(e.Data); } }
                };
                server.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) { lock (log) { log.WriteLine(e.Data); } }
                };
                server.Start();
                server.BeginOutputReadLine();
                server.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not start the server:\n\n" + ex.Message, "OpenShelf",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            for (int i = 0; i < 100; i++)
            {
                if (server.HasExited)
                {
                    MessageBox.Show(
                        "The server exited immediately. See the log:\n\n" + logPath,
                        "OpenShelf", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return false;
                }
                if (PortOpen(port)) break;
                Thread.Sleep(200);
            }

            OpenBrowser(port);
            Notify("OpenShelf is running", "http://localhost:" + port + " — right-click the tray icon to stop.");
            return true;
        }

        private static string FindNode()
        {
            string local = Path.Combine(appDir, "node.exe");
            if (File.Exists(local)) return local;

            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        private static int ReadPort(string dir)
        {
            try
            {
                string cfg = Path.Combine(dir, "openshelf.config.json");
                if (File.Exists(cfg))
                {
                    Match m = Regex.Match(File.ReadAllText(cfg), "\"port\"\\s*:\\s*(\\d+)");
                    if (m.Success)
                    {
                        int p;
                        if (int.TryParse(m.Groups[1].Value, out p) && p > 0 && p < 65536) return p;
                    }
                }
            }
            catch { }
            return DefaultPort;
        }

        private static bool PortOpen(int p)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var ar = client.BeginConnect("127.0.0.1", p, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                    client.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        private static void OpenBrowser(int p)
        {
            try { Process.Start("http://localhost:" + p + "/"); }
            catch (Exception ex) { MessageBox.Show(ex.Message, "OpenShelf"); }
        }

        private static void ShellOpen(string target)
        {
            try { Process.Start("explorer.exe", "\"" + target + "\""); }
            catch { }
        }

        private static void Notify(string title, string text)
        {
            if (tray == null) return;
            tray.BalloonTipTitle = title;
            tray.BalloonTipText = text;
            tray.ShowBalloonTip(4000);
        }

        private static void StopServer()
        {
            if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
            if (server == null) return;
            try
            {
                if (!server.HasExited)
                {
                    // Kill the tree: node may have spawned PowerShell for thumbnails.
                    var kill = Process.Start(new ProcessStartInfo("taskkill",
                        "/T /F /PID " + server.Id)
                    { UseShellExecute = false, CreateNoWindow = true });
                    kill.WaitForExit(5000);
                }
            }
            catch { }
            try { server.Dispose(); } catch { }
            server = null;
        }
    }
}
