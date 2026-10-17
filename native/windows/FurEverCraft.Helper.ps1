param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class FurEverCraftNative {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  public static void Key(ushort code, bool down) { var i=new INPUT(); i.type=1; i.U.ki.wVk=code; i.U.ki.dwFlags=down?0u:2u; if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("sendinput-failed"); }
  public static void Unicode(char c, bool down) { var i=new INPUT(); i.type=1; i.U.ki.wScan=c; i.U.ki.dwFlags=4u|(down?0u:2u); if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("sendinput-failed"); }
  public static void Mouse(int dx,int dy,uint flags,uint data=0) { var i=new INPUT(); i.type=0; i.U.mi.dx=dx; i.U.mi.dy=dy; i.U.mi.mouseData=data; i.U.mi.dwFlags=flags; if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("sendinput-failed"); }
  public static string Capture(IntPtr hwnd) { RECT r; if(!GetWindowRect(hwnd,out r)) throw new Exception("capture-window-rect-unavailable"); using(var b=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) using(var g=Graphics.FromImage(b)) { g.CopyFromScreen(r.Left,r.Top,0,0,b.Size); using(var m=new System.IO.MemoryStream()){ b.Save(m,ImageFormat.Png); return Convert.ToBase64String(m.ToArray()); } } }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
$owned = New-Object 'System.Collections.Generic.HashSet[string]'
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$boundPid = 0
$boundHwnd = [IntPtr]::Zero
$generation = -1
$heartbeatDeadline = [DateTime]::UtcNow.AddSeconds(8)
$script:DryRunMode = [bool]$DryRun
function Release-Owned {
  if ($script:DryRunMode) { $owned.Clear(); return }
  foreach ($key in @($owned)) { if ($key.StartsWith('key:')) { [FurEverCraftNative]::Key([UInt16]$key.Substring(4), $false) } elseif ($key -eq 'mouse:left') { [FurEverCraftNative]::Mouse(0,0,0x0004) } elseif ($key -eq 'mouse:right') { [FurEverCraftNative]::Mouse(0,0,0x0010) } elseif ($key -eq 'mouse:middle') { [FurEverCraftNative]::Mouse(0,0,0x0040) } }
  $owned.Clear()
}
function Assert-Window {
  if ($boundHwnd -eq [IntPtr]::Zero -or -not [FurEverCraftNative]::IsWindow($boundHwnd)) { throw 'window-not-found' }
  [uint32]$pid = 0; [void][FurEverCraftNative]::GetWindowThreadProcessId($boundHwnd,[ref]$pid)
  if ($pid -ne $boundPid) { throw 'window-pid-mismatch' }
  if ([FurEverCraftNative]::GetForegroundWindow() -ne $boundHwnd) { Release-Owned; throw 'window-not-focused' }
}
function Assert-Action($request) {
  Assert-Window
  if ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.leaseUntil).UtcDateTime -le [DateTime]::UtcNow) { Release-Owned; throw 'input-expired' }
  if ($request.PSObject.Properties.Name -contains 'generation' -and [long]$request.generation -lt $generation) { throw 'stale-generation' }
  if ([DateTime]::UtcNow -gt $heartbeatDeadline) { Release-Owned; throw 'heartbeat-expired' }
}
while ($line = [Console]::In.ReadLine()) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($null -eq $request -or $request.PSObject.Properties.Name -notcontains 'requestId' -or [string]::IsNullOrWhiteSpace([string]$request.requestId)) { throw 'requestId-required' }
    if ($request.PSObject.Properties.Name -notcontains 'command' -or [string]::IsNullOrWhiteSpace([string]$request.command)) { throw 'command-required' }
    if (@('moveRelative','click','typeText') -contains [string]$request.command -and ($request.PSObject.Properties.Name -notcontains 'commandId' -or [string]::IsNullOrWhiteSpace([string]$request.commandId))) { throw 'commandId-required' }
    if (@('setHeldInputs','moveRelative','click','typeText') -contains [string]$request.command -and $request.PSObject.Properties.Name -notcontains 'leaseUntil') { throw 'leaseUntil-required' }
    $result = switch ($request.command) {
      'probe' { @{ supported=$true; dryRun=$DryRun; platform='windows'; inputBackend='SendInput'; captureBackend='OS-window-capture' } }
      'bindWindow' {
        $candidate = [IntPtr]([long]$request.hwnd)
        if (-not [FurEverCraftNative]::IsWindow($candidate)) { throw 'window-not-found' }
        [uint32]$pid = 0; [void][FurEverCraftNative]::GetWindowThreadProcessId($candidate,[ref]$pid)
        if ($pid -ne [uint32]$request.pid) { throw 'window-pid-mismatch' }
        Release-Owned; $boundHwnd=$candidate; $boundPid=[uint32]$request.pid; $heartbeatDeadline=[DateTime]::UtcNow.AddSeconds(8); $generation=-1
        @{ bound=$true; pid=$boundPid; hwnd=$request.hwnd }
      }
      'getWindowState' {
        if ($boundHwnd -eq [IntPtr]::Zero) { throw 'window-not-bound' }
        [uint32]$pid = 0; $exists=[FurEverCraftNative]::IsWindow($boundHwnd); if($exists){[void][FurEverCraftNative]::GetWindowThreadProcessId($boundHwnd,[ref]$pid)}
        $focused=($exists -and $pid -eq $boundPid -and [FurEverCraftNative]::GetForegroundWindow() -eq $boundHwnd); $visible=($exists -and [FurEverCraftNative]::IsWindowVisible($boundHwnd))
        if(-not $focused){Release-Owned}; @{exists=$exists -and $pid -eq $boundPid; focused=$focused; visible=$visible; pid=$pid; hwnd=$boundHwnd.ToInt64().ToString()}
      }
      'heartbeat' { $heartbeatDeadline=[DateTime]::UtcNow.AddSeconds(8); @{alive=$true} }
      'releaseOwnedInputs' { Release-Owned; @{released=$true} }
      'shutdown' { Release-Owned; $boundHwnd=[IntPtr]::Zero; @{stopped=$true}; $script:Stop=$true }
      'setHeldInputs' {
        Assert-Action $request; if([long]$request.generation -gt $generation){Release-Owned;$generation=[long]$request.generation}
        foreach($entry in $request.inputs.PSObject.Properties){ $key='key:'+$entry.Name; if($DryRun){continue}; $code=[UInt16]::Parse($entry.Name); if([bool]$entry.Value){if($owned.Add($key)){[FurEverCraftNative]::Key($code,$true)}}elseif($owned.Remove($key)){[FurEverCraftNative]::Key($code,$false)} }
        @{accepted=$true;generation=$generation}
      }
      'moveRelative' {
        Assert-Action $request; if([long]$request.generation -gt $generation){$generation=[long]$request.generation}; if(-not $seen.Add([string]$request.commandId)){@{accepted=$true;duplicate=$true;commandId=$request.commandId};break}
        if(-not $DryRun){[FurEverCraftNative]::Mouse([int]$request.dx,[int]$request.dy,0x0001)}; @{accepted=$true;commandId=$request.commandId}
      }
      'click' {
        Assert-Action $request; if([long]$request.generation -gt $generation){$generation=[long]$request.generation}; if(-not $seen.Add([string]$request.commandId)){@{accepted=$true;duplicate=$true;commandId=$request.commandId};break}
        $flags=switch([string]$request.button){'left'{0x0002 -bor 0x0004};'right'{0x0008 -bor 0x0010};'middle'{0x0020 -bor 0x0040};default{throw 'invalid-mouse-button'}}
        if(-not $DryRun){$down=switch([string]$request.button){'left'{0x0002};'right'{0x0008};'middle'{0x0020};default{throw 'invalid-mouse-button'}};$up=switch([string]$request.button){'left'{0x0004};'right'{0x0010};'middle'{0x0040};default{throw 'invalid-mouse-button'}};[FurEverCraftNative]::Mouse(0,0,[uint32]$down);[FurEverCraftNative]::Mouse(0,0,[uint32]$up)}; @{accepted=$true;commandId=$request.commandId}
      }
      'typeText' {
        Assert-Action $request; if([long]$request.generation -gt $generation){$generation=[long]$request.generation}; if(-not $seen.Add([string]$request.commandId)){@{accepted=$true;duplicate=$true;commandId=$request.commandId};break}
        if(-not $DryRun){foreach($char in [string]$request.text){[FurEverCraftNative]::Unicode($char,$true);[FurEverCraftNative]::Unicode($char,$false)}}; @{accepted=$true;commandId=$request.commandId}
      }
      'captureWindow' {
        if($boundHwnd -eq [IntPtr]::Zero -or -not [FurEverCraftNative]::IsWindow($boundHwnd)){throw 'window-not-found'}
        if(-not [FurEverCraftNative]::IsWindowVisible($boundHwnd)){throw 'capture-limited-window-not-visible'}
        [uint32]$pid=0;[void][FurEverCraftNative]::GetWindowThreadProcessId($boundHwnd,[ref]$pid);if($pid -ne $boundPid){throw 'window-pid-mismatch'}
        if($DryRun){@{accepted=$true;synthetic=$true;limitation='dry-run';source='fixture'}}else{Assert-Window;@{accepted=$true;synthetic=$false;source='os-window-capture';imageBase64=[FurEverCraftNative]::Capture($boundHwnd);limitation='OS window capture is not original game framebuffer'}}
      }
      default { throw 'unknown-command' }
    }
    @{requestId=$request.requestId;ok=$true;result=$result} | ConvertTo-Json -Compress -Depth 8 | ForEach-Object {[Console]::Out.WriteLine($_)}
    if($script:Stop){break}
  } catch { @{requestId=if($request){$request.requestId}else{$null};ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress -Depth 5 | ForEach-Object {[Console]::Out.WriteLine($_)} }
}
try { Release-Owned } catch {}
