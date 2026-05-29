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
    case "ollama":
      return createOllamaProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

async function createClaudeProvider(config: LlmConfig): Promise<LlmProvider> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.apiKey });
  const model = config.model ?? "claude-sonnet-4-20250514";

  return {
    name: "claude",
    async generate(prompt, options = {}) {
      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? config.maxTokensPerPage ?? 4096,
        system: options.systemPrompt ?? "",
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content[0];
      return block.type === "text" ? block.text : "";
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

  return {
    name: "openai",
    async generate(prompt, options = {}) {
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
