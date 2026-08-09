using System.Diagnostics;
using DapperCode.Core.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.Windows.Storage.Pickers;
using Windows.ApplicationModel;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.System;

namespace DapperCode.Windows.Services;

internal sealed class WindowsFilePickerService(Func<AppWindow> appWindow) : IFilePickerService
{
    public async Task<string?> PickWorkspaceAsync(
        string currentPath,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var picker = new FolderPicker(appWindow().Id)
        {
            CommitButtonText = "Choose workspace",
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            ViewMode = PickerViewMode.List,
        };
        var result = await picker.PickSingleFolderAsync();
        cancellationToken.ThrowIfCancellationRequested();
        return result?.Path;
    }

    public async Task<string?> PickExecutableAsync(
        string? currentPath,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var picker = new FileOpenPicker(appWindow().Id)
        {
            CommitButtonText = "Choose agent",
            SuggestedStartLocation = PickerLocationId.ComputerFolder,
            ViewMode = PickerViewMode.List,
        };
        picker.FileTypeFilter.Add(".exe");
        var result = await picker.PickSingleFileAsync();
        cancellationToken.ThrowIfCancellationRequested();
        return result?.Path;
    }
}
