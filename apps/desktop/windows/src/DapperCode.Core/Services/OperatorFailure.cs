using System.Text.Json.Serialization;

namespace DapperCode.Core.Services;

internal sealed record OperatorFailure
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("error")]
    public string Error { get; init; } = string.Empty;
}
