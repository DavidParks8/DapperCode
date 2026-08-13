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

public sealed class WindowsSystemActions : ISystemActions
{
    public Task CopyTextAsync(string value, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var package = new DataPackage();
        package.SetText(value);
        Clipboard.SetContent(package);
        Clipboard.Flush();
        return Task.CompletedTask;
    }

    public async Task OpenLogAsync(string path, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (File.Exists(path))
        {
            var file = await StorageFile.GetFileFromPathAsync(path);
            if (!await Launcher.LaunchFileAsync(file))
            {
                throw new InvalidOperationException("Windows could not open the broker log.");
            }

            return;
        }

        var parent = Path.GetDirectoryName(path);
        if (parent is null || !Directory.Exists(parent))
        {
            throw new FileNotFoundException("The broker log folder does not exist.", path);
        }

        var folder = await StorageFolder.GetFolderFromPathAsync(parent);
        if (!await Launcher.LaunchFolderAsync(folder))
        {
            throw new InvalidOperationException("Windows could not open the broker log folder.");
        }
    }

    public Task RevealFileAsync(string path, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new FileNotFoundException("The DapperCode configuration path is unavailable.");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "explorer.exe",
            UseShellExecute = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("/select,");
        startInfo.ArgumentList.Add(path);
        _ = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Windows could not open File Explorer.");
        return Task.CompletedTask;
    }
}
