using System;
using System.Collections.Generic;

namespace MyApp.Services
{
    public interface IService : IDisposable
    {
        void Execute();
        Task<int> RunAsync(string input);
    }

    /// <summary>Base service class.</summary>
    public abstract class BaseService : IService
    {
        public string Name { get; set; }
        private readonly ILogger _logger;

        protected BaseService(ILogger logger)
        {
            _logger = logger;
        }

        public abstract void Execute();

        public virtual async Task<int> RunAsync(string input)
        {
            _logger.Log(input);
            return 0;
        }

        public void Dispose() { }
    }

    public class ConcreteService : BaseService
    {
        public ConcreteService(ILogger logger) : base(logger) { }

        public override void Execute()
        {
            var helper = new Helper();
            helper.DoWork();
        }
    }

    public enum LogLevel { Debug, Info, Warn, Error }

    public static class Constants
    {
        public const int MaxRetries = 3;
    }
}
