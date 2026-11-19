/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sec: {
          base: '#000000',
          elevated: '#0A0A0A',
          card: '#0F0F0F',
          hover: '#141414',
          border: '#1F1F1F',
          accent: '#C0C0C0',
          'accent-bright': '#D4D4D4',
          text: '#F5F5F5',
          muted: '#B8B8B8',
          dim: '#6B6B6B',
          gold: '#C9A962',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      backgroundImage: {
        'sec-silver':
          'linear-gradient(135deg, #A8A8A8 0%, #D8D8D8 40%, #A0A0A0 70%, #C8C8C8 100%)',
        'sec-vignette':
          'radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.92) 100%)',
      },
      letterSpacing: {
        tagline: '0.14em',
      },
    },
  },
  plugins: [],
}
