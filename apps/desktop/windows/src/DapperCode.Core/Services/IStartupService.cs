namespace DapperCode.Core.Services;

public interface IStartupService
{
    Task<StartupStatus> GetStatusAsync(CancellationToken cancellationToken);
    Task<StartupStatus> SetEnabledAsync(bool enabled, CancellationToken cancellationToken);
}
