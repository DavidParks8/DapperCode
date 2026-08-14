namespace DapperCode.Core.ViewModels;

public sealed class MessageEventArgs : EventArgs
{
    public MessageEventArgs(string message)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(message);
        Message = message;
    }

    public string Message { get; }
}
