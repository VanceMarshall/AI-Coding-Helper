// Smart message routing based on complexity and keywords

export function routeMessage(message, config, hasFiles = false) {
  const msg = message.toLowerCase();
  const routing = config.routing || {};
  const keywords = routing.keywords || {};
  
  // Check for "full" model keywords (complex tasks)
  const fullKeywords = keywords.full || ["build", "create", "implement", "debug", "refactor", "architect", "design", "complex", "analyze", "explain in detail"];
  for (const keyword of fullKeywords) {
    if (msg.includes(keyword)) {
      return {
        modelKey: "full",
        model: config.models.full,
        reason: `Keyword: "${keyword}"`
      };
    }
  }
  
  // Check for "fast" model keywords (simple tasks)
  const fastKeywords = keywords.fast || ["quick", "simple", "brief", "short", "summarize", "list", "what is", "define"];
  for (const keyword of fastKeywords) {
    if (msg.includes(keyword)) {
      return {
        modelKey: "fast",
        model: config.models.fast,
        reason: `Keyword: "${keyword}"`
      };
    }
  }
  
  // Default based on whether files are loaded
  const defaults = routing.defaults || { withFiles: "full", withoutFiles: "fast" };
  
  if (hasFiles) {
    return {
      modelKey: defaults.withFiles || "full",
      model: config.models[defaults.withFiles] || config.models.full,
      reason: "Default: has files loaded"
    };
  }
  
  return {
    modelKey: defaults.withoutFiles || "fast",
    model: config.models[defaults.withoutFiles] || config.models.fast,
    reason: "Default: no files"
  };
}

export function previewRoute(message, config, hasFiles = false) {
  const result = routeMessage(message, config, hasFiles);
  return {
    modelKey: result.modelKey,
    modelName: result.model?.displayName || result.modelKey,
    reason: result.reason
  };
}
