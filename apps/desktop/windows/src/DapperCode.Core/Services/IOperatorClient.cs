using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public interface IOperatorClient
{
    Task<BridgeSnapshot> GetStatusAsync(string workspace, CancellationToken cancellationToken);
    Task<IReadOnlyList<BridgeSnapshot>> ListAsync(CancellationToken cancellationToken);
    Task<BridgeSnapshot> StartAsync(string workspace, CancellationToken cancellationToken);
    Task<BridgeSnapshot> StopAsync(string workspace, CancellationToken cancellationToken);
    Task<BridgeSnapshot> RestartAsync(string workspace, CancellationToken cancellationToken);
    Task<SetupResult> SetupAsync(SetupOptions options, CancellationToken cancellationToken);
    Task<AgentDiscovery> DiscoverAgentAsync(string agentId, CancellationToken cancellationToken);
    Task<bool> StopAllForShutdownAsync(TimeSpan timeout);
}
