# Windows dev launch: gives the shortcuts that start this checkout (Desktop, Start menu, taskbar pin) the AI Box icon,
# the right arguments and the AppUserModelID the app sets at runtime (src/shared/brand.ts APP_ID), so the taskbar
# groups the window under them instead of showing Electron's own icon. Run: powershell -File scripts/windows-shortcuts.ps1
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appId = (Select-String -Path (Join-Path $repo 'src/shared/brand.ts') -Pattern "APP_ID = '([^']+)'").Matches[0].Groups[1].Value
$electron = Join-Path $repo 'node_modules/electron/dist/electron.exe'
$icon = Join-Path $repo 'assets/icon.ico'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShortcutId {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PropertyKey k); void GetValue(ref PropertyKey k, out PropVariant v); void SetValue(ref PropertyKey k, ref PropVariant v); void Commit(); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bc, uint flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
  [DllImport("ole32.dll", PreserveSig = false)] static extern void PropVariantClear(ref PropVariant v);
  public static void Set(string lnk, string id) {
    Guid iid = typeof(IPropertyStore).GUID; IPropertyStore ps;
    SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 2, ref iid, out ps);
    PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    PropVariant v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
    ps.SetValue(ref key, ref v); ps.Commit(); PropVariantClear(ref v);
  }
}
'@

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI Box.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'AI Box.lnk')
)
$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$targets += Get-ChildItem $pinned -Filter *.lnk -ErrorAction SilentlyContinue |
  Where-Object { $shell.CreateShortcut($_.FullName).TargetPath -ieq $electron } | ForEach-Object FullName

foreach ($path in $targets) {
  $l = $shell.CreateShortcut($path)
  $l.TargetPath = $electron
  $l.Arguments = '"' + $repo + '"'
  $l.WorkingDirectory = $repo
  $l.IconLocation = "$icon,0"
  $l.Description = 'AI Box'
  $l.Save()
  [ShortcutId]::Set($path, $appId)
  "ok  $path"
}
& "$env:SystemRoot\System32\ie4uinit.exe" -show
