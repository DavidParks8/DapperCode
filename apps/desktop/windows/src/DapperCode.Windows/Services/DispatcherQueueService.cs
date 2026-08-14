using DapperCode.Core.Services;
using Microsoft.UI.Dispatching;

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
