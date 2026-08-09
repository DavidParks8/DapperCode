using System.Text.Json.Serialization;
using DapperCode.Core.Models;
using DapperCode.Core.Services;

namespace DapperCode.Core.Serialization;

[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = false)]
[JsonSerializable(typeof(PairingPayload))]
[JsonSerializable(typeof(OperatorFailure))]
[JsonSerializable(typeof(OperatorEnvelope<BridgeSnapshot>))]
[JsonSerializable(typeof(OperatorEnvelope<List<BridgeSnapshot>>))]
[JsonSerializable(typeof(OperatorEnvelope<SetupResult>))]
[JsonSerializable(typeof(OperatorEnvelope<AgentDiscovery>))]
[JsonSerializable(typeof(NetworkMode))]
[JsonSerializable(typeof(BrokerHealthRequest))]
[JsonSerializable(typeof(BridgeObservedHealth))]
internal sealed partial class DapperCodeJsonContext : JsonSerializerContext;
