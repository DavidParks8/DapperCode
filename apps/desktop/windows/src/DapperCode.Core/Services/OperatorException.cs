namespace DapperCode.Core.Services;

public sealed class OperatorException : Exception
{
    public OperatorException()
    {
    }

    public OperatorException(string message)
        : base(message)
    {
    }

    public OperatorException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public static OperatorException Unavailable(string path) =>
        new($"The bundled DapperCode operator is unavailable at '{path}'. Reinstall the app.");
}
