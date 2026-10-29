// 9Router Taskbar Speed & Stream Monitor
// Professional TrafficMonitor-style HUD Widget for Windows 11/10
// High-DPI Aware, Frameless, Pure Win32/GDI+ (Zero external dependencies)

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace NineRouter.TaskbarMonitor
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                SetProcessDPIAware();
            }
            catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            int port = 20128;
            string token = "";

            for (int i = 0; i < args.Length; i++)
            {
                if ((args[i] == "--port" || args[i] == "-p") && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out port);
                }
                else if (args[i] == "--token" && i + 1 < args.Length)
                {
                    token = args[i + 1];
                }
            }

            Application.Run(new MonitorForm(port, token));
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
    }

    public class MonitorForm : Form
    {
        #region Win32 Imports
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 0x2;
        private const int WS_EX_TOOLWINDOW = 0x80;
        private const int WS_EX_TOPMOST = 0x8;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WM_MOUSEACTIVATE = 0x0021;
        private const int MA_NOACTIVATE = 3;
        private const int WM_ERASEBKGND = 0x0014;
        private const int GWL_HWNDPARENT = -8;

        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;

        [DllImport("user32.dll")]
        private static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)]
        private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        private static IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong)
        {
            if (IntPtr.Size == 8)
                return SetWindowLongPtr64(hWnd, nIndex, dwNewLong);
            else
                return new IntPtr(SetWindowLong32(hWnd, nIndex, dwNewLong.ToInt32()));
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
        #endregion

        #region State & Config
        private int _port;
        private string _cliToken;
        private bool _isLocked = false;
        private bool _isTransparent = false;
        private int _colorTheme = 0; // 0: Cyber Cyan, 1: Emerald Green, 2: Amber Gold
        private bool _isConnected = false;
        private bool _isStreaming = false;

        // Model & Metrics
        private string _activeModel = "None";
        private double _lastSpeed = 0.0;
        private int _tokensIn = 0;
        private int _tokensOut = 0;
        private double _cachePct = 0.0;
        private bool _hasUsage = false;
        private bool _hasError = false;
        private string _errorText = "";

        // Static Completion & Stability Tracking
        private bool _isCompleted = false;
        private DateTime _completeTime = DateTime.MinValue;
        private string _lastDurationStr = "";
        private IntPtr _hTaskbar = IntPtr.Zero;
        private IntPtr _lastForeground = IntPtr.Zero;
        private int _idleTicks = 0;
        private int _topmostTicks = 0;

        // Timestamps
        private DateTime _streamStartTime = DateTime.MinValue;
        private float _pulseAnimation = 0f;
        private bool _pulseIncreasing = true;

        private Thread _sseThread;
        private volatile bool _running = true;
        private System.Windows.Forms.Timer _renderTimer;
        private ContextMenuStrip _contextMenu;
        private ToolStripMenuItem _lockMenuItem;
        private ToolStripMenuItem _transMenuItem;

        // Fonts
        private readonly Font _fontLabel;
        private readonly Font _fontValue;
        private readonly Font _fontValueBold;

        // Palette
        private readonly Brush _brushLabel;
        private readonly Brush _brushIdle;
        private readonly Brush _brushOffline;
        private readonly Brush _brushError;
        private readonly Brush _brushTextBright;
        private readonly Brush _brushCache;
        private readonly Pen _borderPen;
        private readonly Brush _bgBrush;
        private readonly Color _transparentKeyColor = Color.FromArgb(18, 18, 20);
        #endregion

        public MonitorForm(int port, string cliToken)
        {
            _port = port;
            _cliToken = !string.IsNullOrEmpty(cliToken) ? cliToken : ResolveCliToken();

            // Form properties: 220px x 58px perfectly balanced for Taskbar height
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.ShowInTaskbar = false;
            this.TopMost = true;
            this.Size = new Size(220, 58);
            this.DoubleBuffered = true;
            this.SetStyle(ControlStyles.AllPaintingInWmPaint |
                          ControlStyles.UserPaint |
                          ControlStyles.OptimizedDoubleBuffer |
                          ControlStyles.ResizeRedraw, true);
            this.UpdateStyles();
            this.BackColor = Color.FromArgb(24, 24, 27); // Zinc-900

            // Crisp Windows 11 typography
            _fontLabel = new Font("Segoe UI", 7.25f, FontStyle.Bold);
            _fontValue = new Font("Segoe UI", 7.75f, FontStyle.Regular);
            _fontValueBold = new Font("Segoe UI", 8.0f, FontStyle.Bold);

            // Brushes
            _brushLabel = new SolidBrush(Color.FromArgb(148, 163, 184)); // Slate-400
            _brushIdle = new SolidBrush(Color.FromArgb(115, 115, 125));   // Dim grey
            _brushOffline = new SolidBrush(Color.FromArgb(249, 115, 22)); // Orange
            _brushError = new SolidBrush(Color.FromArgb(244, 63, 94));    // Red
            _brushTextBright = new SolidBrush(Color.FromArgb(241, 245, 249)); // Bright slate
            _brushCache = new SolidBrush(Color.FromArgb(192, 132, 252));  // Purple-400

            _borderPen = new Pen(Color.FromArgb(45, 45, 54), 1);
            _bgBrush = new SolidBrush(Color.FromArgb(24, 24, 27));

            // Load saved settings & geometry
            LoadSettings();
            ApplyBackgroundMode();

            // Context Menu
            BuildContextMenu();

            // Render loop (20 FPS = 50ms)
            _renderTimer = new System.Windows.Forms.Timer();
            _renderTimer.Interval = 50;
            _renderTimer.Tick += (s, e) => {
                // Periodically ensure TopMost every 1s (and immediately when Taskbar has focus)
                _topmostTicks++;
                if (_topmostTicks >= 20)
                {
                    _topmostTicks = 0;
                    KeepTopMost();
                }
                else
                {
                    IntPtr fg = GetForegroundWindow();
                    if (fg != _lastForeground)
                    {
                        _lastForeground = fg;
                        if (_hTaskbar == IntPtr.Zero) _hTaskbar = FindWindow("Shell_TrayWnd", null);
                        if (fg == _hTaskbar && _hTaskbar != IntPtr.Zero)
                        {
                            KeepTopMost();
                        }
                    }
                }

                // Safety timeout: if request stuck streaming for > 120s without END, reset
                if (_isStreaming && _streamStartTime != DateTime.MinValue)
                {
                    if ((DateTime.Now - _streamStartTime).TotalSeconds > 120)
                    {
                        _isStreaming = false;
                        _isCompleted = false;
                        this.Invalidate();
                    }
                }

                // Invalidate ONLY while streaming to animate seconds & pulse LED!
                if (_isStreaming)
                {
                    if (_pulseIncreasing)
                    {
                        _pulseAnimation += 0.16f;
                        if (_pulseAnimation >= 1.0f) { _pulseAnimation = 1.0f; _pulseIncreasing = false; }
                    }
                    else
                    {
                        _pulseAnimation -= 0.16f;
                        if (_pulseAnimation <= 0.2f) { _pulseAnimation = 0.2f; _pulseIncreasing = true; }
                    }
                    this.Invalidate();
                }
                else
                {
                    _pulseAnimation = 0f;
                    // When static, check once per second for 15s transition to Idle
                    _idleTicks++;
                    if (_idleTicks >= 20)
                    {
                        _idleTicks = 0;
                        if (_isCompleted && (DateTime.Now - _completeTime).TotalSeconds >= 15)
                        {
                            _isCompleted = false;
                            this.Invalidate();
                        }
                    }
                }
            };
            _renderTimer.Start();

            // Start SSE Listener
            StartSseListener();
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            // Do not call base.OnPaintBackground to eliminate background erase flicker
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_MOUSEACTIVATE)
            {
                m.Result = (IntPtr)MA_NOACTIVATE;
                return;
            }
            if (m.Msg == WM_ERASEBKGND)
            {
                m.Result = (IntPtr)1; // Handled
                return;
            }
            base.WndProc(ref m);
        }

        private void KeepTopMost()
        {
            try
            {
                SetWindowPos(this.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            catch { }
        }

        #region CLI Token Resolution
        private string ResolveCliToken()
        {
            try
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                string dataDir = Path.Combine(appData, "9router");

                string machineIdPath = Path.Combine(dataDir, "machine-id");
                string secretPath = Path.Combine(dataDir, "auth", "cli-secret");

                string rawId = File.Exists(machineIdPath) ? File.ReadAllText(machineIdPath).Trim() : "";
                string secret = File.Exists(secretPath) ? File.ReadAllText(secretPath).Trim() : "";

                if (!string.IsNullOrEmpty(rawId) && !string.IsNullOrEmpty(secret))
                {
                    string input = rawId + "9r-cli-auth" + secret;
                    using (SHA256 sha = SHA256.Create())
                    {
                        byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(input));
                        StringBuilder sb = new StringBuilder();
                        foreach (byte b in hash) sb.Append(b.ToString("x2"));
                        return sb.ToString().Substring(0, 16);
                    }
                }
            }
            catch { }

            return "";
        }
        #endregion

        private void ApplyBackgroundMode()
        {
            if (_isTransparent)
            {
                this.BackColor = _transparentKeyColor;
                this.TransparencyKey = _transparentKeyColor;
            }
            else
            {
                this.TransparencyKey = Color.Empty;
                this.BackColor = Color.FromArgb(24, 24, 27);
            }
            this.Invalidate();
        }

        #region Taskbar Snapping
        private void SnapToTaskbar()
        {
            try
            {
                IntPtr hTaskbar = FindWindow("Shell_TrayWnd", null);
                if (hTaskbar != IntPtr.Zero)
                {
                    RECT tbRect;
                    if (GetWindowRect(hTaskbar, out tbRect))
                    {
                        int tbHeight = tbRect.Bottom - tbRect.Top;

                        IntPtr hTray = FindWindowEx(hTaskbar, IntPtr.Zero, "TrayNotifyWnd", null);
                        RECT trayRect = new RECT();
                        bool foundTray = (hTray != IntPtr.Zero && GetWindowRect(hTray, out trayRect));

                        int targetX;
                        int targetY;

                        if (foundTray && trayRect.Left > tbRect.Left)
                        {
                            targetX = trayRect.Left - this.Width - 14;
                            targetY = tbRect.Top + Math.Max(2, (tbHeight - this.Height) / 2);
                        }
                        else
                        {
                            Screen primary = Screen.PrimaryScreen;
                            targetX = primary.WorkingArea.Right - this.Width - 190;
                            targetY = tbRect.Top + Math.Max(2, (tbHeight - this.Height) / 2);
                        }

                        this.Location = new Point(targetX, targetY);
                        KeepTopMost();
                        SaveSettings();
                        return;
                    }
                }

                Screen scr = Screen.PrimaryScreen;
                this.Location = new Point(scr.WorkingArea.Right - this.Width - 170, scr.Bounds.Bottom - this.Height - 6);
                KeepTopMost();
                SaveSettings();
            }
            catch { }
        }
        #endregion

        #region Settings Persistence
        private string GetConfigFilePath()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string dir = Path.Combine(appData, "9router");
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            return Path.Combine(dir, "taskbar_monitor.json");
        }

        private void SaveSettings()
        {
            try
            {
                string path = GetConfigFilePath();
                string json = string.Format("{{\"x\":{0},\"y\":{1},\"locked\":{2},\"transparent\":{3},\"theme\":{4},\"port\":{5}}}",
                    this.Location.X, this.Location.Y, _isLocked.ToString().ToLower(),
                    _isTransparent.ToString().ToLower(), _colorTheme, _port);
                File.WriteAllText(path, json);
            }
            catch { }
        }

        private void LoadSettings()
        {
            try
            {
                string path = GetConfigFilePath();
                if (File.Exists(path))
                {
                    string content = File.ReadAllText(path);
                    Match mX = Regex.Match(content, "\"x\"\\s*:\\s*(-?\\d+)");
                    Match mY = Regex.Match(content, "\"y\"\\s*:\\s*(-?\\d+)");
                    Match mLock = Regex.Match(content, "\"locked\"\\s*:\\s*(true|false)");
                    Match mTrans = Regex.Match(content, "\"transparent\"\\s*:\\s*(true|false)");
                    Match mTheme = Regex.Match(content, "\"theme\"\\s*:\\s*(\\d+)");
                    Match mPort = Regex.Match(content, "\"port\"\\s*:\\s*(\\d+)");

                    if (mPort.Success) int.TryParse(mPort.Groups[1].Value, out _port);
                    if (mLock.Success) _isLocked = (mLock.Groups[1].Value.ToLower() == "true");
                    if (mTrans.Success) _isTransparent = (mTrans.Groups[1].Value.ToLower() == "true");
                    if (mTheme.Success) int.TryParse(mTheme.Groups[1].Value, out _colorTheme);

                    if (mX.Success && mY.Success)
                    {
                        int x = int.Parse(mX.Groups[1].Value);
                        int y = int.Parse(mY.Groups[1].Value);
                        this.Location = new Point(x, y);
                        return;
                    }
                }
            }
            catch { }

            SnapToTaskbar();
        }
        #endregion

        #region Mouse Interaction
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && !_isLocked)
            {
                ReleaseCapture();
                SendMessage(this.Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
                KeepTopMost();
                SaveSettings();
            }
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            if (e.Button == MouseButtons.Left)
            {
                OpenConsoleLog();
            }
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button == MouseButtons.Right)
            {
                _contextMenu.Show(this, e.Location);
            }
        }
        #endregion

        #region Context Menu
        private void BuildContextMenu()
        {
            _contextMenu = new ContextMenuStrip();
            _contextMenu.BackColor = Color.FromArgb(28, 28, 30);
            _contextMenu.ForeColor = Color.FromArgb(244, 244, 245);
            _contextMenu.ShowImageMargin = false;

            var itemConsole = new ToolStripMenuItem("Open Console Log", null, (s, e) => OpenConsoleLog());
            var itemDashboard = new ToolStripMenuItem("Open Dashboard", null, (s, e) => OpenDashboard());
            var itemSnap = new ToolStripMenuItem("Snap to Taskbar", null, (s, e) => SnapToTaskbar());

            _lockMenuItem = new ToolStripMenuItem(_isLocked ? "Unlock Position" : "Lock Position", null, (s, e) => {
                _isLocked = !_isLocked;
                _lockMenuItem.Text = _isLocked ? "Unlock Position" : "Lock Position";
                SaveSettings();
            });

            _transMenuItem = new ToolStripMenuItem(_isTransparent ? "Box Background" : "Transparent Taskbar Mode", null, (s, e) => {
                _isTransparent = !_isTransparent;
                _transMenuItem.Text = _isTransparent ? "Box Background" : "Transparent Taskbar Mode";
                ApplyBackgroundMode();
                SaveSettings();
            });

            var itemTheme = new ToolStripMenuItem("Color Theme");
            var themeCyan = new ToolStripMenuItem("Cyber Cyan", null, (s, e) => SetTheme(0));
            var themeGreen = new ToolStripMenuItem("Emerald Green", null, (s, e) => SetTheme(1));
            var themeAmber = new ToolStripMenuItem("Amber Gold", null, (s, e) => SetTheme(2));
            itemTheme.DropDownItems.AddRange(new ToolStripItem[] { themeCyan, themeGreen, themeAmber });

            var itemReconnect = new ToolStripMenuItem("Reconnect Stream", null, (s, e) => RestartSseListener());
            var itemExit = new ToolStripMenuItem("Exit", null, (s, e) => {
                _running = false;
                this.Close();
            });

            _contextMenu.Items.Add(itemConsole);
            _contextMenu.Items.Add(itemDashboard);
            _contextMenu.Items.Add(new ToolStripSeparator());
            _contextMenu.Items.Add(itemSnap);
            _contextMenu.Items.Add(_lockMenuItem);
            _contextMenu.Items.Add(_transMenuItem);
            _contextMenu.Items.Add(itemTheme);
            _contextMenu.Items.Add(itemReconnect);
            _contextMenu.Items.Add(new ToolStripSeparator());
            _contextMenu.Items.Add(itemExit);
        }

        private void SetTheme(int theme)
        {
            _colorTheme = theme;
            SaveSettings();
            this.Invalidate();
        }

        private void OpenDashboard()
        {
            try { Process.Start(string.Format("http://127.0.0.1:{0}/dashboard", _port)); } catch { }
        }

        private void OpenConsoleLog()
        {
            try { Process.Start(string.Format("http://127.0.0.1:{0}/dashboard/console-log", _port)); } catch { }
        }
        #endregion

        #region SSE Listener
        private void StartSseListener()
        {
            _running = true;
            _sseThread = new Thread(SseWorkerLoop)
            {
                IsBackground = true,
                Name = "9Router_SSE_Client"
            };
            _sseThread.Start();
        }

        private void RestartSseListener()
        {
            try
            {
                _running = false;
                if (_sseThread != null && _sseThread.IsAlive) _sseThread.Abort();
            }
            catch { }

            if (string.IsNullOrEmpty(_cliToken)) _cliToken = ResolveCliToken();
            _running = true;
            StartSseListener();
        }

        private void SseWorkerLoop()
        {
            while (_running)
            {
                HttpWebRequest request = null;
                HttpWebResponse response = null;
                Stream stream = null;
                StreamReader reader = null;

                try
                {
                    if (string.IsNullOrEmpty(_cliToken))
                    {
                        _cliToken = ResolveCliToken();
                    }

                    string url = string.Format("http://127.0.0.1:{0}/api/translator/console-logs/stream", _port);
                    request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "GET";
                    request.Accept = "text/event-stream";
                    request.KeepAlive = true;
                    request.Timeout = 8000;
                    request.ReadWriteTimeout = 300000;

                    if (!string.IsNullOrEmpty(_cliToken))
                    {
                        request.Headers.Add("x-9r-cli-token", _cliToken);
                    }

                    response = (HttpWebResponse)request.GetResponse();

                    if ((int)response.StatusCode == 200)
                    {
                        stream = response.GetResponseStream();
                        reader = new StreamReader(stream, Encoding.UTF8);

                        _isConnected = true;

                        while (_running && !reader.EndOfStream)
                        {
                            string line = reader.ReadLine();
                            if (string.IsNullOrEmpty(line)) continue;

                            if (line.StartsWith("data: "))
                            {
                                string json = line.Substring(6).Trim();
                                ProcessLogPayload(json);
                            }
                        }
                    }
                    else
                    {
                        _isConnected = false;
                    }
                }
                catch
                {
                    _isConnected = false;
                }
                finally
                {
                    if (reader != null) try { reader.Close(); } catch { }
                    if (stream != null) try { stream.Close(); } catch { }
                    if (response != null) try { response.Close(); } catch { }
                }

                if (_running) Thread.Sleep(2000);
            }
        }

        private void ProcessLogPayload(string json)
        {
            try
            {
                if (json.Contains("\"type\":\"line\""))
                {
                    Match mLine = Regex.Match(json, "\"line\"\\s*:\\s*\"(.*?)\"(?:,|\\})");
                    if (mLine.Success)
                    {
                        string raw = Regex.Unescape(mLine.Groups[1].Value);
                        HandleLogLine(raw);
                    }
                }
                else if (json.Contains("\"type\":\"lines\""))
                {
                    MatchCollection matches = Regex.Matches(json, "\"(.*?)\"");
                    foreach (Match m in matches)
                    {
                        string val = Regex.Unescape(m.Groups[1].Value);
                        if (!val.Contains("lines") && !val.Contains("type"))
                        {
                            HandleLogLine(val);
                        }
                    }
                }
                else if (json.Contains("\"type\":\"init\""))
                {
                    // Scan latest usage from init logs if present
                    Match mUsage = Regex.Match(json, @"in=(\d+).*?out=(\d+).*?cache_read=(\d+).*?\(([\d.]+)%\)");
                    if (mUsage.Success)
                    {
                        _tokensIn = int.Parse(mUsage.Groups[1].Value);
                        _tokensOut = int.Parse(mUsage.Groups[2].Value);
                        double.TryParse(mUsage.Groups[4].Value, out _cachePct);
                        _hasUsage = true;
                    }
                }
            }
            catch { }
        }

        private void HandleLogLine(string text)
        {
            if (string.IsNullOrEmpty(text)) return;

            // Filter out system background jobs (token refresh, tunnels, etc.)
            // Only process Chat / Streaming request transactions matching Table View
            if (text.Contains("[TOKEN_REFRESH]") || text.Contains("[TUNNEL]") || text.Contains("[AUTOSTART]") || text.Contains("proactive checkpoint"))
            {
                return;
            }

            bool stateChanged = false;

            // 1. Detect Request Start (Pending / Streaming)
            // Log patterns:
            // - [PENDING] START | provider=antigravity | model=gemini-3.8-flash-medium
            // - ▶ POST agy → antigravity/gemini-3.8-flash-medium
            // - 📥 POST ...
            // NOTE: Must NOT match completion summary lines like "POST /v1/chat/completions 200 OK 4300ms"
            bool isExplicitStart = text.Contains("[PENDING] START") || text.Contains("▶ POST") || text.Contains("📥 POST");
            bool isGenericPostStart = (text.Contains("POST /") || text.Contains("GET /")) 
                && !text.Contains("200") && !text.Contains("400") && !text.Contains("401") && !text.Contains("403") && !text.Contains("429") && !text.Contains("500") && !text.Contains("502") && !text.Contains("503");

            if (isExplicitStart || isGenericPostStart)
            {
                _isStreaming = true;
                _isCompleted = false;
                _hasError = false;
                _streamStartTime = DateTime.Now;
                stateChanged = true;

                // Extract Model:
                // Pattern a: model=([a-z0-9._/-]+)
                Match mParam = Regex.Match(text, @"\bmodel=([a-z0-9._/-]+)", RegexOptions.IgnoreCase);
                if (mParam.Success)
                {
                    _activeModel = CleanModelName(mParam.Groups[1].Value);
                }
                else
                {
                    // Pattern b: → antigravity/gemini-3.8-flash-medium
                    Match mRoute = Regex.Match(text, @"→\s*([a-z0-9._/-]+)", RegexOptions.IgnoreCase);
                    if (mRoute.Success && !Regex.IsMatch(mRoute.Groups[1].Value, @"^\d+$"))
                    {
                        _activeModel = CleanModelName(mRoute.Groups[1].Value);
                    }
                    else
                    {
                        Match mFallback = Regex.Match(text, @"(?:POST|GET)\s+[^\s|]+\s*\|\s*([a-z0-9._/-]+)", RegexOptions.IgnoreCase);
                        if (mFallback.Success)
                        {
                            _activeModel = CleanModelName(mFallback.Groups[1].Value);
                        }
                    }
                }
            }

            // 2. Stream chunk activity (Mid-stream chunks only, NOT complete/aborted)
            if ((text.Contains("🌊") || text.Contains("[STREAM]")) && !text.Contains("complete") && !text.Contains("aborted"))
            {
                Match streamModel = Regex.Match(text, @"\[STREAM\]\s+[a-z0-9_-]+\s*\|\s*([a-z0-9._/-]+)", RegexOptions.IgnoreCase);
                if (streamModel.Success)
                {
                    _activeModel = CleanModelName(streamModel.Groups[1].Value);
                    stateChanged = true;
                }
            }

            // 3. Token Count & Usage: in=273715 | out=1150 | account=... | cache_read=271354 (99.14%)
            Match usageFull = Regex.Match(text, @"in=(\d+)(?:\s+\|\s+out=(\d+))?(?:.*?cache_read=(\d+)\s*\(([\d.]+)%\))?", RegexOptions.IgnoreCase);
            if (usageFull.Success && usageFull.Groups[1].Success)
            {
                _tokensIn = int.Parse(usageFull.Groups[1].Value);
                if (usageFull.Groups[2].Success && !string.IsNullOrEmpty(usageFull.Groups[2].Value))
                {
                    _tokensOut = int.Parse(usageFull.Groups[2].Value);
                }
                if (usageFull.Groups[4].Success && !string.IsNullOrEmpty(usageFull.Groups[4].Value))
                {
                    double.TryParse(usageFull.Groups[4].Value, out _cachePct);
                }
                _hasUsage = true;
                _hasError = false;
                // Final tokens reported: mark stream completed immediately
                _isStreaming = false;
                _isCompleted = true;
                _completeTime = DateTime.Now;
                stateChanged = true;
            }

            // 4. Stream Completion or Request End
            // Log patterns:
            // - [PENDING] END | provider=antigravity | model=...
            // - [STREAM] ... | 14209ms | complete
            // - [TTFT] ... total=11976 | ttft=4121
            // - POST /v1/... | 200 OK | 4300ms
            bool isEnd = text.Contains("[PENDING] END") || 
                         text.Contains("| complete") || 
                         (text.Contains("complete") && text.Contains("[STREAM]")) ||
                         text.Contains("[TTFT]") ||
                         text.Contains("200 OK") || 
                         text.Contains(" 200 ") || 
                         text.Contains("ResponseAborted") || 
                         text.Contains("disconnect");

            if (isEnd)
            {
                _isStreaming = false;
                _isCompleted = true;
                _completeTime = DateTime.Now;
                _hasError = false; // Normal completion
                stateChanged = true;

                // Duration parse from total=NNN or NNNms
                Match ttftTotal = Regex.Match(text, @"total=(\d+)", RegexOptions.IgnoreCase);
                Match durationMatch = Regex.Match(text, @"\|\s*(\d+)ms", RegexOptions.IgnoreCase);

                if (ttftTotal.Success)
                {
                    double ms = double.Parse(ttftTotal.Groups[1].Value);
                    _lastDurationStr = string.Format("{0:0.#}s", ms / 1000.0);
                }
                else if (durationMatch.Success)
                {
                    double ms = double.Parse(durationMatch.Groups[1].Value);
                    _lastDurationStr = string.Format("{0:0.#}s", ms / 1000.0);
                    if (_tokensOut > 0 && ms > 50)
                    {
                        _lastSpeed = (_tokensOut / (ms / 1000.0));
                    }
                }
                else if (_streamStartTime != DateTime.MinValue)
                {
                    double sec = Math.Max(0.1, (DateTime.Now - _streamStartTime).TotalSeconds);
                    _lastDurationStr = string.Format("{0:0.#}s", sec);
                }
                else if (string.IsNullOrEmpty(_lastDurationStr))
                {
                    _lastDurationStr = "done";
                }
            }

            // 5. In-Stream Request Errors only (429, 500, stream failure)
            if (_isStreaming && (text.Contains(" 429 ") || text.Contains(" 500 ") || text.Contains("rate_limit") || text.Contains("quota_exceeded")))
            {
                _hasError = true;
                _isStreaming = false;
                _isCompleted = false;
                if (text.Contains("429") || text.Contains("rate_limit")) _errorText = "429 Rate Limit";
                else if (text.Contains("500")) _errorText = "500 Server Err";
                else _errorText = "Stream Error";
                stateChanged = true;
            }

            if (stateChanged && this.IsHandleCreated)
            {
                try { this.BeginInvoke(new Action(() => this.Invalidate())); } catch { }
            }
        }

        private string CleanModelName(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return "None";
            string name = raw;
            int slash = name.LastIndexOf('/');
            if (slash >= 0 && slash < name.Length - 1) name = name.Substring(slash + 1);
            name = name.Replace("-preview", "").Replace("-turbo", "");
            if (name.Length > 24) name = name.Substring(0, 23) + "…";
            return name;
        }

        private string FormatTokenCount(int count)
        {
            if (count >= 1000000) return string.Format("{0:0.#}M", count / 1000000.0);
            if (count >= 1000) return string.Format("{0:0.#}k", count / 1000.0);
            return count.ToString();
        }
        #endregion

        #region TrafficMonitor 3-Row GDI+ Rendering
        private Color GetPrimaryThemeColor()
        {
            switch (_colorTheme)
            {
                case 1: return Color.FromArgb(16, 185, 129);  // Emerald Green
                case 2: return Color.FromArgb(245, 158, 11);  // Amber Gold
                case 0:
                default: return Color.FromArgb(56, 189, 248); // Cyber Sky Blue
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            int w = this.Width;
            int h = this.Height;

            // 1. Background
            if (!_isTransparent)
            {
                using (GraphicsPath path = CreateRoundedRectanglePath(new Rectangle(0, 0, w - 1, h - 1), 6))
                {
                    g.FillPath(_bgBrush, path);
                    g.DrawPath(_borderPen, path);
                }
            }
            else
            {
                g.Clear(_transparentKeyColor);
            }

            // Layout coordinates for 3 distinct rows: perfect balance for 58px height
            float labelX = 8f;
            float valueX = 48f; // Safe gap from "MOD"
            float row1Y = 4f;   // Row 1: TOK in/out (cache%)
            float row2Y = 21f;  // Row 2: STA (Streaming Xs / Idle speed)
            float row3Y = 38f;  // Row 3: MOD (model name)

            Color themeColor = GetPrimaryThemeColor();

            // Labels column
            g.DrawString("TOK", _fontLabel, _brushLabel, new PointF(labelX, row1Y));
            g.DrawString("STA", _fontLabel, _brushLabel, new PointF(labelX, row2Y));
            g.DrawString("MOD", _fontLabel, _brushLabel, new PointF(labelX, row3Y));

            // --- Row 1: Token in / out (cache%) ---
            string tokText;
            if (_hasUsage)
            {
                string inStr = FormatTokenCount(_tokensIn);
                string outStr = FormatTokenCount(_tokensOut);
                tokText = string.Format("{0} / {1} ({2:0.#}%)", inStr, outStr, _cachePct);
            }
            else
            {
                tokText = "0 / 0";
            }
            g.DrawString(tokText, _fontValueBold, _cachePct > 0 ? _brushCache : _brushTextBright, new PointF(valueX, row1Y));

            // --- Row 2: Status & Speed ---
            if (!_isConnected)
            {
                g.DrawString("Offline (Connecting)", _fontValueBold, _brushOffline, new PointF(valueX, row2Y));
            }
            else if (_hasError)
            {
                g.DrawString(_errorText, _fontValueBold, _brushError, new PointF(valueX, row2Y));
            }
            else if (_isStreaming)
            {
                // Live streaming elapsed timer: integer seconds
                int elapsedSec = 0;
                if (_streamStartTime != DateTime.MinValue)
                {
                    elapsedSec = (int)Math.Max(0, (DateTime.Now - _streamStartTime).TotalSeconds);
                }

                string streamStr = string.Format("Streaming • {0}s", elapsedSec);
                using (Brush streamBrush = new SolidBrush(themeColor))
                {
                    g.DrawString(streamStr, _fontValueBold, streamBrush, new PointF(valueX, row2Y));
                }
            }
            else if (_isCompleted && (DateTime.Now - _completeTime).TotalSeconds < 15)
            {
                // Hold completed state statically between requests (matching Table View 200 OK)
                string doneStr = string.Format("200 OK • {0}", !string.IsNullOrEmpty(_lastDurationStr) ? _lastDurationStr : "done");
                using (Brush doneBrush = new SolidBrush(Color.FromArgb(52, 211, 153))) // Emerald-400
                {
                    g.DrawString(doneStr, _fontValueBold, doneBrush, new PointF(valueX, row2Y));
                }
            }
            else
            {
                // Clean Idle state
                g.DrawString("Idle", _fontValueBold, _brushIdle, new PointF(valueX, row2Y));
            }

            // --- Row 3: Model Name (Always bright white to eliminate visual flicker) ---
            g.DrawString(_activeModel, _fontValue, _brushTextBright, new PointF(valueX, row3Y));

            // --- LED Indicator (Right aligned) ---
            float ledX = w - 14;
            float ledY = 7f;
            float ledSize = 6f;

            Color ledColor;
            if (!_isConnected)
            {
                ledColor = Color.FromArgb(249, 115, 22); // Orange offline
            }
            else if (_hasError)
            {
                ledColor = Color.FromArgb(239, 68, 68); // Red error
            }
            else if (_isStreaming)
            {
                ledColor = themeColor;
                // Outer glow pulse
                int alpha = (int)(130 * _pulseAnimation);
                using (Brush glowBrush = new SolidBrush(Color.FromArgb(alpha, themeColor)))
                {
                    g.FillEllipse(glowBrush, ledX - 3.5f, ledY - 3.5f, ledSize + 7, ledSize + 7);
                }
            }
            else if (_isCompleted && (DateTime.Now - _completeTime).TotalSeconds < 15)
            {
                ledColor = Color.FromArgb(16, 185, 129); // Steady bright green for 200 OK
            }
            else
            {
                ledColor = Color.FromArgb(75, 85, 99); // Dim grey idle
            }

            using (Brush ledBrush = new SolidBrush(ledColor))
            {
                g.FillEllipse(ledBrush, ledX, ledY, ledSize, ledSize);
            }

            // Bottom activity line when streaming
            if (_isStreaming)
            {
                using (Pen streamLinePen = new Pen(themeColor, 2f))
                {
                    g.DrawLine(streamLinePen, 10, h - 2, w - 10, h - 2);
                }
            }
        }

        private GraphicsPath CreateRoundedRectanglePath(Rectangle rect, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
        #endregion

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _running = false;
            try
            {
                if (_sseThread != null && _sseThread.IsAlive) _sseThread.Abort();
            }
            catch { }

            base.OnFormClosing(e);
        }
    }
}
