import { createContext, useContext } from "react";
import { makeTheme } from "./look.js";

// The menu's look (look.js: palette, glyphs, status marks) plus the React
// context that hands it to the components. Code that does not draw the menu,
// such as the command line, imports look.js, so it never loads React.
export * from "./look.js";
export const ThemeContext = createContext(makeTheme());
export const useTheme = () => useContext(ThemeContext);
