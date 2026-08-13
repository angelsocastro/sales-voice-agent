import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000, // conversaciones multi-turno con varias llamadas al LLM/judge
  },
})
