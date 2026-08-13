using DapperCode.Core.Services;
using Microsoft.UI.Windowing;
using Microsoft.Windows.Storage.Pickers;

namespace DapperCode.Windows.Services;

public sealed class WindowsFilePickerService(Func<AppWindow> appWindow) : IFilePickerService
{
    public async Task<string?> PickWorkspaceAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var picker = new FolderPicker(appWindow().Id)
        {
            CommitButtonText = "Choose workspace",
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            ViewMode = PickerViewMode.List,
        };
        var result = await picker.PickSingleFolderAsync().AsTask(cancellationToken);
        return result?.Path;
    }

    public async Task<string?> PickExecutableAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var picker = new FileOpenPicker(appWindow().Id)
        {
            CommitButtonText = "Choose agent",
            SuggestedStartLocation = PickerLocationId.ComputerFolder,
            ViewMode = PickerViewMode.List,
        };
        picker.FileTypeFilter.Add(".exe");
        var result = await picker.PickSingleFileAsync().AsTask(cancellationToken);
        return result?.Path;
    }
}
