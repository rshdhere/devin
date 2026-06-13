import {
  ThemeProviderProps,
  ThemeProvider as NextThemesProvider,
} from "next-themes";

export const ThemeProvider = ({ children, ...props }: ThemeProviderProps) => {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
};
