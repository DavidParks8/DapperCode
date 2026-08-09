using System.Text.Json.Serialization;

namespace DapperCode.Core.Models;

public sealed record SetupOptions(
    string Workspace,
    NetworkMode NetworkMode,
    string Host,
    ushort? BridgePort,
    string AgentId,
    string DisplayName,
    string AgentExecutable,
    string AgentArguments,
    bool ReplaceBrokerEndpoint = false);
