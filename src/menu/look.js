// The menu's look: one palette of roles, two glyph sets, and the mapping
// from span styles (lines.js) to Ink <Text> props.
//
// Colours are the terminal's own ANSI colours, so the menu follows the
// colour scheme (light or dark). NO_COLOR keeps bold, inverse and the like
// and drops every colour.
//
// Glyphs: "rich" for terminals with modern fonts (Windows Terminal, VS
// Code, mintty, macOS and Linux terminals), "plain" for the classic Windows
// console host, whose raster and Consolas fonts lack braille and most
// geometric shapes. PELICAN_GLYPHS=rich|plain overrides the guess.
export const roles = {
  accent: "#8bbebb",
  brand: "#a9d1cd",
  beak: "#d7b58b",
  ok: "#92ae99",
  warn: "#d7b58b",
  err: "#cf8b82",
  info: "#a3b6ca",
  stop: "#bba5c6",
  muted: "#7e858e",
  note: "#9cb8be",
  hot: "#b6afc8",
  divider: "#343a43",
  surface: "#181b20",
  background: "#121519",
  text: "#d6d8dc",
};
const colours = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "grey",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
]);

export const glyphSets = {
  rich: {
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    ticks: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
    bars: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
    shades: ["·", "░", "▒", "▓", "█"],
    full: "━",
    empty: "─",
    dot: "●",
    ring: "○",
    current: "◉",
    diamond: "◆",
    check: "✓",
    pass: "✓",
    cross: "✗",
    square: "■",
    bullet: "•",
    arrow: "›",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    enter: "⏎",
    sep: "·",
    open: "▾",
    closed: "▸",
    bar: "▌",
    events: "≡",
    more: "+",
    less: "-",
    border: "round",
    corners: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  },
  plain: {
    spinner: ["|", "/", "-", "\\"],
    ticks: ["_", ".", ":", "-", "=", "+", "*", "#"],
    bars: ["▄", "█"],
    shades: ["·", "░", "▒", "▓", "█"],
    full: "█",
    empty: "░",
    dot: "*",
    ring: "o",
    current: "@",
    diamond: "?",
    check: "+",
    // A command that passed: "+" would read as an added line beside "+3 -2".
    pass: "ok",
    cross: "x",
    square: "-",
    bullet: "*",
    arrow: ">",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    enter: "Enter",
    sep: "·",
    open: "v",
    closed: ">",
    bar: "|",
    events: "=",
    more: "+",
    less: "-",
    border: "single",
    corners: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  },
};

export function pickGlyphs(env = process.env, platform = process.platform) {
  const forced = String(env.PELICAN_GLYPHS ?? "").toLowerCase();
  if (forced === "rich" || forced === "plain") return forced;
  if (platform !== "win32") return "rich";
  if (
    env.WT_SESSION ||
    env.TERM_PROGRAM ||
    env.ConEmuANSI === "ON" ||
    /xterm|mintty|alacritty|wezterm|kitty/i.test(env.TERM ?? "")
  )
    return "rich";
  return "plain";
}

// Span style words -> Ink <Text> props.
function textProps(style, color) {
  const props = {};
  let tone = null,
    dim = false;
  for (const word of String(style ?? "").split(" ")) {
    if (!word) continue;
    if (word === "bold") props.bold = true;
    else if (word === "italic") props.italic = true;
    else if (word === "underline") props.underline = true;
    else if (word === "inverse") props.inverse = true;
    else if (word === "label") {
      if (color) props.backgroundColor = "#20292c";
      else props.italic = true;
      tone = roles.muted;
    } else if (word === "strike") props.strikethrough = true;
    else if (word === "dim") dim = true;
    else if (word === "selected") {
      if (color) {
        props.color = "#d0e3e1";
        props.backgroundColor = "#293738";
      } else props.inverse = true;
      props.bold = true;
      tone = "selected";
    } else if (word.startsWith("on-") && word.slice(3) in roles) {
      // A toast: dark text on the role's colour, inverse without colours.
      if (color) {
        props.backgroundColor = roles[word.slice(3)];
        props.color = word === "on-err" ? "whiteBright" : "black";
      } else props.inverse = true;
      tone = "selected";
    } else if (word in roles) tone = tone === "selected" ? tone : roles[word];
    else if (colours.has(word) || /^#[0-9a-f]{6}$/i.test(word))
      tone = tone === "selected" ? tone : word;
  }
  if (color && tone && tone !== "selected") props.color = tone;
  if (dim && tone !== "selected") {
    if (color && !props.color) props.color = roles.muted;
    else if (!props.backgroundColor) props.dimColor = true;
  }
  return props;
}

export function makeTheme({ color = true, glyphs = "rich" } = {}) {
  const g = glyphSets[glyphs] ?? glyphSets.rich;
  const cache = new Map();
  return {
    color,
    glyphs,
    g,
    // Ink props of a span style, cached: views ask for the same few.
    props(style = "") {
      let p = cache.get(style);
      if (!p) cache.set(style, (p = textProps(style, color)));
      return p;
    },
    // A border's colour, or none without colours.
    tone: (role) => (color ? (roles[role] ?? role) : undefined),
  };
}

// How each agent and run status looks: a style, an icon (running ones spin)
// and a short word. Working is cyan, asking yellow, done green, failed red;
// queued and stopped are dim.
export const statusStyle = (status) =>
  ({
    running: "accent",
    starting: "accent",
    waiting: "warn bold",
    stopping: "warn",
    queued: "muted",
    completed: "ok",
    replayed: "ok",
    done: "ok",
    failed: "err",
    blocked: "err",
    cancelled: "muted",
    interrupted: "muted",
    stopped: "muted",
  })[status] ?? "";
export function statusIcon(status, g, questions = 0) {
  if (questions || status === "waiting") return [g.diamond, "warn bold"];
  switch (status) {
    case "running":
    case "starting":
      return [g.spinner[0], "accent spin"];
    case "stopping":
      return [g.square, "warn"];
    case "queued":
      return [g.ring, "muted"];
    case "completed":
    case "replayed":
    case "done":
      return [g.check, "ok"];
    case "failed":
    case "blocked":
      return [g.cross, "err"];
    case "cancelled":
    case "interrupted":
    case "stopped":
      return [g.square, "muted"];
    default:
      return [g.ring, "muted"];
  }
}
const words = {
  running: "working",
  starting: "starting",
  waiting: "asking",
  stopping: "stopping",
  queued: "queued",
  completed: "done",
  replayed: "replayed",
  done: "done",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
  interrupted: "stopped",
  stopped: "stopped",
};
export const statusWord = (status, questions = 0) =>
  questions ? "asking" : (words[status] ?? String(status ?? ""));
