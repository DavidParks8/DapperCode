using System.Text.Json;
using DapperCode.Core.Models;
using DapperCode.Core.Serialization;

namespace DapperCode.Core.Services;

public sealed record BridgeEndpoint(Uri SocketUri, string Token, string? WorkspaceId)
{
    private static readonly HashSet<string> SupportedTypes =
        ["dappercode-broker-pair", "dappercode-bridge-pair"];

    public static BridgeEndpoint Parse(BridgeObservationTarget target)
    {
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
            !SupportedTypes.Contains(payload.Type) ||
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
        builder.Path = $"/{(basePath.Length == 0 ? string.Empty : $"{basePath}/")}broker/rpc";

        var query = new List<string>
        {
            $"clientType={Uri.EscapeDataString("desktop-monitor")}",
            $"clientName={Uri.EscapeDataString("DapperCode")}",
        };
        var workspaceId = string.IsNullOrWhiteSpace(payload.WorkspaceId)
            ? null
            : payload.WorkspaceId.Trim();
        if (workspaceId is not null)
        {
            query.Add($"workspace={Uri.EscapeDataString(workspaceId)}");
        }

        builder.Query = string.Join("&", query);
        return new BridgeEndpoint(builder.Uri, payload.BridgeToken.Trim(), workspaceId);
    }

    public override string ToString() => SocketUri.ToString();

    public string AuthorizationHeader => $"Bearer {Token}";
}
