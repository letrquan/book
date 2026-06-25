import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

function browserError(toolName: string): Promise<ToolResult> {
  return Promise.resolve({
    toolCallId: '',
    success: false,
    output: '',
    error: `Browser tool "${toolName}" requires Chrome. Install Chrome and set CHROME_PATH, or enable headless mode in .bookrc.json`,
  });
}

export const browserTools: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the browser',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
    execute: () => browserError('browser_navigate'),
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the element to click' },
      },
      required: ['selector'],
    },
    execute: () => browserError('browser_click'),
  },
  {
    name: 'browser_type',
    description: 'Type text into an input element',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the input element' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
    execute: () => browserError('browser_type'),
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'File path to save the screenshot' },
      },
      required: ['filePath'],
    },
    execute: () => browserError('browser_screenshot'),
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the browser context',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute' },
      },
      required: ['script'],
    },
    execute: () => browserError('browser_evaluate'),
  },
];
