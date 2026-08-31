using System.Text.Json.Serialization;

namespace DapperCode.Core.Services;

internal sealed record OperatorEnvelope<T>
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("result")]
    public T? Result { get; init; }
}
