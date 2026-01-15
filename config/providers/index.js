// filepath: config/providers/index.js
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

let openaiClient = null;
let anthropicClient = null;
let googleApiKey = null;

const providerStatus = {
  openai: false,
  anthropic: false,
  google: false,
  github: false
};

export function initializeProviders(keys = {}) {
  const openaiKey = keys.openai || process.env.OPENAI_API_KEY;
  const anthropicKey = keys.anthropic || process.env.ANTHROPIC_API_KEY;
  const googleKey = keys.google || process.env.GOOGLE_API_KEY;
  const githubKey = keys.github || process.env.GITHUB_TOKEN;

  if (openaiKey) {
    try {
      openaiClient = new OpenAI({ apiKey: openaiKey });
      providerStatus.openai = true;
    } catch (e) {
      console.warn("Failed to initialize OpenAI:", e.message);
      providerStatus.openai = false;
    }
  } else {
    openaiClient = null;
    providerStatus.openai = false;
  }

  if (anthropicKey) {
    try {
      anthropicClient = new Anthropic({ apiKey: anthropicKey });
      providerStatus.anthropic = true;
    } catch (e) {
      console.warn("Failed to initialize Anthropic:", e.message);
      providerStatus.anthropic = false;
    }
  } else {
    anthropicClient = null;
    providerStatus.anthropic = false;
  }

  if (googleKey) {
    googleApiKey = googleKey;
    providerStatus.google = true;
  } else {
    googleApiKey = null;
    providerStatus.google = false;
  }

  providerStatus.github = !!githubKey;

  return { ...providerStatus };
}

export function reloadProviders(keys) {
  return initializeProviders(keys);
}

export function isProviderAvailable(provider) {
  return providerStatus[provider] || false;
}

export function getProviderStatus() {
  return { ...providerStatus };
}

export async function* streamCompletion(modelConfig, systemPrompt, messages, maxTokens) {
  const { provider, model } = modelConfig;

  if (provider === "openai") {
    if (!openaiClient) throw new Error("OpenAI not configured");

    const inputMessages = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    }));

    // Prefer the Responses API when available (newer OpenAI models)
    if (openaiClient.responses?.create) {
      try {
        const stream = await openaiClient.responses.create({
          model,
          ...(systemPrompt ? { instructions: systemPrompt } : {}),
          input: inputMessages,
          stream: true,
          ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
        });

        let inputTokens = 0;
        let outputTokens = 0;
        let finishReason = 'stop';

        for await (const event of stream) {
          if (event?.type === 'response.output_text.delta') {
            if (event.delta) yield { type: 'text', text: event.delta };
          } else if (event?.type === 'response.completed') {
            const usage = event.response?.usage;
            if (usage) {
              inputTokens = usage.input_tokens ?? inputTokens;
              outputTokens = usage.output_tokens ?? outputTokens;
            }
            finishReason = event.response?.status ?? finishReason;
          } else if (event?.type === 'response.failed') {
            const msg = event.response?.error?.message || 'OpenAI response failed';
            throw new Error(msg);
          } else if (event?.type === 'error') {
            const msg = event.error?.message || 'OpenAI streaming error';
            throw new Error(msg);
          }
        }

        yield { type: 'done', inputTokens, outputTokens, finishReason };
        return;
      } catch (err) {
        console.warn('[openai] Responses API failed, falling back to chat.completions:', err?.message || err);
      }
    }

    // Fallback: Chat Completions streaming
    // Optimization: Only add system prompt if one is explicitly passed.
    // This allows us to handle caching by putting system messages inside the 'messages' array.
    const openaiMessages = systemPrompt 
      ? [{ role: 'system', content: systemPrompt }, ...inputMessages]
      : inputMessages;

    const isGpt5 = typeof model === 'string' && (model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3'));
    const stream = await openaiClient.chat.completions.create({
      model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(isGpt5
        ? (maxTokens ? { max_completion_tokens: maxTokens } : {})
        : (maxTokens ? { max_tokens: maxTokens } : {})),
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { type: 'text', text: delta };

      const usage = chunk.usage;
      if (usage) {
        inputTokens = usage.prompt_tokens ?? inputTokens;
        outputTokens = usage.completion_tokens ?? outputTokens;
      }

      const reason = chunk.choices?.[0]?.finish_reason;
      if (reason) finishReason = reason;
    }

    yield { type: 'done', inputTokens, outputTokens, finishReason };
    return;
  }

  if (provider === "anthropic") {
    if (!anthropicClient) throw new Error("Anthropic not configured");

    const anthropicMessages = messages.map(m => ({ role: m.role, content: m.content }));

    const stream = await anthropicClient.messages.stream({
      model,
      system: systemPrompt,
      messages: anthropicMessages,
      max_tokens: maxTokens
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.text) {
        yield { type: "text", text: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      type: "done",
      inputTokens: finalMessage.usage?.input_tokens || 0,
      outputTokens: finalMessage.usage?.output_tokens || 0
    };

  } else if (provider === "google") {
    if (!googleApiKey) throw new Error("Google not configured");

    const contents = [];
    contents.push({
      role: "user",
      parts: [{ text: `System Instructions: ${systemPrompt}\n\nNow, please respond to the conversation below:` }]
    });
    contents.push({
      role: "model", 
      parts: [{ text: "I understand. I'll follow those instructions for our conversation." }]
    });

    for (const m of messages) {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${googleApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: { maxOutputTokens: maxTokens }
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error: ${error}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalInputTokens = 0, totalOutputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            yield { type: "text", text: data.candidates[0].content.parts[0].text };
          }
          if (data.usageMetadata) {
            totalInputTokens = data.usageMetadata.promptTokenCount || 0;
            totalOutputTokens = data.usageMetadata.candidatesTokenCount || 0;
          }
        } catch (e) {}
      }
    }

    yield { type: "done", inputTokens: totalInputTokens, outputTokens: totalOutputTokens };

  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }
}

export function calculateCost(modelConfig, inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * modelConfig.inputCost;
  const outputCost = (outputTokens / 1_000_000) * modelConfig.outputCost;
  return inputCost + outputCost;
}
