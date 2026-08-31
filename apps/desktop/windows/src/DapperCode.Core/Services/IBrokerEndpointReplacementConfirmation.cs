using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public interface IBrokerEndpointReplacementConfirmation
{
    Task<bool> ConfirmReplacementAsync(
        BrokerEndpointConfiguration current,
        BrokerEndpointConfiguration replacement,
        CancellationToken cancellationToken);
}
