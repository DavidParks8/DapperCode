namespace DapperCode.Core.Services;

/// <summary>
/// Abstracts filesystem queries used by application services so policy and lifecycle logic remain
/// deterministic under test.
/// </summary>
public interface IFileSystem
{
    /// <summary>Returns whether a regular file exists at <paramref name="path"/>.</summary>
    bool FileExists(string path);

    /// <summary>Returns whether a directory exists at <paramref name="path"/>.</summary>
    bool DirectoryExists(string path);

    /// <summary>Returns the parent directory component of <paramref name="path"/>.</summary>
    string? GetDirectoryName(string path);
}
