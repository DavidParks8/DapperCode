using System.Collections.Concurrent;
using DapperCode.Windows.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using WinRT;

namespace DapperCode.Windows;

/// <summary>Bootstraps the WinUI dispatcher and redirects secondary activations to one app instance.</summary>
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

        primary.RedirectActivationToAsync(InitialActivation)
            .AsTask()
            .GetAwaiter()
            .GetResult();
        return true;
    }

    private static void OnActivated(object? sender, AppActivationArguments arguments)
    {
        PendingActivations.Enqueue(arguments);
        ActivationQueued?.Invoke();
    }

}
