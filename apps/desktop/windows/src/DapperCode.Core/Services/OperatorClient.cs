using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using DapperCode.Core.Models;
using DapperCode.Core.Serialization;

namespace DapperCode.Core.Services;

public sealed class OperatorClient(
    IOperatorPathProvider pathProvider,
    IOperatorProcessRunner runner,
    Func<int>? processId = null) : IOperatorClient
{
    private readonly Func<int> _processId = processId ?? (() => Environment.ProcessId);

    public Task<BridgeSnapshot> GetStatusAsync(
        string workspace,
        CancellationToken cancellationToken) =>
        InvokeAsync<BridgeSnapshot>(
            ["status"],
            workspace,
            attachOwner: false,
            allowDuringShutdown: false,
            DapperCodeJsonContext.Default.OperatorEnvelopeBridgeSnapshot,
            cancellationToken);

    public async Task<IReadOnlyList<BridgeSnapshot>> ListAsync(
        CancellationToken cancellationToken) =>
        await InvokeAsync<List<BridgeSnapshot>>(
            ["list"],
            workspace: null,
            attachOwner: true,
            allowDuringShutdown: false,
            DapperCodeJsonContext.Default.OperatorEnvelopeListBridgeSnapshot,
            cancellationToken).ConfigureAwait(false);

    public Task<BridgeSnapshot> StartAsync(
        string workspace,
        CancellationToken cancellationToken) =>
        InvokeAsync<BridgeSnapshot>(
            ["start"],
            workspace,
            attachOwner: true,
            allowDuringShutdown: false,
            DapperCodeJsonContext.Default.OperatorEnvelopeBridgeSnapshot,
            cancellationToken);

    public Task<BridgeSnapshot> StopAsync(
        string workspace,
        CancellationToken cancellationToken) =>
        InvokeAsync<BridgeSnapshot>(
            ["stop"],
            workspace,
            attachOwner: false,
            allowDuringShutdown: false,
            DapperCodeJsonContext.Default.OperatorEnvelopeBridgeSnapshot,
            cancellationToken);

    public Task<BridgeSnapshot> RestartAsync(
        string workspace,
        CancellationToken cancellationToken) =>
        InvokeAsync<BridgeSnapshot>(
            ["restart"],
            workspace,
            attachOwner: true,
            allowDuringShutdown: false,
            DapperCodeJsonContext.Default.OperatorEnvelopeBridgeSnapshot,
            cancellationToken);

    public Task<SetupResult> SetupAsync(
        SetupOptions options,
        CancellationToken cancellationToken)
    {
        var arguments = new List<string>
        {
            "setup",
            "--network",
            options.NetworkMode == NetworkMode.Tailscale ? "tailscale" : "local",
        };
        if (!string.IsNullOrWhiteSpace(options.Host))
        {
            arguments.AddRange(["--host", options.Host]);
        }
        arguments.AddRange([
            "--agent-id",
            options.AgentId,
            "--display-name",
            options.DisplayName,
            "--agent-executable",
            options.AgentExecutable,
            "--agent-args",
            options.AgentArguments,
        ]);

        if (options.BridgePort is { } port)
        {
            arguments.AddRange(["--port", port.ToString(System.Globalization.CultureInfo.InvariantCulture)]);
        }

        if (options.ReplaceBrokerEndpoint)
        {
            arguments.Add("--replace-broker-endpoint");
        }

        return InvokeAsync<SetupResult>(
            arguments,
            options.Workspace,
            attachOwner: false,
            allowDuringShutdown: false,
            DapperCodeJsonContext.Default.OperatorEnvelopeSetupResult,
            cancellationToken);
    }

    public Task<AgentDiscovery> DiscoverAgentAsync(
        string agentId,
        CancellationToken cancellationToken) =>
        InvokeAsync<AgentDiscovery>(
            ["discover-agent", "--agent-id", agentId],
            workspace: null,
            attachOwner: false,
            allowDuringShutdown: false,
            DapperCodeJsonContext.Default.OperatorEnvelopeAgentDiscovery,
            cancellationToken);

    public async Task<bool> StopAllForShutdownAsync(TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);
        try
        {
            var result = await runner.RunAsync(
                pathProvider.OperatorPath,
                ["stop", "--all"],
                allowDuringShutdown: true,
                cancellation.Token).ConfigureAwait(false);
            return result.ExitCode == 0;
        }
        catch (Exception error) when (
            error is OperationCanceledException or OperatorException or
            System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private async Task<T> InvokeAsync<T>(
        IReadOnlyList<string> command,
        string? workspace,
        bool attachOwner,
        bool allowDuringShutdown,
        JsonTypeInfo<OperatorEnvelope<T>> envelopeTypeInfo,
        CancellationToken cancellationToken)
    {
        var arguments = new List<string>(command);
        if (attachOwner)
        {
            arguments.AddRange(["--owner-pid", _processId().ToString(
                System.Globalization.CultureInfo.InvariantCulture)]);
        }

        if (!string.IsNullOrWhiteSpace(workspace))
        {
            arguments.AddRange(["--workspace", workspace]);
        }

        var execution = await runner.RunAsync(
            pathProvider.OperatorPath,
            arguments,
            allowDuringShutdown,
            cancellationToken).ConfigureAwait(false);

        if (execution.ExitCode != 0)
        {
            var failure = TryDeserialize(
                execution.StandardError,
                DapperCodeJsonContext.Default.OperatorFailure);
            var message = failure?.Error;
            if (string.IsNullOrWhiteSpace(message))
            {
                message = execution.StandardError.Trim();
            }

            throw new OperatorException(string.IsNullOrWhiteSpace(message)
                ? $"The DapperCode operator exited with code {execution.ExitCode}."
                : message);
        }

        var envelope = TryDeserialize(execution.StandardOutput, envelopeTypeInfo);
        if (envelope is null || !envelope.Ok || envelope.Result is null)
        {
            throw new OperatorException("The DapperCode operator returned an invalid response.");
        }

        return envelope.Result;
    }

    private static T? TryDeserialize<T>(string json, JsonTypeInfo<T> jsonTypeInfo)
    {
        try
        {
            return JsonSerializer.Deserialize(json, jsonTypeInfo);
        }
        catch (JsonException)
        {
            return default;
        }
    }

}
