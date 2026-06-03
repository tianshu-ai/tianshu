// Tailwind v4 ships its PostCSS plugin as a separate package.
export default {
  plugins: {
    "@tailwindcss/postcss": { config: "./tailwind.config.js" },
    autoprefixer: {},
  },
};
