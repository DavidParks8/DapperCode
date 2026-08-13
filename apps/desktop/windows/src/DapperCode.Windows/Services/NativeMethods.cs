using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace DapperCode.Windows.Services;

internal static partial class NativeMethods
{
    [LibraryImport(
        "kernel32.dll",
        EntryPoint = "CreateEventW",
        SetLastError = true,
        StringMarshalling = StringMarshalling.Utf16)]
    internal static partial SafeWaitHandle CreateEventW(
        IntPtr eventAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool manualReset,
        [MarshalAs(UnmanagedType.Bool)] bool initialState,
        string? name);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetEvent(SafeWaitHandle handle);

    [LibraryImport("ole32.dll")]
    internal static partial uint CoWaitForMultipleObjects(
        uint flags,
        uint timeoutMilliseconds,
        uint handleCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] IntPtr[] handles,
        out uint index);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetForegroundWindow(IntPtr window);
}
