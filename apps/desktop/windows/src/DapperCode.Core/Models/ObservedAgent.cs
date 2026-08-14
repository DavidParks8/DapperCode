using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

public sealed record ObservedAgent
{
    [JsonPropertyName("lifecycle")]
    public string Lifecycle { get; init; } = string.Empty;
}
