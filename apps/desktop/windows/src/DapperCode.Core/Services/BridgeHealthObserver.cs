using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public sealed class BridgeHealthObserver(
    IBridgeHealthConnectionFactory connectionFactory,
    IAsyncDelay? delay = null) : IBridgeHealthObserver
{
    private sealed record Entry(
        BridgeObservationTarget Target,
        CancellationTokenSource Cancellation,
        Task Worker);

    private readonly Lock _gate = new();
    private readonly Dictionary<string, Entry> _entries = [];
    private readonly IAsyncDelay _delay = delay ?? new SystemAsyncDelay();
    private bool _disposed;

    public event Action<string, BridgeObservedHealth>? HealthUpdated;
    public event Action<string>? Disconnected;

    public void Synchronize(IReadOnlyCollection<BridgeObservationTarget> targets)
    {
        var next = targets.ToDictionary(target => target.ProfileId, StringComparer.Ordinal);
        List<Entry> removed = [];
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            foreach (var current in _entries.ToArray())
            {
                if (!next.TryGetValue(current.Key, out var desired) ||
                    current.Value.Target != desired)
                {
                    _entries.Remove(current.Key);
                    removed.Add(current.Value);
                }
            }

            foreach (var target in targets)
            {
                if (_entries.ContainsKey(target.ProfileId))
                {
                    continue;
                }

                var cancellation = new CancellationTokenSource();
                var worker = ObserveAsync(target, cancellation.Token);
                _entries[target.ProfileId] = new Entry(target, cancellation, worker);
            }
        }

        foreach (var entry in removed)
        {
            entry.Cancellation.Cancel();
            _ = entry.Worker.ContinueWith(
                static (worker, state) =>
                {
                    _ = worker.Exception;
                    ((CancellationTokenSource)state!).Dispose();
                },
                entry.Cancellation,
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

        foreach (var entry in entries)
        {
            entry.Cancellation.Cancel();
        }

        await Task.WhenAll(entries.Select(entry => entry.Worker)).ConfigureAwait(false);
        foreach (var entry in entries)
        {
            entry.Cancellation.Dispose();
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
                await using var connection = connectionFactory.Create();
                await connection.RunAsync(
                    target,
                    health =>
                    {
                        failures = 0;
                        HealthUpdated?.Invoke(target.ProfileId, health);
                    },
                    cancellationToken).ConfigureAwait(false);
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
                Disconnected?.Invoke(target.ProfileId);
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
