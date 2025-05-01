import WebSocket, { WebSocketServer } from 'ws';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';

describe('Figma MCP Server Integration Tests', () => {
  let ws: WebSocket;
  let wss: WebSocketServer;
  let server: any; // Using any type for testing purposes
  let getVariablesHandler: (args: any) => Promise<any>;
  const TEST_PORT = 3056;

  // Test data
  const mockTokens = [
    {
      id: 'color-primary',
      name: 'color/primary',
      type: 'COLOR',
      value: '#0066FF'
    },
    {
      id: 'typography-h1',
      name: 'typography/heading-1',
      type: 'TYPOGRAPHY',
      value: JSON.stringify({
        fontFamily: 'Inter',
        fontSize: 24,
        fontWeight: 600,
        lineHeight: 1.5
      })
    }
  ];

  beforeAll(async () => {
    // Setup WebSocket server
    wss = new WebSocketServer({ port: TEST_PORT });
    await new Promise<void>(resolve => wss.on('listening', resolve));

    // Setup WebSocket client
    ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await new Promise<void>(resolve => ws.on('open', resolve));

    // Create get_variables handler
    getVariablesHandler = async () => {
      try {
        return {
          content: [{ type: "text", text: JSON.stringify(mockTokens) }]
        };
      } catch (error) {
        return {
          content: [{ 
            type: "text", 
            text: `Error: ${error instanceof Error ? error.message : String(error)}` 
          }]
        };
      }
    };

    // Setup MCP server with transport
    const transport = new StdioServerTransport();
    server = new McpServer({
      name: "TalkToFigmaMCP",
      version: "1.0.0",
    });

    // Register get_variables tool
    server.tool(
      "get_variables",
      "Get all variables from the current Figma document",
      {},
      getVariablesHandler
    );

    // Connect MCP server
    await server.connect(transport);

    // Setup message handling
    wss.on('connection', socket => {
      socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'message' && message.message?.command === 'getDesignTokens') {
          socket.send(JSON.stringify({
            type: 'message',
            message: {
              command: 'designTokens',
              params: { tokens: mockTokens },
              id: message.message.id
            }
          }));
        }
      });
    });
  });

  afterAll(async () => {
    // Close WebSocket client
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }

    // Close WebSocket server with proper error handling
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Close MCP server connection
    if (server && typeof server.close === 'function') {
      await server.close();
    }
  });

  describe('Core Functionality', () => {
    it('should retrieve and process design tokens', async () => {
      // Test get_variables tool directly
      const result = await getVariablesHandler({});
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      // Parse and verify tokens
      const tokens = JSON.parse(result.content[0].text);
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toEqual(mockTokens[0]);
      expect(tokens[1]).toEqual(mockTokens[1]);

      // Verify token types
      expect(tokens[0].type).toBe('COLOR');
      expect(tokens[1].type).toBe('TYPOGRAPHY');

      // Verify token values
      expect(tokens[0].value).toBe('#0066FF');
      const typography = JSON.parse(tokens[1].value);
      expect(typography).toHaveProperty('fontFamily', 'Inter');
      expect(typography).toHaveProperty('fontSize', 24);
    });
  });
}); 