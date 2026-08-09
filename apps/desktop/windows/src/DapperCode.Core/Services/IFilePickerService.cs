using DapperCode.Core.Models;

namespace DapperCode.Core.Services;

public interface IFilePickerService
{
    Task<string?> PickWorkspaceAsync(string currentPath, CancellationToken cancellationToken);
    Task<string?> PickExecutableAsync(string? currentPath, CancellationToken cancellationToken);
}
