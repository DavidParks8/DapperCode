using System.Diagnostics;
using DapperCode.Core.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.Windows.Storage.Pickers;
using Windows.ApplicationModel;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.System;

namespace DapperCode.Windows.Services;

public sealed class DispatcherQueueService(
    DispatcherQueue dispatcherQueue) : IUiDispatcher
{
    public void Post(Action action)
    {
        if (dispatcherQueue.HasThreadAccess)
        {
            action();
            return;
        }

        if (!dispatcherQueue.TryEnqueue(() => action()))
        {
            throw new InvalidOperationException("The DapperCode UI dispatcher is unavailable.");
        }
    }
}
