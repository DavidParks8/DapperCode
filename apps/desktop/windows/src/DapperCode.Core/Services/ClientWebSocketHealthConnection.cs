using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using DapperCode.Core.Models;
using DapperCode.Core.Serialization;

namespace DapperCode.Core.Services;

/// <summary>
/// Maintains the broker's ordered JSON-RPC WebSocket stream and translates health responses and
/// notifications into typed callbacks. The socket remains the transport boundary; internal
/// channels would add a second queue without replacing WebSocket framing or backpressure.
/// </summary>
internal sealed class ClientWebSocketHealthConnection : IBridgeHealthConnection
{
    private const int MaximumMessageBytes = 256 * 1024;
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ResponseTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan EventRefreshInterval = TimeSpan.FromSeconds(5);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<BridgeObservedHealth>>
        _pending = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _disposeCancellation = new();
    private readonly Lock _lifecycleGate = new();
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private TaskCompletionSource? _runCompletion;
    private Task? _eventRefresh;
    private Task? _disposeTask;
    private long _lastHealthRequest;
    private int _requestId;
    private int _eventRefreshScheduled;
    private bool _disposed;
    private bool _hasRun;

    public async Task RunAsync(
        BridgeObservationTarget target,
        Action<BridgeObservedHealth> onHealth,
        CancellationToken cancellationToken)
    {
        var runCompletion = BeginRun();
        try
        {
            await RunCoreAsync(target, onHealth, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            lock (_lifecycleGate)
            {
                _runCompletion = null;
            }

            runCompletion.TrySetResult();
        }
    }

    public ValueTask DisposeAsync()
    {
        lock (_lifecycleGate)
        {
            if (_disposeTask is null)
            {
                _disposed = true;
                _disposeTask = DisposeCoreAsync(_runCompletion?.Task);
            }

            return new ValueTask(_disposeTask);
        }
    }

    private async Task RunCoreAsync(
        BridgeObservationTarget target,
        Action<BridgeObservedHealth> onHealth,
        CancellationToken cancellationToken)
    {
        var endpoint = BridgeEndpoint.Parse(target);
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        socket.Options.SetRequestHeader("Authorization", endpoint.AuthorizationHeader);
        if (endpoint.WorkspaceId is { } workspaceId)
        {
            socket.Options.SetRequestHeader("X-DapperCode-Workspace", workspaceId);
        }

        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            _disposeCancellation.Token);
        using (var connectCancellation =
               CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            connectCancellation.CancelAfter(ConnectTimeout);
            try
            {
                await socket.ConnectAsync(endpoint.SocketUri, connectCancellation.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new TimeoutException("The broker health connection timed out.");
            }
        }

        Task? receive = null;
        Task? heartbeat = null;
        try
        {
            receive = ReceiveLoopAsync(socket, lifetime, onHealth);
            onHealth(await RequestHealthAsync(socket, lifetime.Token).ConfigureAwait(false));
            heartbeat = HeartbeatLoopAsync(socket, onHealth, lifetime.Token);
            var completed = await Task.WhenAny(receive, heartbeat).ConfigureAwait(false);
            await completed.ConfigureAwait(false);
            throw new IOException("The broker health connection closed.");
        }
        finally
        {
            await lifetime.CancelAsync().ConfigureAwait(false);
            socket.Abort();
            CancelPending(lifetime.Token);
            if (receive is not null)
            {
                await IgnoreCancellationAsync(receive).ConfigureAwait(false);
            }
            if (heartbeat is not null)
            {
                await IgnoreCancellationAsync(heartbeat).ConfigureAwait(false);
            }

            var eventRefresh = _eventRefresh;
            if (eventRefresh is not null)
            {
                await IgnoreCancellationAsync(eventRefresh).ConfigureAwait(false);
            }

            _eventRefresh = null;
        }
    }

    private TaskCompletionSource BeginRun()
    {
        lock (_lifecycleGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_hasRun)
            {
                throw new InvalidOperationException(
                    "A broker health connection can only be run once.");
            }

            _hasRun = true;
            _runCompletion = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
            return _runCompletion;
        }
    }

    private async Task DisposeCoreAsync(Task? runCompletion)
    {
        await _disposeCancellation.CancelAsync().ConfigureAwait(false);
        if (runCompletion is not null)
        {
            await runCompletion.ConfigureAwait(false);
        }

        _sendGate.Dispose();
        _disposeCancellation.Dispose();
    }

    private async Task HeartbeatLoopAsync(
        ClientWebSocket socket,
        Action<BridgeObservedHealth> onHealth,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            await Task.Delay(HeartbeatInterval, cancellationToken).ConfigureAwait(false);
            var health = await RequestHealthAsync(socket, cancellationToken).ConfigureAwait(false);
            onHealth(health);
        }
    }

    private async Task<BridgeObservedHealth> RequestHealthAsync(
        ClientWebSocket socket,
        CancellationToken cancellationToken)
    {
        var id = $"desktop-health-{Interlocked.Increment(ref _requestId)}";
        var completion = new TaskCompletionSource<BridgeObservedHealth>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(id, completion))
        {
            throw new IOException("Could not track the broker health request.");
        }

        Interlocked.Exchange(ref _lastHealthRequest, Stopwatch.GetTimestamp());
        var payload = JsonSerializer.SerializeToUtf8Bytes(
            new BrokerHealthRequest { Id = id },
            DapperCodeJsonContext.Default.BrokerHealthRequest);

        try
        {
            await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await socket.SendAsync(
                    new ArraySegment<byte>(payload),
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _sendGate.Release();
            }

            return await completion.Task.WaitAsync(ResponseTimeout, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    private async Task ReceiveLoopAsync(
        ClientWebSocket socket,
        CancellationTokenSource lifetime,
        Action<BridgeObservedHealth> onHealth)
    {
        while (socket.State == WebSocketState.Open)
        {
            var message = await ReadMessageAsync(socket, lifetime.Token).ConfigureAwait(false);
            if (message is not { } payload)
            {
                return;
            }

            HandleMessage(payload, socket, lifetime, onHealth);
        }
    }

    private void HandleMessage(
        ReadOnlyMemory<byte> message,
        ClientWebSocket socket,
        CancellationTokenSource lifetime,
        Action<BridgeObservedHealth> onHealth)
    {
        using var document = JsonDocument.Parse(message);
        var root = document.RootElement;
        var id = root.TryGetProperty("id", out var idProperty) &&
                 idProperty.ValueKind == JsonValueKind.String
            ? idProperty.GetString()
            : null;
        if (root.TryGetProperty("result", out var result) &&
            result.ValueKind == JsonValueKind.Object)
        {
            var health = result.Deserialize(DapperCodeJsonContext.Default.BridgeObservedHealth);
            if (health is null)
            {
                throw new JsonException("The broker returned invalid health data.");
            }

            if (id is not null && _pending.TryRemove(id, out var completion))
            {
                completion.TrySetResult(health);
            }
            else
            {
                onHealth(health);
            }

            return;
        }

        if (id is not null &&
            root.TryGetProperty("error", out var error) &&
            _pending.TryRemove(id, out var failed))
        {
            failed.TrySetException(new IOException(
                $"The broker health request failed: {error.GetRawText()}"));
            return;
        }

        ScheduleEventRefresh(socket, lifetime, onHealth);
    }

    private void ScheduleEventRefresh(
        ClientWebSocket socket,
        CancellationTokenSource lifetime,
        Action<BridgeObservedHealth> onHealth)
    {
        if (Interlocked.CompareExchange(ref _eventRefreshScheduled, 1, 0) != 0)
        {
            return;
        }

        _eventRefresh = RefreshAfterEventAsync(socket, lifetime, onHealth);
    }

    private async Task RefreshAfterEventAsync(
        ClientWebSocket socket,
        CancellationTokenSource lifetime,
        Action<BridgeObservedHealth> onHealth)
    {
        try
        {
            var elapsed = Stopwatch.GetElapsedTime(
                Interlocked.Read(ref _lastHealthRequest));
            var remaining = EventRefreshInterval - elapsed;
            if (remaining > TimeSpan.Zero)
            {
                await Task.Delay(remaining, lifetime.Token).ConfigureAwait(false);
            }

            var health = await RequestHealthAsync(socket, lifetime.Token).ConfigureAwait(false);
            onHealth(health);
        }
        catch
        {
            await lifetime.CancelAsync().ConfigureAwait(false);
            throw;
        }
        finally
        {
            Interlocked.Exchange(ref _eventRefreshScheduled, 0);
        }
    }

    private static async Task<ReadOnlyMemory<byte>?> ReadMessageAsync(
        ClientWebSocket socket,
        CancellationToken cancellationToken)
    {
        var message = new ArrayBufferWriter<byte>(16 * 1024);
        while (true)
        {
            var available = MaximumMessageBytes - message.WrittenCount;
            if (available == 0)
            {
                throw new IOException("The broker health message exceeded the size limit.");
            }

            var receiveSize = Math.Min(16 * 1024, available);
            var buffer = message.GetMemory(receiveSize)[..receiveSize];
            var result = await socket.ReceiveAsync(
                buffer,
                cancellationToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            message.Advance(result.Count);
            if (result.EndOfMessage)
            {
                return message.WrittenMemory;
            }
        }
    }

    private void CancelPending(CancellationToken cancellationToken)
    {
        foreach (var pending in _pending.Values)
        {
            pending.TrySetCanceled(cancellationToken);
        }

        _pending.Clear();
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (Exception error) when (
            error is OperationCanceledException or WebSocketException or IOException or
            JsonException or TimeoutException or OperatorException)
        {
        }
    }
}
