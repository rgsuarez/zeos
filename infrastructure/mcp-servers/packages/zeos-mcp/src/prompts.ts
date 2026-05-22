import { Prompt } from '@modelcontextprotocol/sdk/types.js';

export const ZEOS_PROMPTS: Prompt[] = [
  {
    name: 'zeos_boot',
    description: 'Boot zeos with the standard protocol',
    arguments: [
      {
        name: 'profile',
        description: 'Profile to load',
        required: false
      }
    ]
  },
  {
    name: 'zeos_handoff',
    description: 'Generate a handoff summary for the next session',
    arguments: []
  }
];
