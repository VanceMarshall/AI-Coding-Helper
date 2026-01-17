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

    // Standard Chat Completions (Optimized for Prompt Caching)
    // If systemPrompt is provided, prepend it. If null, we assume the caller
    // already placed system instructions inside 'messages' for cache-ordering.
    const openaiMessages = systemPrompt 
      ? [{ role: 'system', content: systemPrompt }, ...inputMessages]
      : inputMessages;

    // Detect newer reasoning or high-context models (o1, o3, gpt-4o)
    const isNewModel = typeof model === 'string' && 
      (model.includes('gpt-4o') || model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3'));
    
    const stream = await openaiClient.chat.completions.create({
      model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(isNewModel
        ? (maxTokens ? { max_completion_tokens: maxTokens } : {})
        : (maxTokens ? { max_tokens: maxTokens } : {})),
    });

    let inputTokens = 0, outputTokens = 0, finishReason = 'stop';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { type: 'text', text: delta };
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }
    yield { type: 'done', inputTokens, outputTokens, finishReason };

  } else if (provider === "anthropic") {
    if (!anthropicClient) throw new Error("Anthropic not configured");
    const stream = await anthropicClient.messages.stream({
      model,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens || 4096
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.text) {
        yield { type: "text", text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield { type: "done", inputTokens: final.usage?.input_tokens || 0, outputTokens: final.usage?.output_tokens || 0 };

  } else if (provider === "google") {
    if (!googleApiKey) throw new Error("Google not configured");

    const contents = [];
    const instructionsText = systemPrompt ? `System Instructions: ${systemPrompt}\n\n` : "";
    
    // Google wrap
    contents.push({
      role: "user",
      parts: [{ text: `${instructionsText}Please respond to the following conversation:` }]
    });
    contents.push({
      role: "model", 
      parts: [{ text: "I understand. I'll follow those instructions." }]
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
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } })
      }
    );

    if (!response.ok) throw new Error(`Google API: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", inputT = 0, outputT = 0;

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
            inputT = data.usageMetadata.promptTokenCount || inputT;
            outputT = data.usageMetadata.candidatesTokenCount || outputT;
          }
        } catch (e) {}
      }
    }
    yield { type: "done", inputTokens: inputT, outputTokens: outputT };
  }
}

export function calculateCost(modelConfig, inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * (modelConfig.inputCost || 0);
  const outputCost = (outputTokens / 1_000_000) * (modelConfig.outputCost || 0);
  return inputCost + outputCost;
}
