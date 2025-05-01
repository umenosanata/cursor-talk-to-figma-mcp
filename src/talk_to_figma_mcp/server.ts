#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define FigmaCommand type
type FigmaCommand = "join" | "designTokens" | "getDesignTokens";

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Add TypeScript interfaces for component overrides
interface ComponentOverride {
  id: string;
  overriddenFields: string[];
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

// Add design token interface
interface DesignToken {
  id: string;
  name: string;
  type: string;
  value: string;
}

// Add global context for LLM and design tokens
interface LLMContext {
  tokens?: DesignToken[];
}

// Global variables for design tokens
let designTokens: DesignToken[] = [];
const llmContext: LLMContext = {
  tokens: undefined
};

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number; // Add timestamp for last activity
}>();

// Track which channel each client is in
let currentChannel: string | null = null;

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0",
});

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find(arg => arg.startsWith('--server='));
const serverUrl = serverArg ? serverArg.split('=')[1] : 'localhost';
const WS_URL = serverUrl === 'localhost' ? `ws://${serverUrl}` : `wss://${serverUrl}`;

// Single handleMessage implementation
function handleMessage(ws: WebSocket, data: any) {
  try {
    logger.debug(`Received message: ${JSON.stringify(data)}`);

    // Handle join message
    if (data.type === "join" || (data.type === "message" && data.message?.command === "join")) {
      const channelName = data.channel;
      if (!channelName || typeof channelName !== "string") {
        logger.error("Channel name is required");
        return;
      }

      currentChannel = channelName;
      logger.info(`Joined channel: ${channelName}`);

      // Send success response
      ws.send(JSON.stringify({
        type: "system",
        message: {
          id: data.id || data.message?.id,
          result: "Connected to channel: " + channelName,
        },
        channel: channelName
      }));
      return;
    }

    // Handle designTokens command
    if (data.type === "message" && data.message?.command === "designTokens" && data.message.params?.tokens) {
      designTokens = data.message.params.tokens;
      logger.info(`Received ${designTokens.length} design tokens`);
      llmContext.tokens = designTokens;
      
      // Resolve any pending requests for this command
      const requestId = data.message.id;
      if (requestId && pendingRequests.has(requestId)) {
        const request = pendingRequests.get(requestId)!;
        request.resolve(designTokens);
        clearTimeout(request.timeout);
        pendingRequests.delete(requestId);
      }
      return;
    }

    // Handle progress updates
    if (data.type === "progress_update" && data.message?.data) {
      const progressData = data.message.data as CommandProgressUpdate;
      const requestId = data.id || "";

      if (requestId && pendingRequests.has(requestId)) {
        const request = pendingRequests.get(requestId)!;
        request.lastActivity = Date.now();

        // Reset timeout
        clearTimeout(request.timeout);
        request.timeout = setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            logger.error(`Request ${requestId} timed out after extended period of inactivity`);
            pendingRequests.delete(requestId);
            request.reject(new Error("Request to Figma timed out"));
          }
        }, 60000);

        logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
      }
      return;
    }

    // Handle regular commands
    if (data.message?.command) {
      const { command, params = {}, id } = data.message;
      
      // Process command
      if (pendingRequests.has(id)) {
        const request = pendingRequests.get(id)!;
        if (data.message.error) {
          request.reject(new Error(data.message.error));
        } else {
          request.resolve(data.message.result);
        }
        clearTimeout(request.timeout);
        pendingRequests.delete(id);
      }
    }
  } catch (error) {
    logger.error(`Error handling message: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Get Variables Tool - consolidated implementation
server.tool(
  "get_variables",
  "Get all variables from the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("getDesignTokens");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting variables: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Function to connect to Figma
function connectToFigma(port: number = 3055) {
  if (ws) {
    ws.close();
  }

  const wsUrl = `ws://localhost:${port}`;
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logger.info(`Connected to Figma plugin on port ${port}`);
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const parsedData = JSON.parse(data.toString());
      handleMessage(ws!, parsedData);
    } catch (error) {
      logger.error(`Error parsing WebSocket message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on("close", () => {
    logger.info("Disconnected from Figma plugin");
    ws = null;
  });

  ws.on("error", (error) => {
    logger.error(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`);
    ws = null;
  });
}

// Function to join a channel
async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Function to send commands to Figma
function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`);
        reject(new Error('Request to Figma timed out'));
      }
    }, timeoutMs);

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now()
    });

    // Send the request
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('FigmaMCP server running on stdio');
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}); 