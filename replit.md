# AI Code Helper

## Overview
A web application that helps developers brainstorm ideas, plan code changes, edit files, and debug errors using OpenAI's API and GitHub integration.

## Recent Changes
- **December 13, 2025**: 
  - Fixed Generate Plan JSON parsing - AI responses wrapped in markdown code blocks now parse correctly
  - Added extractJson() helper function that handles code fences, raw JSON, and embedded JSON objects
  - Added full GitHub repo context to all AI features - AI can now see all files in the selected repository
  - AI detects tech stack automatically and references actual file structure in responses
  - Added model fallback logic - tries GPT-5.2 first, falls back to GPT-4.1 if unavailable

- **December 12, 2025**: 
  - Upgraded to GPT-5.2 models (GPT-5.2 Instant for Standard, GPT-5.2 Thinking for Deep dive)
  - GPT-5.2 is OpenAI's most capable model - matches human experts on 70% of professional tasks
  - Best for complex coding, planning, and reasoning tasks

- **December 07, 2025**: 
  - Removed "Show pinned only" checkbox feature
  - Added "None (new idea)" as default option in project dropdown for brainstorming without project context
  - Fixed JavaScript errors and verified brainstorm flow works end-to-end

- **December 04, 2025**: 
  - Initial project setup with Node.js 20
  - Created Express server with OpenAI and GitHub API integration
  - Built mobile-friendly UI with emoji icons, toast notifications, and keyboard shortcuts

## Project Structure
- `server.js` - Express server with API endpoints for brainstorming, planning, and GitHub integration (includes model fallback logic)
- `public/index.html` - Single-page application with all UI components
- `pinnedProjects.json` - Configuration for pinned GitHub repositories
- `package.json` - Project dependencies (express, openai)
- `data/` - JSON storage for saved ideas and tasks

## Features
- **Brainstorm**: Ask questions about code architecture, get ideas for new features
- **Plan**: Create detailed implementation plans for code changes
- **Edit**: Generate code edits for specific files
- **Debug**: Get help fixing errors in your code
- **GitHub Integration**: Connect to your repositories for context-aware assistance

## Environment Variables
- `OPENAI_API_KEY` - Required for AI functionality
- `GITHUB_TOKEN` - Required for GitHub repository access

## Getting Started
The app runs on port 5000. Select a project from the dropdown or use "None (new idea)" to brainstorm without project context.
