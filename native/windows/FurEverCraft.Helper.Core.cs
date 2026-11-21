// FurEverCraft Windows helper core.
//
// This file is loaded *in process* by Windows PowerShell 5.1 / .NET Framework 4.8 through
// Add-Type.  It intentionally sticks to C# 5 syntax and to assemblies that ship with the
// .NET Framework 4.8 (System.Web.Extensions for JavaScriptSerializer, System.Drawing for
// window capture).  There is no System.Text.Json and no .NET 8 dependency.
//
// Threading model:
//   * stdin is read by an independent reader thread, so a blocked ReadLine can never stop
//     the safety machinery;
//   * an independent watchdog thread checks a Stopwatch every ~10ms and releases every
//     held key/button when the heartbeat or the short input pulse expires;
//   * request dispatch, owner/held-set/epoch updates and the real SendInput sink all share
//     one short state lock, so the watchdog can always interleave safely.
//
// stdout is serialized JSONL only.  stderr is bounded, sanitized diagnostics.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace FurEverCraft.Helper
{
    internal sealed class HelperException : Exception
    {
        public readonly string Code;
        public HelperException(string code) : base(code) { this.Code = code; }
        public HelperException(string code, string message) : base(message) { this.Code = code; }
    }

    internal sealed class HelperOptions
    {
        // The heartbeat timeout is capped at 500ms and the input pulse TTL at 150ms.  These
        // are local safety ceilings, not tuning hints: a late/old deadline can never be
        // promoted into a fresh one.
        public int WatchdogIntervalMs = 10;
        public int HeartbeatTimeoutMs = 500;
        public int PulseTtlMs = 150;
        public int DedupCapacity = 4096;
        public int DedupTtlMs = 600000;
        public int MaxJsonBytes = 64 * 1024;
        public int MaxTextBatchUnits = 16;
        public int MaxTextUnits = 65536;

        public static HelperOptions FromEnvironment()
        {
            HelperOptions options = new HelperOptions();
            options.HeartbeatTimeoutMs = Clamp(ReadInt("FUREVERCRAFT_HELPER_HEARTBEAT_MS", 500), 50, 500);
            options.PulseTtlMs = Clamp(ReadInt("FUREVERCRAFT_HELPER_PULSE_TTL_MS", 150), 1, 150);
            options.DedupCapacity = Clamp(ReadInt("FUREVERCRAFT_HELPER_DEDUP_CAPACITY", 4096), 1, 4096);
            options.DedupTtlMs = Clamp(ReadInt("FUREVERCRAFT_HELPER_DEDUP_TTL_MS", 600000), 1, 600000);
            return options;
        }

        private static int ReadInt(string name, int fallback)
        {
            string value = Environment.GetEnvironmentVariable(name);
            int parsed;
            if (!string.IsNullOrEmpty(value) && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
            return fallback;
        }

        public static int Clamp(int value, int min, int max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }
    }

    internal interface IInputSink
    {
        int SendInputCalls { get; }
        void KeyDown(ushort code, bool scanCode, bool extended);
        void KeyUp(ushort code, bool scanCode, bool extended);
        void MouseMove(int dx, int dy);
        void MouseDown(string button);
        void MouseUp(string button);
        void TextUnit(char unit);
        string Capture(long hwnd);
    }

    /// <summary>Fake OS sink used by -DryRun.  It never touches user32 and counts calls.</summary>
    internal sealed class DryRunInputSink : IInputSink
    {
        public long KeyDowns;
        public long KeyUps;
        public long TextUnits;
        public long MouseMoves;
        public long MouseDowns;
        public long MouseUps;
        public int SendInputCalls { get { return 0; } }
        public void KeyDown(ushort code, bool scanCode, bool extended) { this.KeyDowns += 1; }
        public void KeyUp(ushort code, bool scanCode, bool extended) { this.KeyUps += 1; }
        public void MouseMove(int dx, int dy) { this.MouseMoves += 1; }
        public void MouseDown(string button) { this.MouseDowns += 1; }
        public void MouseUp(string button) { this.MouseUps += 1; }
        public void TextUnit(char unit) { this.TextUnits += 1; }
        public string Capture(long hwnd) { return string.Empty; }
    }

    /// <summary>Real SendInput sink. Only constructed when -DryRun is absent.</summary>
    internal sealed class SendInputSink : IInputSink
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public uint type; public InputUnion U; }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public MOUSEINPUT mi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, INPUT[] inputs, int size);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        private const uint INPUT_KEYBOARD = 1;
        private const uint INPUT_MOUSE = 0;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;
        private const uint KEYEVENTF_SCANCODE = 0x0008;
        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;

        private int sendInputCalls;
        public int SendInputCalls { get { return this.sendInputCalls; } }

        private void Send(INPUT input)
        {
            this.sendInputCalls += 1;
            INPUT[] inputs = new INPUT[] { input };
            if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) throw new HelperException("sendinput-failed");
        }

        public void KeyDown(ushort code, bool scanCode, bool extended)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            if (scanCode) { input.U.ki.wScan = code; input.U.ki.dwFlags = KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0); }
            else { input.U.ki.wVk = code; }
            this.Send(input);
        }

        public void KeyUp(ushort code, bool scanCode, bool extended)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            if (scanCode) { input.U.ki.wScan = code; input.U.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP | (extended ? KEYEVENTF_EXTENDEDKEY : 0); }
            else { input.U.ki.wVk = code; input.U.ki.dwFlags = KEYEVENTF_KEYUP; }
            this.Send(input);
        }

        public void MouseMove(int dx, int dy)
        {
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.U.mi.dx = dx;
            input.U.mi.dy = dy;
            input.U.mi.dwFlags = MOUSEEVENTF_MOVE;
            this.Send(input);
        }

        public void MouseDown(string button)
        {
            uint flag;
            if (button == "left") flag = MOUSEEVENTF_LEFTDOWN;
            else if (button == "right") flag = MOUSEEVENTF_RIGHTDOWN;
            else if (button == "middle") flag = MOUSEEVENTF_MIDDLEDOWN;
            else throw new HelperException("invalid-mouse-button");
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.U.mi.dwFlags = flag;
            this.Send(input);
        }

        public void MouseUp(string button)
        {
            uint flag;
            if (button == "left") flag = MOUSEEVENTF_LEFTUP;
            else if (button == "right") flag = MOUSEEVENTF_RIGHTUP;
            else if (button == "middle") flag = MOUSEEVENTF_MIDDLEUP;
            else throw new HelperException("invalid-mouse-button");
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.U.mi.dwFlags = flag;
            this.Send(input);
        }

        public void TextUnit(char unit)
        {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki.wScan = unit;
            down.U.ki.dwFlags = KEYEVENTF_UNICODE;
            this.Send(down);
            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.U.ki.wScan = unit;
            up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            this.Send(up);
        }

        public string Capture(long hwnd)
        {
            IntPtr handle = new IntPtr(hwnd);
            RECT rect;
            if (!GetWindowRect(handle, out rect)) throw new HelperException("capture-window-rect-unavailable");
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) throw new HelperException("capture-window-rect-unavailable");
            using (Bitmap bitmap = new Bitmap(width, height))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, bitmap.Size);
                using (MemoryStream stream = new MemoryStream())
                {
                    bitmap.Save(stream, ImageFormat.Png);
                    return Convert.ToBase64String(stream.ToArray());
                }
            }
        }

        public static IntPtr ForegroundWindow() { return GetForegroundWindow(); }
        public static uint WindowPid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
        public static bool WindowExists(IntPtr hwnd) { return IsWindow(hwnd); }
        public static bool WindowVisible(IntPtr hwnd) { return IsWindowVisible(hwnd); }
    }

    internal sealed class DedupEntry
    {
        public string PayloadHash;
        public Dictionary<string, object> Receipt;
        public long Sequence;
        public long StoredAtWall;
    }

    internal sealed class Host
    {
        private readonly object stateLock = new object();
        private readonly object outputLock = new object();
        private readonly object stderrLock = new object();
        private readonly HelperOptions options;
        private readonly bool dryRun;
        private readonly IInputSink sink;
        private readonly JavaScriptSerializer serializer;
        private readonly Stopwatch monotonic = Stopwatch.StartNew();
        private readonly ConcurrentQueue<string> inbound = new ConcurrentQueue<string>();
        private readonly AutoResetEvent inboundSignal = new AutoResetEvent(false);
        private readonly Dictionary<string, bool> held = new Dictionary<string, bool>(StringComparer.Ordinal);
        private readonly Dictionary<string, DedupEntry> dedup = new Dictionary<string, DedupEntry>(StringComparer.Ordinal);
        private readonly string helperEpoch = Guid.NewGuid().ToString("N");
        private Thread readerThread;
        private Thread watchdogThread;
        private volatile bool eof;
        private volatile bool stopped;
        private bool stopAfterResponse;
        private long sequenceNumber;
        private long heartbeatDeadlineMono = long.MaxValue;
        private long pulseDeadlineMono = long.MaxValue;
        private bool heartbeatArmed;
        private bool heartbeatExpired;
        private long releasedCount;
        private long heartbeatExpirations;
        private string epoch = string.Empty;
        private long generation = -1;
        private long highWater;
        private bool bound;
        private long boundPid;
        private string boundHwnd = string.Empty;
        private bool fakeFocused = true;
        private bool fakeVisible = true;

        public Host(bool dryRun, HelperOptions options)
        {
            this.dryRun = dryRun;
            this.options = options;
            this.sink = dryRun ? (IInputSink)new DryRunInputSink() : new SendInputSink();
            this.serializer = new JavaScriptSerializer();
            this.serializer.MaxJsonLength = options.MaxJsonBytes;
            this.serializer.RecursionLimit = 32;
        }

        public int Run()
        {
            this.readerThread = new Thread(this.ReadStdinLoop);
            this.readerThread.IsBackground = true;
            this.readerThread.Name = "furevercraft-helper-stdin";
            this.watchdogThread = new Thread(this.WatchdogLoop);
            this.watchdogThread.IsBackground = true;
            this.watchdogThread.Name = "furevercraft-helper-watchdog";
            this.readerThread.Start();
            this.watchdogThread.Start();
            while (!this.stopped)
            {
                this.inboundSignal.WaitOne(20);
                string line;
                while (this.inbound.TryDequeue(out line))
                {
                    this.ProcessLine(line);
                    if (this.stopped) break;
                }
                if (this.eof && this.inbound.IsEmpty) break;
            }
            lock (this.stateLock) { this.ReleaseAllLocked("helper-exit"); }
            return 0;
        }

        private void ReadStdinLoop()
        {
            try
            {
                while (!this.stopped)
                {
                    string line = Console.In.ReadLine();
                    if (line == null) break;
                    if (line.Length > this.options.MaxJsonBytes)
                    {
                        this.WriteResponse(null, false, null, "line-too-large", null);
                        continue;
                    }
                    this.inbound.Enqueue(line);
                    this.inboundSignal.Set();
                }
            }
            catch (Exception error)
            {
                this.Diagnostic("stdin-reader-failed:" + error.GetType().Name);
            }
            finally
            {
                this.eof = true;
                this.inboundSignal.Set();
            }
        }

        private void WatchdogLoop()
        {
            while (!this.stopped)
            {
                try
                {
                    lock (this.stateLock)
                    {
                        long now = this.monotonic.ElapsedMilliseconds;
                        if (this.heartbeatArmed && now >= this.heartbeatDeadlineMono)
                        {
                            if (!this.heartbeatExpired)
                            {
                                this.heartbeatExpired = true;
                                this.heartbeatExpirations += 1;
                                this.ReleaseAllLocked("heartbeat-expired");
                            }
                        }
                        if (this.held.Count > 0 && now >= this.pulseDeadlineMono)
                        {
                            this.ReleaseAllLocked("pulse-expired");
                        }
                    }
                }
                catch (Exception error)
                {
                    this.Diagnostic("watchdog-failed:" + error.GetType().Name);
                }
                Thread.Sleep(this.options.WatchdogIntervalMs);
            }
        }

        private void ProcessLine(string line)
        {
            string requestId = null;
            try
            {
                Dictionary<string, object> request = this.serializer.Deserialize<Dictionary<string, object>>(line);
                if (request == null) throw new HelperException("invalid-json");
                requestId = ReadString(request, "requestId", null);
                if (string.IsNullOrEmpty(requestId)) throw new HelperException("requestId-required");
                if (requestId.Length > 256 || ContainsControl(requestId)) throw new HelperException("invalid-requestId");
                string command = ReadString(request, "command", null);
                if (string.IsNullOrEmpty(command)) throw new HelperException("command-required");
                if (command.Length > 64 || ContainsControl(command)) throw new HelperException("invalid-command");
                Dictionary<string, object> result = this.Dispatch(command, request);
                this.WriteResponse(requestId, true, result, null, null);
            }
            catch (HelperException error)
            {
                this.WriteResponse(requestId, false, null, error.Code, error.Code);
            }
            catch (Exception error)
            {
                this.Diagnostic("request-failed:" + error.GetType().Name);
                this.WriteResponse(requestId, false, null, "internal-error", "internal-error");
            }
            if (this.stopAfterResponse) this.stopped = true;
        }

        private Dictionary<string, object> Dispatch(string command, Dictionary<string, object> request)
        {
            switch (command)
            {
                case "probe": return this.Probe();
                case "getState": return this.GetState();
                case "configure": return this.Configure(request);
                case "bindWindow": return this.BindWindow(request);
                case "getWindowState": return this.GetWindowState();
                case "heartbeat": return this.Heartbeat();
                case "releaseOwnedInputs": return this.ReleaseOwnedInputs();
                case "shutdown": return this.Shutdown();
                case "setHeldInputs": return this.SetHeldInputs(request);
                case "moveRelative": return this.MoveRelative(request);
                case "click": return this.Click(request);
                case "typeText": return this.TypeText(request);
                case "captureWindow": return this.CaptureWindow();
                case "setFocus": return this.SetFocus(request);
                default: throw new HelperException("unknown-command");
            }
        }

        private Dictionary<string, object> Probe()
        {
            lock (this.stateLock)
            {
                Dictionary<string, object> result = this.CountersLocked();
                result["supported"] = true;
                result["dryRun"] = this.dryRun;
                result["platform"] = "windows";
                result["inputBackend"] = this.dryRun ? "dry-run" : "SendInput";
                result["captureBackend"] = this.dryRun ? "dry-run" : "OS-window-capture";
                result["heartbeatTimeoutMs"] = this.options.HeartbeatTimeoutMs;
                result["pulseTtlMs"] = this.options.PulseTtlMs;
                result["helperEpoch"] = this.helperEpoch;
                return result;
            }
        }

        private Dictionary<string, object> GetState()
        {
            lock (this.stateLock)
            {
                Dictionary<string, object> state = this.CountersLocked();
                state["bound"] = this.bound;
                state["pid"] = this.boundPid;
                state["hwnd"] = this.boundHwnd;
                state["focused"] = this.dryRun ? this.fakeFocused : this.IsFocusedLocked();
                state["visible"] = this.dryRun ? this.fakeVisible : this.IsVisibleLocked();
                state["commandSequenceHighWater"] = this.highWater;
                state["heartbeatArmed"] = this.heartbeatArmed;
                state["heartbeatExpired"] = this.heartbeatExpired;
                state["heartbeatExpirations"] = this.heartbeatExpirations;
                state["dryRun"] = this.dryRun;
                state["helperEpoch"] = this.helperEpoch;
                state["options"] = this.OptionsLocked();
                return state;
            }
        }

        private Dictionary<string, object> Configure(Dictionary<string, object> request)
        {
            lock (this.stateLock)
            {
                if (Has(request, "heartbeatTimeoutMs")) this.options.HeartbeatTimeoutMs = HelperOptions.Clamp(ReadInt(request, "heartbeatTimeoutMs", this.options.HeartbeatTimeoutMs), 50, 500);
                if (Has(request, "pulseTtlMs")) this.options.PulseTtlMs = HelperOptions.Clamp(ReadInt(request, "pulseTtlMs", this.options.PulseTtlMs), 1, 150);
                if (Has(request, "dedupCapacity")) this.options.DedupCapacity = HelperOptions.Clamp(ReadInt(request, "dedupCapacity", this.options.DedupCapacity), 1, 4096);
                if (Has(request, "dedupTtlMs")) this.options.DedupTtlMs = HelperOptions.Clamp(ReadInt(request, "dedupTtlMs", this.options.DedupTtlMs), 1, 600000);
                Dictionary<string, object> result = this.CountersLocked();
                result["options"] = this.OptionsLocked();
                result["accepted"] = true;
                return result;
            }
        }

        private Dictionary<string, object> BindWindow(Dictionary<string, object> request)
        {
            long pid = ReadLong(request, "pid", 0);
            string hwnd = ReadString(request, "hwnd", null);
            if (pid <= 0) throw new HelperException("window-identity-required");
            if (string.IsNullOrEmpty(hwnd) || hwnd.Length > 32 || ContainsControl(hwnd)) throw new HelperException("window-identity-required");
            string requestedEpoch = ReadString(request, "epoch", null);

            long handle = 0;
            if (!this.dryRun)
            {
                long parsed;
                if (!long.TryParse(hwnd, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) throw new HelperException("window-identity-required");
                handle = parsed;
                IntPtr candidate = new IntPtr(handle);
                if (!SendInputSink.WindowExists(candidate)) throw new HelperException("window-not-found");
                if (SendInputSink.WindowPid(candidate) != (uint)pid) throw new HelperException("window-pid-mismatch");
            }

            lock (this.stateLock)
            {
                this.ReleaseAllLocked("bind");
                this.bound = true;
                this.boundPid = pid;
                this.boundHwnd = hwnd;
                this.epoch = requestedEpoch == null ? this.epoch : requestedEpoch;
                this.generation = -1;
                this.highWater = 0;
                this.sequenceNumber = 0;
                this.dedup.Clear();
                this.heartbeatArmed = true;
                this.heartbeatExpired = false;
                this.heartbeatDeadlineMono = this.monotonic.ElapsedMilliseconds + this.options.HeartbeatTimeoutMs;
                this.pulseDeadlineMono = long.MaxValue;
                this.fakeFocused = true;
                this.fakeVisible = true;
                Dictionary<string, object> result = this.CountersLocked();
                result["bound"] = true;
                result["pid"] = this.boundPid;
                result["hwnd"] = this.boundHwnd;
                result["epoch"] = this.epoch;
                result["helperEpoch"] = this.helperEpoch;
                result["dryRun"] = this.dryRun;
                return result;
            }
        }

        private Dictionary<string, object> GetWindowState()
        {
            lock (this.stateLock)
            {
                if (!this.bound) throw new HelperException("window-not-bound");
                bool exists = true;
                bool focused;
                bool visible;
                long pid = this.boundPid;
                if (this.dryRun)
                {
                    focused = this.fakeFocused;
                    visible = this.fakeVisible;
                }
                else
                {
                    IntPtr handle = new IntPtr(long.Parse(this.boundHwnd, CultureInfo.InvariantCulture));
                    exists = SendInputSink.WindowExists(handle) && SendInputSink.WindowPid(handle) == (uint)this.boundPid;
                    focused = exists && SendInputSink.ForegroundWindow() == handle;
                    visible = exists && SendInputSink.WindowVisible(handle);
                }
                if (!focused) this.ReleaseAllLocked("focus-lost");
                Dictionary<string, object> result = this.CountersLocked();
                result["exists"] = exists;
                result["focused"] = focused;
                result["visible"] = visible;
                result["pid"] = pid;
                result["hwnd"] = this.boundHwnd;
                return result;
            }
        }

        private Dictionary<string, object> Heartbeat()
        {
            lock (this.stateLock)
            {
                this.heartbeatArmed = true;
                this.heartbeatExpired = false;
                this.heartbeatDeadlineMono = this.monotonic.ElapsedMilliseconds + this.options.HeartbeatTimeoutMs;
                Dictionary<string, object> result = this.CountersLocked();
                result["alive"] = true;
                result["epoch"] = this.epoch;
                return result;
            }
        }

        private Dictionary<string, object> ReleaseOwnedInputs()
        {
            lock (this.stateLock)
            {
                this.ReleaseAllLocked("release-requested");
                Dictionary<string, object> result = this.CountersLocked();
                result["released"] = true;
                return result;
            }
        }

        private Dictionary<string, object> Shutdown()
        {
            lock (this.stateLock)
            {
                this.ReleaseAllLocked("shutdown");
                this.bound = false;
                this.pulseDeadlineMono = long.MaxValue;
                this.stopAfterResponse = true;
                Dictionary<string, object> result = this.CountersLocked();
                result["stopped"] = true;
                return result;
            }
        }

        private Dictionary<string, object> SetHeldInputs(Dictionary<string, object> request)
        {
            long leaseUntil = ReadLease(request);
            long requestedGeneration = ReadGeneration(request);
            long sequence = ReadSequence(request);
            HashSet<string> target = ReadHeldTarget(request);
            int pulseTtl = HelperOptions.Clamp(ReadInt(request, "pulseTtlMs", this.options.PulseTtlMs), 1, 150);

            lock (this.stateLock)
            {
                this.PrepareEpochLocked(request);
                // An empty replacement is an emergency release: it is allowed even when the
                // lease/focus/owner preconditions are no longer satisfactory.
                if (target.Count == 0)
                {
                    this.ReleaseAllLocked("empty-held-set");
                    if (sequence > this.highWater) this.highWater = sequence;
                    Dictionary<string, object> releaseResult = this.CountersLocked();
                    releaseResult["accepted"] = true;
                    releaseResult["generation"] = this.generation;
                    releaseResult["commandSequence"] = sequence;
                    return releaseResult;
                }
                this.CheckActionLocked(leaseUntil, requestedGeneration, sequence);
                this.CommitSequenceLocked(sequence);
                this.ApplyHeldSetLocked(target, pulseTtl, leaseUntil);
                Dictionary<string, object> result = this.CountersLocked();
                result["accepted"] = true;
                result["generation"] = this.generation;
                result["commandSequence"] = sequence;
                return result;
            }
        }

        private Dictionary<string, object> MoveRelative(Dictionary<string, object> request)
        {
            string commandId = RequireCommandId(request);
            long leaseUntil = ReadLease(request);
            long requestedGeneration = ReadGeneration(request);
            long sequence = ReadSequence(request);
            int dx = ReadInt(request, "dx", int.MinValue);
            int dy = ReadInt(request, "dy", int.MinValue);
            if (dx == int.MinValue || dy == int.MinValue || Math.Abs((long)dx) > 4096 || Math.Abs((long)dy) > 4096) throw new HelperException("invalid-input");
            string payloadHash = PayloadHash("moveRelative", request);

            lock (this.stateLock)
            {
                this.PrepareEpochLocked(request);
                Dictionary<string, object> duplicate;
                if (this.TryDuplicateLocked(commandId, payloadHash, out duplicate)) return duplicate;
                this.CheckActionLocked(leaseUntil, requestedGeneration, sequence);
                this.CommitSequenceLocked(sequence);
                this.sink.MouseMove(dx, dy);
                Dictionary<string, object> result = this.CountersLocked();
                result["accepted"] = true;
                result["commandId"] = commandId;
                result["commandSequence"] = sequence;
                this.StoreReceiptLocked(commandId, payloadHash, sequence, result);
                return result;
            }
        }

        private Dictionary<string, object> Click(Dictionary<string, object> request)
        {
            string commandId = RequireCommandId(request);
            long leaseUntil = ReadLease(request);
            long requestedGeneration = ReadGeneration(request);
            long sequence = ReadSequence(request);
            string button = ReadString(request, "button", null);
            if (button != "left" && button != "right" && button != "middle") throw new HelperException("invalid-mouse-button");
            string payloadHash = PayloadHash("click", request);

            lock (this.stateLock)
            {
                this.PrepareEpochLocked(request);
                Dictionary<string, object> duplicate;
                if (this.TryDuplicateLocked(commandId, payloadHash, out duplicate)) return duplicate;
                this.CheckActionLocked(leaseUntil, requestedGeneration, sequence);
                this.CommitSequenceLocked(sequence);
                this.sink.MouseDown(button);
                this.sink.MouseUp(button);
                Dictionary<string, object> result = this.CountersLocked();
                result["accepted"] = true;
                result["commandId"] = commandId;
                result["commandSequence"] = sequence;
                this.StoreReceiptLocked(commandId, payloadHash, sequence, result);
                return result;
            }
        }

        /// <summary>
        /// Text is split into batches of at most 16 UTF-16 code units without splitting a
        /// surrogate pair.  Focus/owner/generation/lease are revalidated before every batch.
        /// A change stops the run and returns a structured partial/ambiguous receipt; the
        /// remaining text is never sent.
        /// </summary>
        private Dictionary<string, object> TypeText(Dictionary<string, object> request)
        {
            string commandId = RequireCommandId(request);
            long leaseUntil = ReadLease(request);
            long requestedGeneration = ReadGeneration(request);
            long sequence = ReadSequence(request);
            string text = ReadString(request, "text", null);
            if (text == null) throw new HelperException("text-required");
            if (text.Length > this.options.MaxTextUnits) throw new HelperException("text-too-long");
            if (text.IndexOf('\0') >= 0) throw new HelperException("invalid-text");
            long focusFlipAfter = ReadLong(request, "focusFlipAfterChars", -1);
            string payloadHash = PayloadHash("typeText", request);
            List<string> batches = BuildTextBatches(text, this.options.MaxTextBatchUnits);

            lock (this.stateLock)
            {
                this.PrepareEpochLocked(request);
                Dictionary<string, object> duplicate;
                if (this.TryDuplicateLocked(commandId, payloadHash, out duplicate)) return duplicate;
                this.CheckActionLocked(leaseUntil, requestedGeneration, sequence);
                this.CommitSequenceLocked(sequence);

                int sentUnits = 0;
                int sentBatches = 0;
                if (this.dryRun && focusFlipAfter == 0) this.fakeFocused = false;
                for (int index = 0; index < batches.Count; index++)
                {
                    string reason = this.TextPreconditionFailureLocked(leaseUntil, requestedGeneration);
                    if (reason != null)
                    {
                        if (sentUnits == 0) throw new HelperException(reason);
                        if (reason == "window-not-focused") this.ReleaseAllLocked("focus-changed");
                        Dictionary<string, object> partial = this.CountersLocked();
                        partial["accepted"] = false;
                        partial["partial"] = true;
                        partial["ambiguous"] = true;
                        partial["status"] = "partial";
                        partial["reason"] = reason;
                        partial["commandId"] = commandId;
                        partial["commandSequence"] = sequence;
                        partial["sentUnits"] = sentUnits;
                        partial["remainingUnits"] = text.Length - sentUnits;
                        partial["sentBatches"] = sentBatches;
                        this.StoreReceiptLocked(commandId, payloadHash, sequence, partial);
                        return partial;
                    }
                    string batch = batches[index];
                    for (int unit = 0; unit < batch.Length; unit++) this.sink.TextUnit(batch[unit]);
                    sentUnits += batch.Length;
                    sentBatches += 1;
                    if (this.dryRun && focusFlipAfter >= 0 && sentUnits >= focusFlipAfter) this.fakeFocused = false;
                }
                Dictionary<string, object> result = this.CountersLocked();
                result["accepted"] = true;
                result["partial"] = false;
                result["ambiguous"] = false;
                result["status"] = "sent";
                result["commandId"] = commandId;
                result["commandSequence"] = sequence;
                result["sentUnits"] = sentUnits;
                result["remainingUnits"] = 0;
                result["sentBatches"] = sentBatches;
                this.StoreReceiptLocked(commandId, payloadHash, sequence, result);
                return result;
            }
        }

        private Dictionary<string, object> CaptureWindow()
        {
            lock (this.stateLock)
            {
                if (!this.bound) throw new HelperException("window-not-found");
                if (this.dryRun)
                {
                    Dictionary<string, object> result = this.CountersLocked();
                    result["accepted"] = true;
                    result["synthetic"] = true;
                    result["limitation"] = "dry-run";
                    result["source"] = "fixture";
                    return result;
                }
                IntPtr handle = new IntPtr(long.Parse(this.boundHwnd, CultureInfo.InvariantCulture));
                if (!SendInputSink.WindowExists(handle)) throw new HelperException("window-not-found");
                if (!SendInputSink.WindowVisible(handle)) throw new HelperException("capture-limited-window-not-visible");
                if (SendInputSink.WindowPid(handle) != (uint)this.boundPid) throw new HelperException("window-pid-mismatch");
                if (!this.dryRun && SendInputSink.ForegroundWindow() != handle)
                {
                    this.ReleaseAllLocked("focus-lost");
                    throw new HelperException("window-not-focused");
                }
                string image = this.sink.Capture(this.boundHwndAsLong());
                if (image.Length > 48 * 1024) throw new HelperException("capture-too-large");
                Dictionary<string, object> result = this.CountersLocked();
                result["accepted"] = true;
                result["synthetic"] = false;
                result["source"] = "os-window-capture";
                result["imageBase64"] = image;
                result["limitation"] = "OS window capture is not original game framebuffer";
                return result;
            }
        }

        private Dictionary<string, object> SetFocus(Dictionary<string, object> request)
        {
            if (!this.dryRun) throw new HelperException("dry-run-only");
            lock (this.stateLock)
            {
                bool focused = ReadBool(request, "focused", false);
                this.fakeFocused = focused;
                if (Has(request, "visible")) this.fakeVisible = ReadBool(request, "visible", this.fakeVisible);
                if (!focused) this.ReleaseAllLocked("focus-injected");
                Dictionary<string, object> result = this.CountersLocked();
                result["focused"] = this.fakeFocused;
                result["visible"] = this.fakeVisible;
                return result;
            }
        }

        private long boundHwndAsLong()
        {
            long value;
            if (!long.TryParse(this.boundHwnd, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) throw new HelperException("window-identity-required");
            return value;
        }

        private void PrepareEpochLocked(Dictionary<string, object> request)
        {
            string requested = ReadString(request, "epoch", null);
            if (requested == null || requested == this.epoch) return;
            // A new epoch invalidates held input, dedup entries and the sequence high-water.
            this.ReleaseAllLocked("epoch-change");
            this.epoch = requested;
            this.generation = -1;
            this.highWater = 0;
            this.sequenceNumber = 0;
            this.dedup.Clear();
        }

        private void CheckActionLocked(long leaseUntil, long requestedGeneration, long sequence)
        {
            if (!this.bound) throw new HelperException("window-not-bound");
            if (!this.dryRun && !this.IsIdentityValidLocked()) throw new HelperException("window-not-found");
            if (!this.IsFocusedLocked())
            {
                this.ReleaseAllLocked("focus-lost");
                throw new HelperException("window-not-focused");
            }
            if (requestedGeneration < this.generation) throw new HelperException("stale-generation");
            if (requestedGeneration > this.generation)
            {
                this.ReleaseAllLocked("generation-change");
                this.generation = requestedGeneration;
            }
            if (!this.heartbeatArmed || this.heartbeatExpired || this.monotonic.ElapsedMilliseconds >= this.heartbeatDeadlineMono)
            {
                if (!this.heartbeatExpired) this.heartbeatExpirations += 1;
                this.heartbeatExpired = true;
                this.ReleaseAllLocked("heartbeat-expired");
                throw new HelperException("heartbeat-expired");
            }
            if (sessionNow() >= leaseUntil)
            {
                this.ReleaseAllLocked("input-expired");
                throw new HelperException("input-expired");
            }
            if (sequence <= this.highWater) throw new HelperException("stale-command-sequence");
        }

        private string TextPreconditionFailureLocked(long leaseUntil, long requestedGeneration)
        {
            if (!this.bound) return "window-not-bound";
            if (!this.dryRun && !this.IsIdentityValidLocked()) return "window-not-found";
            if (!this.IsFocusedLocked()) return "window-not-focused";
            if (requestedGeneration != this.generation) return "stale-generation";
            if (!this.heartbeatArmed || this.heartbeatExpired || this.monotonic.ElapsedMilliseconds >= this.heartbeatDeadlineMono) return "heartbeat-expired";
            if (sessionNow() >= leaseUntil) return "input-expired";
            return null;
        }

        private void ApplyHeldSetLocked(HashSet<string> target, int pulseTtl, long leaseUntil)
        {
            List<string> release = new List<string>();
            foreach (string key in this.held.Keys) if (!target.Contains(key)) release.Add(key);
            List<string> press = new List<string>();
            foreach (string key in target) if (!this.held.ContainsKey(key)) press.Add(key);
            release.Sort(StringComparer.Ordinal);
            press.Sort(StringComparer.Ordinal);
            try
            {
                // Full replacement: release the diff first, then press.  An empty set is a
                // complete release of every key/button owned by this helper.
                for (int index = 0; index < release.Count; index++)
                {
                    this.ApplyKeyLocked(release[index], false);
                    this.held.Remove(release[index]);
                    this.releasedCount += 1;
                }
                for (int index = 0; index < press.Count; index++)
                {
                    this.ApplyKeyLocked(press[index], true);
                    this.held[press[index]] = true;
                }
            }
            catch (HelperException)
            {
                this.ReleaseAllLocked("sendinput-failure");
                throw;
            }
            if (this.held.Count == 0) this.pulseDeadlineMono = long.MaxValue;
            else
            {
                long wallRemaining = leaseUntil - sessionNow();
                long ttl = Math.Min((long)pulseTtl, Math.Max(0L, wallRemaining));
                this.pulseDeadlineMono = this.monotonic.ElapsedMilliseconds + ttl;
            }
        }

        private void ReleaseAllLocked(string reason)
        {
            if (this.held.Count > 0)
            {
                List<string> keys = new List<string>(this.held.Keys);
                keys.Sort(StringComparer.Ordinal);
                for (int index = 0; index < keys.Count; index++)
                {
                    try { this.ApplyKeyLocked(keys[index], false); }
                    catch (HelperException error) { this.Diagnostic("release-failed:" + error.Code + ":" + reason); }
                    this.releasedCount += 1;
                }
                this.held.Clear();
            }
            this.pulseDeadlineMono = long.MaxValue;
        }

        private void ApplyKeyLocked(string key, bool down)
        {
            if (key.StartsWith("mouse:", StringComparison.Ordinal))
            {
                string button = key.Substring(6);
                if (down) this.sink.MouseDown(button); else this.sink.MouseUp(button);
                return;
            }
            if (key.StartsWith("scan:", StringComparison.Ordinal))
            {
                string rest = key.Substring(5);
                bool extended = rest.EndsWith(":ext", StringComparison.Ordinal);
                if (extended) rest = rest.Substring(0, rest.Length - 4);
                ushort scan;
                if (!ushort.TryParse(rest, NumberStyles.Integer, CultureInfo.InvariantCulture, out scan)) throw new HelperException("invalid-held-input");
                if (down) this.sink.KeyDown(scan, true, extended); else this.sink.KeyUp(scan, true, extended);
                return;
            }
            int vk;
            if (!int.TryParse(key, NumberStyles.Integer, CultureInfo.InvariantCulture, out vk) || vk < 0 || vk > 255) throw new HelperException("invalid-held-input");
            if (down) this.sink.KeyDown((ushort)vk, false, false); else this.sink.KeyUp((ushort)vk, false, false);
        }

        private HashSet<string> ReadHeldTarget(Dictionary<string, object> request)
        {
            object raw;
            if (!request.TryGetValue("inputs", out raw) || raw == null) throw new HelperException("inputs-required");
            Dictionary<string, object> inputs = raw as Dictionary<string, object>;
            if (inputs == null) throw new HelperException("invalid-held-input");
            if (inputs.Count > 64) throw new HelperException("invalid-held-input");
            HashSet<string> target = new HashSet<string>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object> entry in inputs)
            {
                string key = entry.Key;
                if (string.IsNullOrEmpty(key) || key.Length > 32 || ContainsControl(key)) throw new HelperException("invalid-held-input");
                bool value = entry.Value is bool && (bool)entry.Value;
                ValidateHeldKey(key);
                if (value) target.Add(key);
            }
            return target;
        }

        private static void ValidateHeldKey(string key)
        {
            if (key.StartsWith("mouse:", StringComparison.Ordinal))
            {
                string button = key.Substring(6);
                if (button != "left" && button != "right" && button != "middle") throw new HelperException("invalid-held-input");
                return;
            }
            if (key.StartsWith("scan:", StringComparison.Ordinal))
            {
                string rest = key.Substring(5);
                if (rest.EndsWith(":ext", StringComparison.Ordinal)) rest = rest.Substring(0, rest.Length - 4);
                ushort scan;
                if (!ushort.TryParse(rest, NumberStyles.Integer, CultureInfo.InvariantCulture, out scan)) throw new HelperException("invalid-held-input");
                return;
            }
            int vk;
            if (!int.TryParse(key, NumberStyles.Integer, CultureInfo.InvariantCulture, out vk) || vk < 0 || vk > 255) throw new HelperException("invalid-held-input");
        }

        private bool TryDuplicateLocked(string commandId, string payloadHash, out Dictionary<string, object> result)
        {
            result = null;
            DedupEntry entry;
            if (!this.dedup.TryGetValue(commandId, out entry)) return false;
            if (sessionNow() - entry.StoredAtWall > this.options.DedupTtlMs)
            {
                this.dedup.Remove(commandId);
                return false;
            }
            if (!string.Equals(entry.PayloadHash, payloadHash, StringComparison.Ordinal)) throw new HelperException("duplicate-command-payload-mismatch");
            result = new Dictionary<string, object>(entry.Receipt);
            result["duplicate"] = true;
            return true;
        }

        private void CommitSequenceLocked(long sequence)
        {
            if (sequence > this.highWater) this.highWater = sequence;
        }

        private void StoreReceiptLocked(string commandId, string payloadHash, long sequence, Dictionary<string, object> receipt)
        {
            DedupEntry entry = new DedupEntry();
            entry.PayloadHash = payloadHash;
            entry.Receipt = new Dictionary<string, object>(receipt);
            entry.Sequence = sequence;
            entry.StoredAtWall = sessionNow();
            this.dedup[commandId] = entry;
            // Bounded cache: first drop entries past the TTL, then evict the oldest entries
            // until the capacity is respected.  Scanning at most 4096 entries keeps the
            // bookkeeping bounded without a second unbounded index.
            long cutoff = sessionNow() - this.options.DedupTtlMs;
            List<string> expired = new List<string>();
            foreach (KeyValuePair<string, DedupEntry> pair in this.dedup)
            {
                if (pair.Value.StoredAtWall < cutoff) expired.Add(pair.Key);
            }
            for (int index = 0; index < expired.Count; index++) this.dedup.Remove(expired[index]);
            while (this.dedup.Count > this.options.DedupCapacity)
            {
                string oldestKey = null;
                long oldestAt = long.MaxValue;
                foreach (KeyValuePair<string, DedupEntry> pair in this.dedup)
                {
                    if (pair.Value.StoredAtWall < oldestAt) { oldestAt = pair.Value.StoredAtWall; oldestKey = pair.Key; }
                }
                if (oldestKey == null) break;
                this.dedup.Remove(oldestKey);
            }
        }

        private Dictionary<string, object> CountersLocked()
        {
            Dictionary<string, object> counters = new Dictionary<string, object>();
            counters["heldCount"] = this.held.Count;
            counters["releasedCount"] = this.releasedCount;
            counters["sendInputCalls"] = this.sink.SendInputCalls;
            counters["dedupCount"] = this.dedup.Count;
            counters["epoch"] = this.epoch;
            counters["generation"] = this.generation;
            return counters;
        }

        private Dictionary<string, object> OptionsLocked()
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["watchdogIntervalMs"] = this.options.WatchdogIntervalMs;
            result["heartbeatTimeoutMs"] = this.options.HeartbeatTimeoutMs;
            result["pulseTtlMs"] = this.options.PulseTtlMs;
            result["dedupCapacity"] = this.options.DedupCapacity;
            result["dedupTtlMs"] = this.options.DedupTtlMs;
            result["maxJsonBytes"] = this.options.MaxJsonBytes;
            result["maxTextBatchUnits"] = this.options.MaxTextBatchUnits;
            return result;
        }

        private bool IsFocusedLocked()
        {
            if (!this.bound) return false;
            if (this.dryRun) return this.fakeFocused;
            IntPtr handle = new IntPtr(this.boundHwndAsLong());
            return SendInputSink.WindowExists(handle) && SendInputSink.WindowPid(handle) == (uint)this.boundPid && SendInputSink.ForegroundWindow() == handle;
        }

        private bool IsVisibleLocked()
        {
            if (!this.bound) return false;
            if (this.dryRun) return this.fakeVisible;
            IntPtr handle = new IntPtr(this.boundHwndAsLong());
            return SendInputSink.WindowExists(handle) && SendInputSink.WindowVisible(handle);
        }

        private bool IsIdentityValidLocked()
        {
            if (!this.bound) return false;
            if (this.dryRun) return true;
            IntPtr handle = new IntPtr(this.boundHwndAsLong());
            return SendInputSink.WindowExists(handle) && SendInputSink.WindowPid(handle) == (uint)this.boundPid;
        }

        private void WriteResponse(string requestId, bool ok, Dictionary<string, object> result, string error, string errorCode)
        {
            Dictionary<string, object> response = new Dictionary<string, object>();
            response["requestId"] = requestId;
            response["ok"] = ok;
            if (result != null) response["result"] = result;
            if (error != null) response["error"] = error;
            if (errorCode != null) response["errorCode"] = errorCode;
            string json;
            try
            {
                json = this.serializer.Serialize(response);
            }
            catch (Exception)
            {
                json = "{\"requestId\":null,\"ok\":false,\"error\":\"response-serialization-failed\",\"errorCode\":\"response-serialization-failed\"}";
            }
            lock (this.outputLock)
            {
                try
                {
                    Console.Out.WriteLine(json);
                    Console.Out.Flush();
                }
                catch (Exception) { }
            }
        }

        private void Diagnostic(string message)
        {
            string sanitized = Sanitize(message);
            lock (this.stderrLock)
            {
                try { Console.Error.WriteLine("helper-diagnostic: " + sanitized); } catch (Exception) { }
            }
        }

        private static string Sanitize(string value)
        {
            if (value == null) return string.Empty;
            StringBuilder builder = new StringBuilder();
            for (int index = 0; index < value.Length && builder.Length < 512; index++)
            {
                char character = value[index];
                builder.Append(char.IsControl(character) ? ' ' : character);
            }
            return builder.ToString();
        }

        private static bool ContainsControl(string value)
        {
            for (int index = 0; index < value.Length; index++) if (char.IsControl(value[index])) return true;
            return false;
        }

        private static long sessionNow() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }

        private static bool Has(Dictionary<string, object> request, string key) { return request.ContainsKey(key) && request[key] != null; }

        private static string ReadString(Dictionary<string, object> request, string key, string fallback)
        {
            object value;
            if (!request.TryGetValue(key, out value) || value == null) return fallback;
            string text = value as string;
            return text == null ? fallback : text;
        }

        private static long ReadLong(Dictionary<string, object> request, string key, long fallback)
        {
            object value;
            if (!request.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new HelperException("invalid-number:" + key); }
        }

        private static int ReadInt(Dictionary<string, object> request, string key, int fallback)
        {
            object value;
            if (!request.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new HelperException("invalid-number:" + key); }
        }

        private static bool ReadBool(Dictionary<string, object> request, string key, bool fallback)
        {
            object value;
            if (!request.TryGetValue(key, out value) || value == null) return fallback;
            if (value is bool) return (bool)value;
            return fallback;
        }

        private long ReadLease(Dictionary<string, object> request)
        {
            object value;
            if (!request.TryGetValue("leaseUntil", out value) || value == null) throw new HelperException("leaseUntil-required");
            long lease;
            try { lease = Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new HelperException("invalid-lease"); }
            if (lease <= 0) throw new HelperException("invalid-lease");
            return lease;
        }

        private long ReadGeneration(Dictionary<string, object> request)
        {
            object value;
            if (!request.TryGetValue("generation", out value) || value == null) return 0;
            long generation;
            try { generation = Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new HelperException("invalid-generation"); }
            if (generation < 0) throw new HelperException("invalid-generation");
            return generation;
        }

        private long ReadSequence(Dictionary<string, object> request)
        {
            object value;
            if (!request.TryGetValue("commandSeq", out value) || value == null) throw new HelperException("commandSeq-required");
            long sequence;
            try { sequence = Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new HelperException("invalid-commandSeq"); }
            if (sequence <= 0) throw new HelperException("invalid-commandSeq");
            return sequence;
        }

        private static string RequireCommandId(Dictionary<string, object> request)
        {
            string commandId = ReadString(request, "commandId", null);
            if (string.IsNullOrEmpty(commandId) || commandId.Length > 256 || ContainsControl(commandId)) throw new HelperException("commandId-required");
            return commandId;
        }

        private static List<string> BuildTextBatches(string text, int maxUnits)
        {
            List<string> batches = new List<string>();
            int index = 0;
            while (index < text.Length)
            {
                StringBuilder batch = new StringBuilder();
                while (index < text.Length)
                {
                    char character = text[index];
                    int width = 1;
                    if (char.IsHighSurrogate(character) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1])) width = 2;
                    if (batch.Length + width > maxUnits) break;
                    batch.Append(character);
                    if (width == 2) batch.Append(text[index + 1]);
                    index += width;
                }
                if (batch.Length == 0) { batch.Append(text[index]); index += 1; }
                batches.Add(batch.ToString());
            }
            return batches;
        }

        private static string PayloadHash(string command, Dictionary<string, object> request)
        {
            StringBuilder canonical = new StringBuilder();
            canonical.Append(command);
            AppendCanonical(canonical, request, "epoch");
            AppendCanonical(canonical, request, "generation");
            AppendCanonical(canonical, request, "leaseUntil");
            AppendCanonical(canonical, request, "commandId");
            AppendCanonical(canonical, request, "commandSeq");
            AppendCanonical(canonical, request, "dx");
            AppendCanonical(canonical, request, "dy");
            AppendCanonical(canonical, request, "button");
            AppendCanonical(canonical, request, "text");
            AppendCanonical(canonical, request, "pulseTtlMs");
            object raw;
            if (request.TryGetValue("inputs", out raw) && raw != null)
            {
                Dictionary<string, object> inputs = raw as Dictionary<string, object>;
                if (inputs != null)
                {
                    List<string> keys = new List<string>(inputs.Keys);
                    keys.Sort(StringComparer.Ordinal);
                    for (int index = 0; index < keys.Count; index++)
                    {
                        canonical.Append("|inputs|");
                        canonical.Append(keys[index]);
                        canonical.Append('=');
                        canonical.Append(inputs[keys[index]] == null ? string.Empty : Convert.ToString(inputs[keys[index]], CultureInfo.InvariantCulture));
                    }
                }
            }
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(canonical.ToString()));
                StringBuilder hex = new StringBuilder(hash.Length * 2);
                for (int index = 0; index < hash.Length; index++) hex.Append(hash[index].ToString("x2", CultureInfo.InvariantCulture));
                return hex.ToString();
            }
        }

        private static void AppendCanonical(StringBuilder builder, Dictionary<string, object> request, string key)
        {
            object value;
            if (!request.TryGetValue(key, out value)) return;
            builder.Append('|');
            builder.Append(key);
            builder.Append('=');
            if (value != null) builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
        }
    }

    public static class Core
    {
        /// <summary>Entry point called by the PowerShell bootstrap.</summary>
        public static int Run(bool dryRun)
        {
            return RunWithOptions(dryRun, null);
        }

        /// <summary>Entry point with an optional JSON options object (test/CI use).</summary>
        public static int RunWithOptions(bool dryRun, string optionsJson)
        {
            HelperOptions options = HelperOptions.FromEnvironment();
            if (!string.IsNullOrEmpty(optionsJson))
            {
                try
                {
                    JavaScriptSerializer serializer = new JavaScriptSerializer();
                    serializer.MaxJsonLength = 64 * 1024;
                    serializer.RecursionLimit = 32;
                    Dictionary<string, object> parsed = serializer.Deserialize<Dictionary<string, object>>(optionsJson);
                    if (parsed != null)
                    {
                        object value;
                        if (parsed.TryGetValue("heartbeatTimeoutMs", out value) && value != null) options.HeartbeatTimeoutMs = HelperOptions.Clamp(Convert.ToInt32(value, CultureInfo.InvariantCulture), 50, 500);
                        if (parsed.TryGetValue("pulseTtlMs", out value) && value != null) options.PulseTtlMs = HelperOptions.Clamp(Convert.ToInt32(value, CultureInfo.InvariantCulture), 1, 150);
                        if (parsed.TryGetValue("dedupCapacity", out value) && value != null) options.DedupCapacity = HelperOptions.Clamp(Convert.ToInt32(value, CultureInfo.InvariantCulture), 1, 4096);
                        if (parsed.TryGetValue("dedupTtlMs", out value) && value != null) options.DedupTtlMs = HelperOptions.Clamp(Convert.ToInt32(value, CultureInfo.InvariantCulture), 1, 600000);
                    }
                }
                catch (Exception) { /* invalid test options fall back to safe defaults */ }
            }
            return new Host(dryRun, options).Run();
        }
    }
}
