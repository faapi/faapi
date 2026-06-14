import type { FaapiConfig } from '@faapi/faapi';

export default {
  plugins: [
    ['@faapi/next', { dir: '.' }],
  ],
} satisfies FaapiConfig;
