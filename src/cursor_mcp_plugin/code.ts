// Figma plugin API types
declare const figma: {
  variables: {
    getLocalVariables(): Promise<VariableDefinition[]>;
  };
};

interface VariableDefinition {
  id: string;
  name: string;
  resolvedType: string;
  valuesByMode: {
    [key: string]: any;
  };
}

// Design token types
interface DesignToken {
  id: string;
  name: string;
  type: string;
  value: string;
}

interface DesignTokenResponse {
  success: boolean;
  tokens?: DesignToken[];
  error?: string;
}

async function fetchDesignTokens(): Promise<DesignTokenResponse> {
  try {
    // Get all local variables
    const collections = await figma.variables.getLocalVariables();
    
    // Transform variables into design tokens
    const tokens = collections.map((variable: VariableDefinition) => {
      const valuesByMode = variable.valuesByMode;
      const modeId = Object.keys(valuesByMode)[0]; // Get first mode's value
      const value = valuesByMode[modeId];
      
      return {
        id: variable.id,
        name: variable.name,
        type: variable.resolvedType,
        value: typeof value === 'object' ? JSON.stringify(value) : String(value)
      };
    });
    
    return {
      success: true,
      tokens
    };
  } catch (error: unknown) {
    console.error('Error getting design tokens:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Immediately fetch design tokens on startup
(async () => {
  const tokens = await fetchDesignTokens();
  console.log("⚡️ [code.js] Design Tokens:", tokens);
})();

// Command handler types
interface CommandResponse {
  success: boolean;
  result?: any;
  error?: string;
}

// Update command handler
async function handleCommand(command: string, params: any = {}): Promise<CommandResponse> {
  console.log('Handling command:', command, params);
  
  try {
    switch (command) {
      // ... existing cases ...
      
      case 'getDesignTokens':
        return await fetchDesignTokens();
      
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error: unknown) {
    console.error('Error handling command:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
} 