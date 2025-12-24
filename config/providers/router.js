// Smart router that decides which model to use based on message content

export function routeMessage(message, config, hasFiles = false) {
  const routing = config.routing;
  const models = config.models;
  
  // If files are attached and threshold says so, use full model
  if (hasFiles && routing.thresholds.fileAttachmentTriggersFull) {
    return {
      modelKey: "full",
      model: models.full,
      reason: "Files attached - using full model"
    };
  }

  const messageLower = message.toLowerCase().trim();
  const wordCount = message.split(/\s+/).length;

  // Check for explicit full-model patterns first (they take priority)
  for (const pattern of routing.fullPatterns) {
    if (messageLower.includes(pattern.toLowerCase())) {
      return {
        modelKey: "full",
        model: models.full,
        reason: `Detected coding/building intent: "${pattern}"`
      };
    }
  }

  // Check for fast-model patterns (simple questions)
  for (const pattern of routing.fastPatterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(messageLower)) {
      // But if it's a long message, still use full
      if (wordCount > routing.thresholds.longMessageWords) {
        return {
          modelKey: "full",
          model: models.full,
          reason: "Long message - using full model despite question format"
        };
      }
      return {
        modelKey: "fast",
        model: models.fast,
        reason: `Simple question detected: "${pattern}"`
      };
    }
  }

  // Check message length
  if (wordCount <= routing.thresholds.shortMessageWords) {
    return {
      modelKey: "fast",
      model: models.fast,
      reason: `Short message (${wordCount} words)`
    };
  }

  if (wordCount >= routing.thresholds.longMessageWords) {
    return {
      modelKey: "full",
      model: models.full,
      reason: `Long message (${wordCount} words)`
    };
  }

  // Default to full for medium-length messages (safer for coding)
  return {
    modelKey: "full",
    model: models.full,
    reason: "Default to full model for medium-length messages"
  };
}

// Preview which model would be used (for UI indicator)
export function previewRoute(message, config, hasFiles = false) {
  const result = routeMessage(message, config, hasFiles);
  return {
    modelKey: result.modelKey,
    displayName: result.model.displayName,
    reason: result.reason
  };
}
