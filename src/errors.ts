/**
 * Deepforge error hierarchy.
 */

export class DeepforgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepforgeError";
  }
}

export class ExtractionError extends DeepforgeError {
  constructor(
    message: string,
    public readonly filePath?: string,
    public readonly line?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

export class ResolutionError extends DeepforgeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResolutionError";
  }
}

export class StoreError extends DeepforgeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreError";
  }
}

export class GenerationError extends DeepforgeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationError";
  }
}

export class ConfigError extends DeepforgeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}
