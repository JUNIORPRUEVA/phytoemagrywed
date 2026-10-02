import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    globals: false,
    restoreMocks: true,
  },
  // En tests el entorno inyectado es determinista (vacío): no depende de `.env`.
  define: {
    __PHYTO_ENV__: '{}',
  },
});
