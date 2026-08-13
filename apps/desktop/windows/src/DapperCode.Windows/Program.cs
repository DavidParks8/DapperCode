using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using DapperCode.Windows.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using WinRT;

namespace DapperCode.Windows;

public static class Program
{
    private static readonly ConcurrentQueue<AppActivationArguments> PendingActivations = new();

    internal static AppActivationArguments InitialActivation { get; private set; } = null!;
    internal static event Action? ActivationQueued;

    [STAThread]
    public static int Main(string[] args)
    {
        ComWrappersSupport.InitializeComWrappers();
        if (RedirectToPrimaryInstance())
        {
            return 0;
        }

        Application.Start(initialization =>
        {
            var context = new DispatcherQueueSynchronizationContext(
                DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }

    internal static bool TryDequeueActivation(out AppActivationArguments? arguments) =>
        PendingActivations.TryDequeue(out arguments);

    private static bool RedirectToPrimaryInstance()
    {
        InitialActivation = AppInstance.GetCurrent().GetActivatedEventArgs();
        var primary = AppInstance.FindOrRegisterForKey("dev.dappercode.desktop");
        if (primary.IsCurrent)
        {
            primary.Activated += OnActivated;
            return false;
        }

        RedirectActivation(InitialActivation, primary);
        return true;
    }

    private static void OnActivated(object? sender, AppActivationArguments arguments)
    {
        PendingActivations.Enqueue(arguments);
        ActivationQueued?.Invoke();
    }

    private static void RedirectActivation(
        AppActivationArguments arguments,
        AppInstance primary)
    {
        var completed = NativeMethods.CreateEventW(IntPtr.Zero, true, false, null);
        if (completed == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        Exception? redirectError = null;
        _ = Task.Run(async () =>
        {
            try
            {
                await primary.RedirectActivationToAsync(arguments);
            }
            catch (Exception error)
            {
                redirectError = error;
            }
            finally
            {
                _ = NativeMethods.SetEvent(completed);
            }
        });

        try
        {
            const uint infinite = 0xFFFFFFFF;
            var handles = new[] { completed };
            var result = NativeMethods.CoWaitForMultipleObjects(
                0,
                infinite,
                1,
                handles,
                out _);
            if (result != 0)
            {
                Marshal.ThrowExceptionForHR(unchecked((int)result));
            }
        }
        finally
        {
            _ = NativeMethods.CloseHandle(completed);
        }

        if (redirectError is not null)
        {
            throw new InvalidOperationException(
                "Could not redirect DapperCode activation to the running instance.",
                redirectError);
        }
    }

}
