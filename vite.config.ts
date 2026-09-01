import { defineConfig } from 'vite'

export default defineConfig({
  base: '/safe-batch-sender/',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
  },
})
