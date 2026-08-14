using DapperCode.Core.Services;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.System;

namespace DapperCode.Windows.Services;

/// <summary>Uses WinRT shell APIs for clipboard, log launching, and file revelation.</summary>
public sealed class WindowsSystemActions(IFileSystem fileSystem) : ISystemActions
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
        if (fileSystem.FileExists(path))
        {
            var file = await StorageFile.GetFileFromPathAsync(path).AsTask(cancellationToken);
            if (!await Launcher.LaunchFileAsync(file).AsTask(cancellationToken))
            {
                throw new InvalidOperationException("Windows could not open the broker log.");
            }

            return;
        }

        var parent = fileSystem.GetDirectoryName(path);
        if (parent is null || !fileSystem.DirectoryExists(parent))
        {
            throw new FileNotFoundException("The broker log folder does not exist.", path);
        }

        var folder = await StorageFolder.GetFolderFromPathAsync(parent)
            .AsTask(cancellationToken);
        if (!await Launcher.LaunchFolderAsync(folder).AsTask(cancellationToken))
        {
            throw new InvalidOperationException("Windows could not open the broker log folder.");
        }
    }

    public async Task RevealFileAsync(string path, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new FileNotFoundException("The DapperCode configuration path is unavailable.");
        }

        var parent = fileSystem.GetDirectoryName(path);
        if (parent is null || !fileSystem.DirectoryExists(parent))
        {
            throw new FileNotFoundException("The configuration folder does not exist.", path);
        }

        var file = await StorageFile.GetFileFromPathAsync(path).AsTask(cancellationToken);
        var options = new FolderLauncherOptions();
        options.ItemsToSelect.Add(file);
        if (!await Launcher.LaunchFolderPathAsync(parent, options).AsTask(cancellationToken))
        {
            throw new InvalidOperationException("Windows could not reveal the configuration file.");
        }
    }
}
