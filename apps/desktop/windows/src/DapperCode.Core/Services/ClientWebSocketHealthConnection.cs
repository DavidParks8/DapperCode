using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using DapperCode.Core.Models;
using DapperCode.Core.Serialization;

namespace DapperCode.Core.Services;

internal sealed class ClientWebSocketHealthConnection : IBridgeHealthConnection
{
    private const int MaximumMessageBytes = 256 * 1024;
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ResponseTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan EventRefreshInterval = TimeSpan.FromSeconds(5);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<BridgeObservedHealth>>
        _pending = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private ClientWebSocket? _socket;
    private CancellationTokenSource? _lifetime;
    private Action<BridgeObservedHealth>? _onHealth;
    private Task? _eventRefresh;
    private long _lastHealthRequest;
    private int _requestId;
    private int _eventRefreshScheduled;

    public async Task RunAsync(
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

        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var connectCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
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

        _socket = socket;
        _lifetime = lifetime;
        _onHealth = onHealth;
        var receive = ReceiveLoopAsync(socket, lifetime.Token);
        Task? heartbeat = null;
        try
        {
            onHealth(await RequestHealthAsync(socket, lifetime.Token).ConfigureAwait(false));
            heartbeat = HeartbeatLoopAsync(socket, lifetime.Token);
            var completed = await Task.WhenAny(receive, heartbeat).ConfigureAwait(false);
            await completed.ConfigureAwait(false);
            throw new IOException("The broker health connection closed.");
        }
        finally
        {
            lifetime.Cancel();
            socket.Abort();
            CancelPending(lifetime.Token);
            await IgnoreCancellationAsync(receive).ConfigureAwait(false);
            if (heartbeat is not null)
            {
                await IgnoreCancellationAsync(heartbeat).ConfigureAwait(false);
            }

            if (_eventRefresh is not null)
            {
                await IgnoreCancellationAsync(_eventRefresh).ConfigureAwait(false);
            }

            _socket = null;
            _lifetime = null;
            _onHealth = null;
        }
    }

    public ValueTask DisposeAsync()
    {
        _lifetime?.Cancel();
        _socket?.Abort();
        return ValueTask.CompletedTask;
    }

    private async Task HeartbeatLoopAsync(
        ClientWebSocket socket,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            await Task.Delay(HeartbeatInterval, cancellationToken).ConfigureAwait(false);
            var health = await RequestHealthAsync(socket, cancellationToken).ConfigureAwait(false);
            _onHealth?.Invoke(health);
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
        CancellationToken cancellationToken)
    {
        while (socket.State == WebSocketState.Open)
        {
            var message = await ReadMessageAsync(socket, cancellationToken).ConfigureAwait(false);
            if (message is null)
            {
                return;
            }

            HandleMessage(message);
        }
    }

    private void HandleMessage(byte[] message)
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
                _onHealth?.Invoke(health);
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

        ScheduleEventRefresh();
    }

    private void ScheduleEventRefresh()
    {
        if (_socket is null ||
            _lifetime is null ||
            Interlocked.CompareExchange(ref _eventRefreshScheduled, 1, 0) != 0)
        {
            return;
        }

        _eventRefresh = Task.Run(async () =>
        {
            try
            {
                var elapsed = Stopwatch.GetElapsedTime(
                    Interlocked.Read(ref _lastHealthRequest));
                var remaining = EventRefreshInterval - elapsed;
                if (remaining > TimeSpan.Zero)
                {
                    await Task.Delay(remaining, _lifetime.Token).ConfigureAwait(false);
                }

                var health = await RequestHealthAsync(_socket, _lifetime.Token)
                    .ConfigureAwait(false);
                _onHealth?.Invoke(health);
            }
            catch
            {
                _lifetime.Cancel();
                throw;
            }
            finally
            {
                Interlocked.Exchange(ref _eventRefreshScheduled, 0);
            }
        }, _lifetime.Token);
    }

    private static async Task<byte[]?> ReadMessageAsync(
        ClientWebSocket socket,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(
                new ArraySegment<byte>(buffer),
                cancellationToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            if (message.Length + result.Count > MaximumMessageBytes)
            {
                throw new IOException("The broker health message exceeded the size limit.");
            }

            await message.WriteAsync(
                buffer.AsMemory(0, result.Count),
                cancellationToken).ConfigureAwait(false);
            if (result.EndOfMessage)
            {
                return message.ToArray();
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
