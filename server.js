// NOTE: This file is NOT the primary server.
// The application server lives in ./config/server.js
// We keep this wrapper only for backwards compatibility.
//
// Prefer:
//   npm start
//   node config/server.js
//
// If you are seeing this message in logs, something (Dockerfile/Start Command) is still pointing at root server.js.
console.warn("[ai-coding-helper] WARNING: Starting from root server.js. Prefer 'node config/server.js'. Redirecting...");

import "./config/server.js";
