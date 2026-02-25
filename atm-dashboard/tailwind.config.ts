import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: {
          850: '#1a1d23',
          950: '#0d0f12',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
