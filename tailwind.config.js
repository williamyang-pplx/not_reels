/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx}', './client/**/*.ts'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(0 0% 4%)',
        foreground: 'hsl(0 0% 98%)',
        card: 'hsl(0 0% 7%)',
        'card-foreground': 'hsl(0 0% 98%)',
        muted: 'hsl(0 0% 15%)',
        'muted-foreground': 'hsl(0 0% 64%)',
        border: 'hsl(0 0% 18%)',
        primary: 'hsl(210 90% 56%)',
        'primary-foreground': 'hsl(0 0% 100%)',
        accent: 'hsl(210 30% 20%)',
        destructive: 'hsl(0 70% 50%)',
      },
      fontFamily: {
        rambla: ['Rambla', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  corePlugins: { preflight: true },
  plugins: [],
};
