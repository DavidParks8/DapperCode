using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace DapperCode.Core.Services;

public sealed class OperatorProcessRegistry : IDisposable
{
    private readonly ConcurrentDictionary<int, Process> _processes = new();
    private readonly CancellationTokenSource _shutdown = new();
    private int _isShuttingDown;

    public bool IsShuttingDown => Volatile.Read(ref _isShuttingDown) != 0;
    public CancellationToken ShutdownToken => _shutdown.Token;

    internal void Register(Process process, bool allowDuringShutdown)
    {
        if (IsShuttingDown && !allowDuringShutdown)
        {
            throw new OperatorException("DapperCode is quitting.");
        }

        if (!_processes.TryAdd(process.Id, process))
        {
            throw new OperatorException("Could not track the DapperCode operator process.");
        }

        if (IsShuttingDown && !allowDuringShutdown)
        {
            Unregister(process);
            TryKill(process);
            throw new OperatorException("DapperCode is quitting.");
        }
    }

    internal void Unregister(Process process) => _processes.TryRemove(process.Id, out _);

    public void BeginShutdown()
    {
        if (Interlocked.Exchange(ref _isShuttingDown, 1) != 0)
        {
            return;
        }

        _shutdown.Cancel();
        foreach (var process in _processes.Values)
        {
            TryKill(process);
        }
    }

    public void Dispose()
    {
        BeginShutdown();
        _shutdown.Dispose();
    }

    internal static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
        }
        catch (Win32Exception)
        {
        }
    }
}
