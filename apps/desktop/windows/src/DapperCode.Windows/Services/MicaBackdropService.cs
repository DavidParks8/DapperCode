using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI.ViewManagement;

namespace DapperCode.Windows.Services;

internal sealed class MicaBackdropService : IDisposable
{
    private readonly Window _window;
    private readonly Grid _root;
    private readonly AccessibilitySettings _accessibility = new();
    private readonly MicaBackdrop _mica = new() { Kind = MicaKind.Base };
    private bool _disposed;

    public MicaBackdropService(Window window, Grid root)
    {
        _window = window;
        _root = root;
        _accessibility.HighContrastChanged += OnHighContrastChanged;
        Apply();
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _accessibility.HighContrastChanged -= OnHighContrastChanged;
        _window.SystemBackdrop = null;
    }

    private void OnHighContrastChanged(AccessibilitySettings sender, object arguments)
    {
        _ = _root.DispatcherQueue.TryEnqueue(Apply);
    }

    private void Apply()
    {
        if (_accessibility.HighContrast)
        {
            _window.SystemBackdrop = null;
            _root.Background =
                Application.Current.Resources["ApplicationPageBackgroundThemeBrush"] as Brush;
            return;
        }

        _root.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        _window.SystemBackdrop = _mica;
    }
}
