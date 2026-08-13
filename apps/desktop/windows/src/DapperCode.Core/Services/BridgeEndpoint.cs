using System.Text.Json;
using DapperCode.Core.Models;
using DapperCode.Core.Serialization;

namespace DapperCode.Core.Services;

public sealed record BridgeEndpoint(Uri SocketUri, string Token, string? WorkspaceId)
{
    public static BridgeEndpoint Parse(BridgeObservationTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        PairingPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                target.PairingPayload,
                DapperCodeJsonContext.Default.PairingPayload);
        }
        catch (JsonException error)
        {
            throw new OperatorException("The broker pairing data is invalid.", error);
        }

        if (payload is null ||
            payload.Type is not ("dappercode-broker-pair" or "dappercode-bridge-pair") ||
            string.IsNullOrWhiteSpace(payload.BridgeToken) ||
            !Uri.TryCreate(payload.BridgeUrl, UriKind.Absolute, out var bridgeUri) ||
            bridgeUri.Scheme is not ("http" or "https"))
        {
            throw new OperatorException("The broker pairing data is invalid.");
        }

        var builder = new UriBuilder(bridgeUri)
        {
            Scheme = bridgeUri.Scheme == "https" ? "wss" : "ws",
            Fragment = string.Empty,
        };
        var basePath = builder.Path.Trim('/');
        builder.Path = basePath.Length == 0
            ? "/broker/rpc"
            : $"/{basePath}/broker/rpc";

        const string query = "clientType=desktop-monitor&clientName=DapperCode";
        var workspaceId = string.IsNullOrWhiteSpace(payload.WorkspaceId)
            ? null
            : payload.WorkspaceId.Trim();
        builder.Query = workspaceId is null
            ? query
            : $"{query}&workspace={Uri.EscapeDataString(workspaceId)}";
        return new BridgeEndpoint(builder.Uri, payload.BridgeToken.Trim(), workspaceId);
    }

    public override string ToString() => SocketUri.ToString();

    public string AuthorizationHeader => $"Bearer {Token}";
}
