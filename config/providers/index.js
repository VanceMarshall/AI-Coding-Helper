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

function isGpt5Model(model) {
  return typeof model === 'string' && model.toLowerCase().startsWith('gpt-5');
}

function toResponsesInput(systemPrompt, messages) {
  // IMPORTANT:
  // The Responses API accepts either a plain string input OR an array of
  // *message-like objects* with `role` + string `content`.
  //
  // Using typed `content: [{type: "input_text"...}]` is NOT compatible with
  // the message-like input format and will error.
  // Ref: OpenAI "Migrate to the Responses API" guide.
  const input = [];
  if (systemPrompt) input.push({ role: 'system', content: String(systemPrompt) });

  for (const m of (messages || [])) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    input.push({ role, content: String(m.content ?? '') });
  }

  return input;
}

async function* streamOpenAIResponses({ model, apiKey, systemPrompt, messages, maxTokens, reasoningEffort = 'medium' }) {
  if (!apiKey) throw new Error('OpenAI not configured');
  const url = 'https://api.openai.com/v1/responses';

  const body = {
    model,
    input: toResponsesInput(systemPrompt, messages),
    stream: true,
    max_output_tokens: maxTokens,
    reasoning: { effort: reasoningEffort }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI Responses API error ${res.status}: ${errText}`);
  }

  const reader = res.body?.getReader?.();
  if (!reader) throw new Error('OpenAI Responses API streaming not supported in this runtime');

  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let data;
      try { data = JSON.parse(payload); } catch { continue; }

      // Text deltas
      const t = data?.type || '';
      if (t.includes('output_text.delta')) {
        const delta = typeof data.delta === 'string'
          ? data.delta
          : (typeof data?.delta?.text === 'string' ? data.delta.text : null);
        if (delta) yield { type: 'text', text: delta };
      }

      // Usage
      const usage = data?.response?.usage || data?.usage || null;
      if (usage) {
        inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? inputTokens;
        outputTokens = usage.output_tokens ?? usage.completion_tokens ?? outputTokens;
      }
    }
  }

  yield { type: 'done', inputTokens: inputTokens || 0, outputTokens: outputTokens || 0 };
}

export async function* streamCompletion(modelConfig, systemPrompt, messages, maxTokens, options = {}) {
  const { provider, model } = modelConfig;

  if (provider === "openai") {
    if (!openaiClient) throw new Error("OpenAI not configured");

    // Prefer OpenAI Responses API for GPT-5.x models. This enables reasoning effort.
    if (isGpt5Model(model)) {
      try {
        const apiKey = process.env.OPENAI_API_KEY;
        const reasoningEffort = options.reasoningEffort || 'medium';
        for await (const ev of streamOpenAIResponses({ model, apiKey, systemPrompt, messages, maxTokens, reasoningEffort })) {
          yield ev;
        }
        return;
      } catch (e) {
        // Bulletproof fallback: if Responses API streaming fails for any reason,
        // fall back to Chat Completions streaming so the app still works.
        console.warn('[openai] Responses API failed, falling back to chat.completions:', e.message);
      }
    }
    
    const openaiMessages = [
      { role: "system", content: systemPrompt },
      ...(messages || []).map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      }))
    ];

    const stream = await openaiClient.chat.completions.create({
      model,
      messages: openaiMessages,
      // `max_tokens` is deprecated and not supported by newer reasoning models.
      // Use `max_completion_tokens` instead.
      max_completion_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true }
    });

    let inputTokens = 0, outputTokens = 0;
    for await (const chunk of stream) {
      if (chunk.choices?.[0]?.delta?.content) {
        yield { type: "text", text: chunk.choices[0].delta.content };
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
      }
    }
    yield { type: "done", inputTokens, outputTokens };

  } else if (provider === "anthropic") {
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
    
    // Add system prompt as first user message context
    contents.push({
      role: "user",
      parts: [{ text: `System Instructions: ${systemPrompt}\n\nNow, please respond to the conversation below:` }]
    });
    contents.push({
      role: "model", 
      parts: [{ text: "I understand. I'll follow those instructions for our conversation." }]
    });

    // Add conversation messages
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
