/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },
        ink: {
          50: '#f6f7f9',
          100: '#eaecf0',
          200: '#d0d5dd',
          300: '#98a2b3',
          400: '#667085',
          500: '#475467',
          600: '#344054',
          700: '#1d2939',
          800: '#182230',
          900: '#101828',
        },
        critical: {
          100: '#fee4e2',
          500: '#f04438',
          600: '#d92d20',
          700: '#b42318',
        },
        high: {
          100: '#ffead5',
          500: '#f79009',
          700: '#b54708',
        },
        medium: {
          100: '#fef0c7',
          500: '#fdb022',
          700: '#b54708',
        },
        low: {
          100: '#d1fadf',
          500: '#12b76a',
          700: '#027a48',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.05), 0 1px 3px rgba(16,24,40,0.1)',
        pop: '0 4px 12px rgba(16,24,40,0.12)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        ping: {
          '75%, 100%': { transform: 'scale(2)', opacity: '0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'ping-slow': 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite',
      },
    },
  },
  plugins: [],
};