import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// Provider adapters - each knows how to talk to its API
const adapters = {
  openai: null,
  anthropic: null,
  google: null
};

// Initialize providers based on available API keys
export function initializeProviders() {
  const status = {
    openai: false,
    anthropic: false,
    google: false
  };

  if (process.env.OPENAI_API_KEY) {
    adapters.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    status.openai = true;
    console.log("✓ OpenAI provider initialized");
  }

  if (process.env.ANTHROPIC_API_KEY) {
    adapters.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    status.anthropic = true;
    console.log("✓ Anthropic provider initialized");
  }

  if (process.env.GOOGLE_API_KEY) {
    status.google = true;
    console.log("✓ Google provider initialized");
  }

  return status;
}

// Check if a provider is available
export function isProviderAvailable(provider) {
  switch (provider) {
    case "openai":
      return !!adapters.openai;
    case "anthropic":
      return !!adapters.anthropic;
    case "google":
      return !!process.env.GOOGLE_API_KEY;
    default:
      return false;
  }
}

// Streaming generator for OpenAI
async function* streamOpenAI(model, systemPrompt, messages, maxTokens) {
  if (!adapters.openai) throw new Error("OpenAI not configured");

  const stream = await adapters.openai.chat.completions.create({
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content
      }))
    ]
  });

  let fullText = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || "";
    if (delta) {
      fullText += delta;
      yield { type: "text", text: delta };
    }
  }

  // Estimate tokens (OpenAI streaming doesn't give exact counts)
  const inputTokens = Math.ceil((systemPrompt.length + messages.map(m => m.content).join("").length) / 4);
  const outputTokens = Math.ceil(fullText.length / 4);

  yield {
    type: "done",
    model,
    provider: "openai",
    inputTokens,
    outputTokens,
    fullText
  };
}

// Streaming generator for Anthropic
async function* streamAnthropic(model, systemPrompt, messages, maxTokens) {
  if (!adapters.anthropic) throw new Error("Anthropic not configured");

  const stream = await adapters.anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: messages.map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content
    }))
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let fullText = "";

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      fullText += event.delta.text;
      yield { type: "text", text: event.delta.text };
    }
    if (event.type === "message_delta" && event.usage) {
      outputTokens = event.usage.output_tokens;
    }
    if (event.type === "message_start" && event.message?.usage) {
      inputTokens = event.message.usage.input_tokens;
    }
  }

  yield {
    type: "done",
    model,
    provider: "anthropic",
    inputTokens,
    outputTokens,
    fullText
  };
}

// Streaming generator for Google
async function* streamGoogle(model, systemPrompt, messages, maxTokens) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Google API key not configured");

  // Build the request for Gemini API
  const contents = [];
  
  // Add conversation history
  for (const msg of messages) {
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }]
    });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          maxOutputTokens: maxTokens
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google API error: ${response.status} - ${error}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    
    // Parse streaming JSON responses
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim() || line.startsWith("[") || line.startsWith("]") || line === ",") continue;
      
      try {
        // Remove leading comma if present
        const jsonStr = line.startsWith(",") ? line.slice(1) : line;
        const data = JSON.parse(jsonStr);
        
        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
          const text = data.candidates[0].content.parts[0].text;
          fullText += text;
          yield { type: "text", text };
        }
      } catch (e) {
        // Incomplete JSON, will be handled in next iteration
      }
    }
  }

  // Estimate tokens
  const inputTokens = Math.ceil((systemPrompt.length + messages.map(m => m.content).join("").length) / 4);
  const outputTokens = Math.ceil(fullText.length / 4);

  yield {
    type: "done",
    model,
    provider: "google",
    inputTokens,
    outputTokens,
    fullText
  };
}

// Main streaming function - routes to the right provider
export async function* streamCompletion(config, systemPrompt, messages, maxTokens = 4096) {
  const { provider, model } = config;

  switch (provider) {
    case "openai":
      yield* streamOpenAI(model, systemPrompt, messages, maxTokens);
      break;
    case "anthropic":
      yield* streamAnthropic(model, systemPrompt, messages, maxTokens);
      break;
    case "google":
      yield* streamGoogle(model, systemPrompt, messages, maxTokens);
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Non-streaming completion for simple use cases
export async function complete(config, systemPrompt, messages, maxTokens = 4096) {
  let fullText = "";
  let metadata = {};

  for await (const chunk of streamCompletion(config, systemPrompt, messages, maxTokens)) {
    if (chunk.type === "text") {
      fullText += chunk.text;
    } else if (chunk.type === "done") {
      metadata = chunk;
    }
  }

  return { text: fullText, ...metadata };
}

// Calculate cost based on token usage
export function calculateCost(modelConfig, inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * modelConfig.inputCost;
  const outputCost = (outputTokens / 1_000_000) * modelConfig.outputCost;
  return inputCost + outputCost;
}
