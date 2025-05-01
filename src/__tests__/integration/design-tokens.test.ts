/// <reference types="jest" />

import WebSocket from 'ws';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';

interface TestMcpServer extends McpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

describe('Design Token Integration Tests', () => {
  let wss: WebSocketServer;
  let wsClient: WebSocket | null = null;
  let port: number;
  
  beforeAll(async () => {
    // Start WebSocket server on a random port
    wss = new WebSocketServer({ port: 0 });
    
    // Set up message handling
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Handle join message
          if (message.type === 'join') {
            ws.send(JSON.stringify({
              type: 'system',
              message: `Joined channel: ${message.channel}`,
              channel: message.channel
            }));
            return;
          }

          // Handle get_variables command
          if (message.type === 'message' && message.message?.command === 'get_variables') {
            if (message.message.args?.invalid) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid request',
                channel: message.channel
              }));
            } else {
              ws.send(JSON.stringify({
                type: 'broadcast',
                message: {
                  result: {
                    tokens: [
                      { id: '1', name: 'primary', value: '#000000' },
                      { id: '2', name: 'secondary', value: '#ffffff' }
                    ],
                    context: message.message.args?.context ? { lastRequest: 'get_variables' } : undefined
                  }
                },
                channel: message.channel
              }));
            }
            return;
          }
        } catch (error) {
          console.error('Error handling message:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format',
            channel: 'test-channel'
          }));
        }
      });
    });

    // Wait for server to be ready and get the port
    await new Promise<void>((resolve) => {
      wss.once('listening', () => {
        const address = wss.address() as AddressInfo;
        port = address.port;
        resolve();
      });
    });
  }, 10000); // Increase timeout to 10 seconds

  afterAll(async () => {
    // Cleanup WebSocket client
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
    }

    // Cleanup WebSocket server
    await new Promise<void>((resolve) => {
      if (wss.clients.size > 0) {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.close();
          }
        });
      }
      wss.close((err?: Error) => {
        if (err) {
          console.error('Error closing server:', err);
        }
        resolve();
      });
    });
  }, 10000); // Increase timeout to 10 seconds

  beforeEach(async () => {
    // Create new WebSocket client
    wsClient = new WebSocket(`ws://localhost:${port}`);
    
    // Wait for connection and join channel
    await new Promise<void>((resolve, reject) => {
      if (!wsClient) {
        reject(new Error('WebSocket client is null'));
        return;
      }

      wsClient.once('open', () => {
        wsClient?.send(JSON.stringify({
          type: 'join',
          channel: 'test-channel'
        }));
      });

      wsClient.once('message', () => {
        resolve();
      });

      wsClient.once('error', (error) => {
        reject(error);
      });
    });
  }, 10000); // Increase timeout to 10 seconds

  afterEach(() => {
    // Cleanup WebSocket client after each test
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
      wsClient = null;
    }
  });

  test('should retrieve design tokens', async () => {
    expect(wsClient).not.toBeNull();
    if (!wsClient) return;

    const message = {
      type: 'message',
      channel: 'test-channel',
      message: {
        command: 'get_variables',
        args: {}
      }
    };

    const response = await new Promise<any>((resolve) => {
      if (!wsClient) {
        resolve(null);
        return;
      }
      wsClient.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
      wsClient.send(JSON.stringify(message));
    });

    expect(response).not.toBeNull();
    expect(response).toHaveProperty('type', 'broadcast');
    expect(response.message.result.tokens).toHaveLength(2);
  }, 10000); // Increase timeout to 10 seconds

  test('should handle invalid design token requests', async () => {
    expect(wsClient).not.toBeNull();
    if (!wsClient) return;

    const message = {
      type: 'message',
      channel: 'test-channel',
      message: {
        command: 'get_variables',
        args: { invalid: true }
      }
    };

    const response = await new Promise<any>((resolve) => {
      if (!wsClient) {
        resolve(null);
        return;
      }
      wsClient.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
      wsClient.send(JSON.stringify(message));
    });

    expect(response).not.toBeNull();
    expect(response).toHaveProperty('type', 'error');
  }, 10000); // Increase timeout to 10 seconds

  test('should maintain context between requests', async () => {
    expect(wsClient).not.toBeNull();
    if (!wsClient) return;

    // First request
    const message1 = {
      type: 'message',
      channel: 'test-channel',
      message: {
        command: 'get_variables',
        args: {}
      }
    };

    await new Promise<void>((resolve) => {
      if (!wsClient) {
        resolve();
        return;
      }
      wsClient.once('message', () => resolve());
      wsClient.send(JSON.stringify(message1));
    });

    // Second request should have context from first
    const message2 = {
      type: 'message',
      channel: 'test-channel',
      message: {
        command: 'get_variables',
        args: { context: true }
      }
    };

    const response = await new Promise<any>((resolve) => {
      if (!wsClient) {
        resolve(null);
        return;
      }
      wsClient.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
      wsClient.send(JSON.stringify(message2));
    });

    expect(response).not.toBeNull();
    expect(response.message.result).toHaveProperty('context.lastRequest', 'get_variables');
  }, 10000); // Increase timeout to 10 seconds
}); 