namespace DapperCode.Core.Services;

public sealed class PhysicalFileSystem : IFileSystem
{
    public bool FileExists(string path) => File.Exists(path);
    public bool DirectoryExists(string path) => Directory.Exists(path);
    public string? GetDirectoryName(string path) => Path.GetDirectoryName(path);
}
