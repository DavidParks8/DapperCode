namespace DapperCode.ProcessFixture;

internal static class Program
{
    public static async Task<int> Main(string[] arguments)
    {
        if (arguments is not ["emit"])
        {
            return 2;
        }

        var output = Task.Run(async () =>
        {
            for (var index = 0; index < 256; index++)
            {
                await Console.Out.WriteLineAsync($"stdout-{index:D3}-{new string('o', 256)}")
                    .ConfigureAwait(false);
            }
        });
        var error = Task.Run(async () =>
        {
            for (var index = 0; index < 256; index++)
            {
                await Console.Error.WriteLineAsync($"stderr-{index:D3}-{new string('e', 256)}")
                    .ConfigureAwait(false);
            }
        });
        await Task.WhenAll(output, error).ConfigureAwait(false);
        return 0;
    }
}
