namespace DapperCode.Core.Services;

public interface ISystemActions
{
    Task CopyTextAsync(string value, CancellationToken cancellationToken);
    Task OpenLogAsync(string path, CancellationToken cancellationToken);
    Task RevealFileAsync(string path, CancellationToken cancellationToken);
}
