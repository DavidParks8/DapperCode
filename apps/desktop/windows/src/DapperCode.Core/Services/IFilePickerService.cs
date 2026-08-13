namespace DapperCode.Core.Services;

public interface IFilePickerService
{
    Task<string?> PickWorkspaceAsync(CancellationToken cancellationToken);
    Task<string?> PickExecutableAsync(CancellationToken cancellationToken);
}
