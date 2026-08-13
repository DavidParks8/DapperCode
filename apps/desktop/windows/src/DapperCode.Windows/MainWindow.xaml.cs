using System.Collections.Specialized;
using System.ComponentModel;
using System.Runtime.InteropServices;
using DapperCode.Core.Models;
using DapperCode.Core.ViewModels;
using DapperCode.Windows.Services;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.ApplicationModel;
using Windows.Graphics;
using Windows.Storage;
using Windows.Storage.Streams;
using Windows.System;
using WinRT.Interop;

namespace DapperCode.Windows;

public sealed partial class MainWindow : Window
{
    private readonly MicaBackdropService? _backdrop;
    private readonly SemaphoreSlim _dialogGate = new(1, 1);
    private readonly TaskCompletionSource _contentLoaded =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _allowClose;
    private bool _contentReady;
    private bool _isVisible;
    private bool _updatingStartupToggle;
    private string? _pendingError;
    private int _qrVersion;

    public MainWindow(MainViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();

        Title = "DapperCode";
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        CenterWindow();

        try
        {
            _backdrop = new MicaBackdropService(this, RootGrid);
        }
        catch (Exception error) when (
            error is COMException or InvalidOperationException)
        {
            RootGrid.Background =
                Application.Current.Resources["ApplicationPageBackgroundThemeBrush"] as Brush;
        }
        AppWindow.Closing += OnWindowClosing;
        RootGrid.Loaded += OnContentLoaded;
        ViewModel.PropertyChanged += OnViewModelPropertyChanged;
        ViewModel.Bridges.CollectionChanged += OnBridgesChanged;
        ViewModel.ErrorOccurred += OnErrorOccurred;
        ViewModel.NoticeOccurred += OnNoticeOccurred;
        AddKeyboardAccelerators();
        UpdateVisualState();
    }

    public MainViewModel ViewModel { get; }
    public bool IsVisible => _isVisible;

    public void ShowManagementWindow()
    {
        AppWindow.Show();
        Activate();
        _isVisible = true;
        _ = NativeMethods.SetForegroundWindow(WindowNative.GetWindowHandle(this));
        _ = ViewModel.RefreshIfStaleAsync();
        if (_pendingError is not null && _contentReady)
        {
            var error = _pendingError;
            _pendingError = null;
            _ = ShowMessageAsync("DapperCode", error);
        }
    }

    public void HideManagementWindow()
    {
        AppWindow.Hide();
        _isVisible = false;
    }

    public void PrepareForShutdown()
    {
        _allowClose = true;
        ViewModel.PropertyChanged -= OnViewModelPropertyChanged;
        ViewModel.Bridges.CollectionChanged -= OnBridgesChanged;
        ViewModel.ErrorOccurred -= OnErrorOccurred;
        ViewModel.NoticeOccurred -= OnNoticeOccurred;
        AppWindow.Closing -= OnWindowClosing;
        _backdrop?.Dispose();
    }

    public void ReportFatalError(string message) =>
        OnErrorOccurred(this, new MessageEventArgs(message));

    public async Task ShowFatalErrorAsync(string message)
    {
        ShowManagementWindow();
        await _contentLoaded.Task;
        await ShowMessageAsync("DapperCode couldn’t start", message);
    }

    public async Task ShowAboutAsync()
    {
        ShowManagementWindow();
        var version = Package.Current.Id.Version;
        var content = new StackPanel { Spacing = 10 };
        content.Children.Add(new TextBlock
        {
            Text = $"Version {version.Major}.{version.Minor}.{version.Build}.{version.Revision}",
            FontWeight = FontWeights.SemiBold,
        });
        content.Children.Add(new TextBlock
        {
            Text = "A native control surface for the authenticated DapperCode broker.",
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 420,
        });
        content.Children.Add(new TextBlock
        {
            Text = "DapperCode is private-network software. Keep authentication enabled and do not expose the broker directly to the public internet.",
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 420,
        });

        await _dialogGate.WaitAsync();
        try
        {
            var dialog = new ContentDialog
            {
                XamlRoot = RootGrid.XamlRoot,
                Title = "About DapperCode",
                Content = content,
                PrimaryButtonText = "Open source notices",
                CloseButtonText = "Close",
                DefaultButton = ContentDialogButton.Close,
            };
            if (await dialog.ShowAsync() == ContentDialogResult.Primary)
            {
                var path = Path.Combine(
                    AppContext.BaseDirectory,
                    "Licenses",
                    "THIRD_PARTY_NOTICES.txt");
                var file = await StorageFile.GetFileFromPathAsync(path);
                _ = await Launcher.LaunchFileAsync(file);
            }
        }
        finally
        {
            _dialogGate.Release();
        }
    }

    private void CenterWindow()
    {
        var displayArea = DisplayArea.GetFromWindowId(
            AppWindow.Id,
            DisplayAreaFallback.Nearest);
        var workArea = displayArea.WorkArea;
        var width = Math.Min(820, Math.Max(640, workArea.Width - 80));
        var height = Math.Min(840, Math.Max(640, workArea.Height - 80));
        var x = workArea.X + (workArea.Width - width) / 2;
        var y = workArea.Y + (workArea.Height - height) / 2;
        AppWindow.MoveAndResize(new RectInt32(x, y, width, height));
    }

    private void AddKeyboardAccelerators()
    {
        var refresh = new KeyboardAccelerator
        {
            Key = VirtualKey.R,
            Modifiers = VirtualKeyModifiers.Control,
        };
        refresh.Invoked += (_, arguments) =>
        {
            if (ViewModel.RefreshCommand.CanExecute(null))
            {
                ViewModel.RefreshCommand.Execute(null);
            }

            arguments.Handled = true;
        };
        RootGrid.KeyboardAccelerators.Add(refresh);

        var escape = new KeyboardAccelerator { Key = VirtualKey.Escape };
        escape.Invoked += (_, arguments) =>
        {
            HideManagementWindow();
            arguments.Handled = true;
        };
        RootGrid.KeyboardAccelerators.Add(escape);
    }

    private void OnContentLoaded(object sender, RoutedEventArgs arguments)
    {
        _contentReady = true;
        _contentLoaded.TrySetResult();
        _ = UpdateQrImageAsync();
        if (_pendingError is not null && _isVisible)
        {
            var error = _pendingError;
            _pendingError = null;
            _ = ShowMessageAsync("DapperCode", error);
        }
    }

    private void OnWindowClosing(AppWindow sender, AppWindowClosingEventArgs arguments)
    {
        if (_allowClose)
        {
            return;
        }

        arguments.Cancel = true;
        HideManagementWindow();
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs arguments)
    {
        UpdateVisualState();
        if (arguments.PropertyName is nameof(MainViewModel.PairingQrPng) or
            nameof(MainViewModel.Snapshot))
        {
            _ = UpdateQrImageAsync();
        }
    }

    private void OnBridgesChanged(object? sender, NotifyCollectionChangedEventArgs arguments) =>
        UpdateVisualState();

    private void UpdateVisualState()
    {
        if (SetupPanel is null)
        {
            return;
        }

        SetupPanel.Visibility = ViewModel.IsConfigured
            ? Visibility.Collapsed
            : Visibility.Visible;
        DashboardPanel.Visibility = ViewModel.IsConfigured
            ? Visibility.Visible
            : Visibility.Collapsed;
        PairingSection.Visibility = ViewModel.HasPairingData
            ? Visibility.Visible
            : Visibility.Collapsed;
        WorkspacesSection.Visibility = ViewModel.Bridges.Count > 1
            ? Visibility.Visible
            : Visibility.Collapsed;
        BusyProgress.Visibility = ViewModel.IsBusy
            ? Visibility.Visible
            : Visibility.Collapsed;
        SurfaceScroller.IsEnabled = !ViewModel.IsBusy;
        StartupMessageText.Visibility = string.IsNullOrWhiteSpace(ViewModel.StartupMessage)
            ? Visibility.Collapsed
            : Visibility.Visible;

        _updatingStartupToggle = true;
        LaunchAtLoginToggle.IsOn = ViewModel.LaunchAtLogin;
        _updatingStartupToggle = false;

        var glyph = ViewModel.Snapshot.State switch
        {
            "running" => "\uE73E",
            "degraded" or "unhealthy" or "inaccessible" or "error" => "\uE7BA",
            _ => "\uE769",
        };
        TitleStatusIcon.Glyph = glyph;
        DashboardStatusIcon.Glyph = glyph;
    }

    private async Task UpdateQrImageAsync()
    {
        if (!_contentReady)
        {
            return;
        }

        var version = Interlocked.Increment(ref _qrVersion);
        var bytes = ViewModel.PairingQrPng;
        if (bytes.IsEmpty)
        {
            PairingQrImage.Source = null;
            return;
        }

        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream))
        {
            writer.WriteBytes(bytes.ToArray());
            _ = await writer.StoreAsync();
            _ = writer.DetachStream();
        }

        stream.Seek(0);
        var image = new BitmapImage();
        await image.SetSourceAsync(stream);
        if (version == Volatile.Read(ref _qrVersion))
        {
            PairingQrImage.Source = image;
        }
    }

    private void OnErrorOccurred(object? sender, MessageEventArgs arguments)
    {
        if (!_isVisible || !_contentReady)
        {
            _pendingError = arguments.Message;
            return;
        }

        _ = ShowMessageAsync("DapperCode couldn’t complete the action", arguments.Message);
    }

    private void OnNoticeOccurred(object? sender, MessageEventArgs arguments)
    {
        NoticeBar.Message = arguments.Message;
        NoticeBar.IsOpen = true;
    }

    private async Task ShowMessageAsync(string title, string message)
    {
        await _dialogGate.WaitAsync();
        try
        {
            var dialog = new ContentDialog
            {
                XamlRoot = RootGrid.XamlRoot,
                Title = title,
                Content = new TextBlock
                {
                    Text = message,
                    TextWrapping = TextWrapping.Wrap,
                    MaxWidth = 460,
                },
                CloseButtonText = "OK",
                DefaultButton = ContentDialogButton.Close,
            };
            _ = await dialog.ShowAsync();
        }
        finally
        {
            _dialogGate.Release();
        }
    }

    private async void LaunchAtLoginToggle_Toggled(
        object sender,
        RoutedEventArgs arguments)
    {
        if (_updatingStartupToggle || !_contentReady)
        {
            return;
        }

        await ViewModel.SetLaunchAtLoginAsync(LaunchAtLoginToggle.IsOn);
    }

    private void WorkspaceLogButton_Click(object sender, RoutedEventArgs arguments)
    {
        if (sender is Button { Tag: BridgeSnapshot bridge })
        {
            _ = ViewModel.OpenLogsAsync(bridge);
        }
    }
}
