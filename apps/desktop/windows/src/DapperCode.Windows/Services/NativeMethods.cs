using System.Runtime.InteropServices;

namespace DapperCode.Windows.Services;

internal static class NativeMethods
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateEventW(
        IntPtr eventAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool manualReset,
        [MarshalAs(UnmanagedType.Bool)] bool initialState,
        string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetEvent(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("ole32.dll")]
    internal static extern uint CoWaitForMultipleObjects(
        uint flags,
        uint timeoutMilliseconds,
        ulong handleCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] IntPtr[] handles,
        out uint index);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(IntPtr window);
}
