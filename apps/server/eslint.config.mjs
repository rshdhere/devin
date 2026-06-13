import base from "@devin/eslint-config/base";

export default [
  ...base,
  {
    languageOptions: {
      globals: {
        Bun: "readonly",
      },
    },
  },
];
