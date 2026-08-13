using System.Net.WebSockets;
using System.Text.Json;
using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public sealed class BridgeHealthObserver(
    IBridgeHealthConnectionFactory connectionFactory,
    IAsyncDelay? delay = null) : IBridgeHealthObserver
{
    private sealed class Entry : IDisposable
    {
        public Entry(BridgeHealthObserver owner, BridgeObservationTarget target)
        {
            Target = target;
            Cancellation = new CancellationTokenSource();
            Worker = ObserveAfterYieldAsync(owner, target, Cancellation.Token);
        }

        public BridgeObservationTarget Target { get; }
        public CancellationTokenSource Cancellation { get; }
        public Task Worker { get; }

        public void Dispose() => Cancellation.Dispose();

        private static async Task ObserveAfterYieldAsync(
            BridgeHealthObserver owner,
            BridgeObservationTarget target,
            CancellationToken cancellationToken)
        {
            await Task.Yield();
            await owner.ObserveAsync(target, cancellationToken).ConfigureAwait(false);
        }
    }

    private readonly Lock _gate = new();
    private readonly Dictionary<string, Entry> _entries = [];
    private readonly IAsyncDelay _delay = delay ?? new SystemAsyncDelay();
    private bool _disposed;

    public event EventHandler<BridgeHealthUpdatedEventArgs>? HealthUpdated;
    public event EventHandler<BridgeDisconnectedEventArgs>? Disconnected;

    public void Synchronize(IReadOnlyCollection<BridgeObservationTarget> targets)
    {
        ArgumentNullException.ThrowIfNull(targets);
        var next = targets.ToDictionary(target => target.ProfileId, StringComparer.Ordinal);
        List<Entry> removed = [];
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            foreach (var current in _entries.Values)
            {
                if (!next.TryGetValue(current.Target.ProfileId, out var desired) ||
                    current.Target != desired)
                {
                    removed.Add(current);
                }
            }
            foreach (var entry in removed)
            {
                _entries.Remove(entry.Target.ProfileId);
            }

            foreach (var target in targets)
            {
                if (_entries.ContainsKey(target.ProfileId))
                {
                    continue;
                }

                _entries[target.ProfileId] = new Entry(this, target);
            }
        }

        foreach (var entry in removed)
        {
            entry.Cancellation.Cancel();
            _ = entry.Worker.ContinueWith(
                static (worker, state) =>
                {
                    _ = worker.Exception;
                    ((Entry)state!).Dispose();
                },
                entry,
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }

    public async ValueTask DisposeAsync()
    {
        List<Entry> entries;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            entries = [.. _entries.Values];
            _entries.Clear();
        }

        try
        {
            foreach (var entry in entries)
            {
                await entry.Cancellation.CancelAsync().ConfigureAwait(false);
            }

            await Task.WhenAll(entries.Select(entry => entry.Worker)).ConfigureAwait(false);
        }
        finally
        {
            foreach (var entry in entries)
            {
                entry.Dispose();
            }
        }
    }

    private async Task ObserveAsync(
        BridgeObservationTarget target,
        CancellationToken cancellationToken)
    {
        var failures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var connection = connectionFactory.Create();
                await using (connection.ConfigureAwait(false))
                {
                    await connection.RunAsync(
                        target,
                        health =>
                        {
                            failures = 0;
                            HealthUpdated?.Invoke(
                                this,
                                new BridgeHealthUpdatedEventArgs(target.ProfileId, health));
                        },
                        cancellationToken).ConfigureAwait(false);
                }
                throw new IOException("The broker health connection closed.");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error) when (
                error is IOException or WebSocketException or TimeoutException or
                JsonException or OperatorException or OperationCanceledException)
            {
                failures = Math.Min(failures + 1, 6);
                Disconnected?.Invoke(this, new BridgeDisconnectedEventArgs(target.ProfileId));
                try
                {
                    await _delay.DelayAsync(
                        BridgeReconnectPolicy.DelayForFailure(failures),
                        cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
            }
        }
    }
}
