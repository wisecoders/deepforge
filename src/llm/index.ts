import type { LlmConfig } from "../types.js";

export interface LlmProvider {
  readonly name: string;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
}

export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export async function createProvider(config: LlmConfig): Promise<LlmProvider> {
  switch (config.provider) {
    case "claude":
      return createClaudeProvider(config);
    case "openai":
      return createOpenAIProvider(config);
    case "azure":
      return createAzureProvider(config);
    case "ollama":
      return createOllamaProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

/**
 * Resolve LLM config from environment variables.
 * Reads LLM_PROVIDER and provider-specific vars from process.env.
 * CLI flags override env vars when both are present.
 */
export function resolveConfigFromEnv(cliOverrides: Partial<LlmConfig> = {}): LlmConfig {
  const provider = (cliOverrides.provider ?? process.env.LLM_PROVIDER ?? "claude") as LlmConfig["provider"];

  const base: LlmConfig = { provider };

  switch (provider) {
    case "claude":
      base.apiKey = process.env.ANTHROPIC_API_KEY;
      base.model = process.env.CLAUDE_MODEL;
      break;
    case "openai":
      base.apiKey = process.env.OPENAI_API_KEY;
      base.model = process.env.OPENAI_MODEL;
      base.baseUrl = process.env.OPENAI_BASE_URL;
      break;
    case "azure":
      base.apiKey = process.env.AZURE_OPENAI_API_KEY;
      base.baseUrl = process.env.AZURE_OPENAI_ENDPOINT;
      base.azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      base.azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
      base.model = process.env.AZURE_OPENAI_MODEL;
      break;
    case "ollama":
      base.baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      base.model = process.env.OLLAMA_MODEL;
      break;
  }

  // CLI overrides take precedence
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(cliOverrides).filter(([, v]) => v !== undefined),
    ),
  } as LlmConfig;
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function createClaudeProvider(config: LlmConfig): Promise<LlmProvider> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.apiKey });
  const model = config.model ?? "claude-sonnet-4-20250514";
  const maxRetries = 5;

  return {
    name: "claude",
    async generate(prompt, options = {}) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await client.messages.create({
            model,
            max_tokens: options.maxTokens ?? config.maxTokensPerPage ?? 4096,
            // Use prompt caching for the system prompt — it's identical across
            // all page generations, saving ~90% input tokens on cache hits
            system: options.systemPrompt
              ? [
                  {
                    type: "text" as const,
                    text: options.systemPrompt,
                    cache_control: { type: "ephemeral" as const },
                  },
                ]
              : [],
            messages: [{ role: "user", content: prompt }],
          });
          const block = response.content[0];
          return block.type === "text" ? block.text : "";
        } catch (err: any) {
          if (err?.status === 429 && attempt < maxRetries) {
            const wait = Math.min(2 ** attempt * 10, 120) * 1000;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw err;
        }
      }
      throw new Error("Claude request failed after retries");
    },
  };
}

async function createOpenAIProvider(config: LlmConfig): Promise<LlmProvider> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  const model = config.model ?? "gpt-4o";
  const maxRetries = 5;

  return {
    name: "openai",
    async generate(prompt, options = {}) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await client.chat.completions.create({
            model,
            max_tokens: options.maxTokens ?? config.maxTokensPerPage ?? 4096,
            messages: [
              ...(options.systemPrompt
                ? [{ role: "system" as const, content: options.systemPrompt }]
                : []),
              { role: "user" as const, content: prompt },
            ],
          });
          return response.choices[0]?.message?.content ?? "";
        } catch (err: any) {
          if (err?.status === 429 && attempt < maxRetries) {
            const wait = Math.min(2 ** attempt * 10, 120) * 1000;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw err;
        }
      }
      throw new Error("OpenAI request failed after retries");
    },
  };
}

async function createAzureProvider(config: LlmConfig): Promise<LlmProvider> {
  const { default: OpenAI } = await import("openai");

  const endpoint = config.baseUrl;
  if (!endpoint) {
    throw new Error(
      "Azure OpenAI requires AZURE_OPENAI_ENDPOINT (e.g. https://myresource.openai.azure.com)",
    );
  }
  const deployment = config.azureDeployment;
  if (!deployment) {
    throw new Error(
      "Azure OpenAI requires AZURE_OPENAI_DEPLOYMENT (e.g. gpt-4o)",
    );
  }

  const apiVersion = config.azureApiVersion ?? "2024-06-01";
  const baseURL = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}`;

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    defaultQuery: { "api-version": apiVersion },
    defaultHeaders: { "api-key": config.apiKey ?? "" },
  });

  const model = config.model ?? deployment;
  const maxRetries = 5;

  return {
    name: "azure",
    async generate(prompt, options = {}) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await client.chat.completions.create({
            model,
            max_tokens: options.maxTokens ?? config.maxTokensPerPage ?? 4096,
            messages: [
              ...(options.systemPrompt
                ? [{ role: "system" as const, content: options.systemPrompt }]
                : []),
              { role: "user" as const, content: prompt },
            ],
          });
          return response.choices[0]?.message?.content ?? "";
        } catch (err: any) {
          if (err?.status === 429 && attempt < maxRetries) {
            const retryAfter = err?.headers?.["retry-after"];
            const wait = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(2 ** attempt * 10, 120) * 1000;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw err;
        }
      }
      throw new Error("Azure OpenAI request failed after retries");
    },
  };
}

async function createOllamaProvider(config: LlmConfig): Promise<LlmProvider> {
  const baseUrl = config.baseUrl ?? "http://localhost:11434";
  const model = config.model ?? "llama3";
  const maxRetries = 3;
  const timeoutMs = 10 * 60 * 1000; // 10 minutes

  return {
    name: "ollama",
    async generate(prompt, options = {}) {
      const body = JSON.stringify({
        model,
        prompt: options.systemPrompt
          ? `${options.systemPrompt}\n\n${prompt}`
          : prompt,
        stream: false,
        options: {
          num_predict: options.maxTokens ?? config.maxTokensPerPage ?? 4096,
        },
      });

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(`${baseUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: controller.signal,
          });
          clearTimeout(timer);
          const data = (await response.json()) as { response: string };
          return data.response;
        } catch (err) {
          if (attempt === maxRetries) throw err;
        }
      }
      throw new Error("Ollama request failed after retries");
    },
  };
}
