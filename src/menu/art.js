import { s } from "./lines.js";

// Pelicans: a head for the header (mark), and for the overview a bust or,
// in a big window, the whole bird beside the PELICAN wordmark. Each art is
// its lines plus the parts to paint: [row, from column, role] paints the
// rest of that row from there; an "o" on the eye row is the eye and "~" is
// the wing.
const arts = {
  tiny: {
    eye: 0,
    lines: ["(o)____", "| \\___/"],
    paint: [
      [0, 3, "beak"],
      [1, 2, "pouch"],
    ],
  },
  bust: {
    eye: 1,
    lines: [
      "    .--.",
      "   / o  `.________",
      "  |   ,----------->",
      "   \\  \\_________/",
      "    |  |",
    ],
    paint: [
      [1, 10, "beak"],
      [2, 6, "beak"],
      [3, 6, "pouch"],
    ],
  },
  full: {
    eye: 1,
    lines: [
      "       .--.",
      "      / o  `.______________",
      "     |   ,------------------>",
      "      \\  \\________________/",
      "       |  |",
      "       |  |",
      "   _.-'    `-.",
      "  <__  .~~~~. `.",
      "     \\ ( ~~~~ ) |",
      "      \\ `~~~~' /",
      "       `-.__.-'",
      "         |  |",
      "       __|__|__",
      "      |________|",
    ],
    paint: [
      [1, 12, "beak"],
      [2, 9, "beak"],
      [3, 9, "pouch"],
      [11, 0, "legs"],
      [12, 0, "legs"],
      [13, 0, "post"],
    ],
  },
};
const roleStyle = {
  body: "bold",
  eye: "accent bold",
  beak: "beak bold",
  pouch: "beak",
  wing: "muted",
  legs: "beak",
  post: "muted",
};

// The header's mark, one row: a pelican's head and its long beak.
export const mark = () => [
  s("(", "bold"),
  s("o", "accent bold"),
  s(")", "bold"),
  s("__", "beak bold"),
];

export const artSize = (name) => ({
  rows: arts[name].lines.length,
  cols: Math.max(...arts[name].lines.map((l) => l.length)),
});

// The art as span lines, each `cols` wide (padded), painted by part.
export function pelican(name, { cols } = {}) {
  const art = arts[name];
  const width = cols ?? artSize(name).cols;
  return art.lines.map((text, row) => {
    const padded = text.padEnd(width);
    const spans = [];
    let run = "",
      runRole = null;
    [...padded].forEach((ch, col) => {
      let role = "body";
      for (const [r, from, part] of art.paint)
        if (r === row && col >= from) role = part;
      if (ch === "o" && row === art.eye) role = "eye";
      if (ch === "~") role = "wing";
      if (ch === " ") role = runRole ?? "body";
      if (role !== runRole && run) {
        spans.push(s(run, roleStyle[runRole]));
        run = "";
      }
      runRole = role;
      run += ch;
    });
    if (run) spans.push(s(run, roleStyle[runRole]));
    return spans;
  });
}

// One restrained ASCII wordmark on the rail, splash and connection screens.
const letters = [
  [" ___ ", "| _ \\", "|  _/", "|_|  "],
  [" ___ ", "| __|", "| _| ", "|___|"],
  [" _    ", "| |   ", "| |__ ", "|____|"],
  [" ___ ", "|_ _|", " | | ", "|___|"],
  [" ___ ", "/ __|", "| (__", "\\___|"],
  ["   _   ", "  /_\\  ", " / _ \\ ", "/_/ \\_\\"],
  [" _  _ ", "| \\| |", "| .` |", "|_|\\_|"],
];
// Keep every letter in its own fixed-width cell across all four rows.
export const logo = Array.from({ length: 4 }, (_, row) =>
  letters
    .map((letter) =>
      letter[row].padEnd(Math.max(...letter.map((line) => line.length))),
    )
    .join(""),
);
export const wordmarkWidth = Math.max(...logo.map((line) => line.length));
export const wordmark = () => logo.map((line) => [s(line, "brand bold")]);
export const splashArt = wordmark;
export const relayArt = pelican("bust");
export const motto = [
  "Codex agents for any orchestrator.",
  "Queued, watched, on the record.",
];
export const slogan = "Briefs out. Results back.";
export const captionLines = (indent = "") => [
  [s(indent + slogan, "accent bold")],
  ...motto.map((line) => [s(indent + line, "muted")]),
];
export const branding = (indent = "") => [
  ...wordmark().map((line) => [s(indent), ...line]),
  [],
  ...captionLines(indent),
];
